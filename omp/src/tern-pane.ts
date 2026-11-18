import { isUnattended, sessionIdOf } from './host-context'
import type { OmpContext } from './host-context'
import type { SessionCalls } from './host-sessions'
import type { Run } from '../../hooks/gh'
import type { ReplyHost } from './tern-replies'
import type { OmpState } from './state'
import { decisionView, sendReplies } from './tern-replies'
import type { TernPalette, WatchTheme } from './tern-theme'
import { serveDecisions } from './tern-server'

type TernContext = OmpContext & { mode: string; ui: { notify(message: string, type: 'warning'): void } }

export function ternTarget(env: NodeJS.ProcessEnv) {
  const id = env.TERN_PANE
  if (
    !env.TERN_PANE_SOCKET ||
    !id ||
    !/^\d+$/.test(id) ||
    !Number.isSafeInteger(Number(id)) ||
    env.OMP_INBOX_TERN === 'off'
  )
    return null
  return { owner: Number(id), auto: env.OMP_INBOX_TERN !== 'manual' }
}

/** The view and its write capability belong to the omp session that opened them. */
export function ternPane(
  target: NonNullable<ReturnType<typeof ternTarget>>,
  run: Run,
  cwd: string,
  host: ReplyHost,
  notify: (message: string) => void,
  watchTheme?: WatchTheme,
) {
  let page: ReturnType<typeof serveDecisions> | undefined
  let opening: Promise<void> | undefined
  const lifetime = new AbortController()
  let stopped = false
  let tried = false
  let focusRequested = false
  let latest: OmpState | undefined

  let theme: TernPalette | undefined
  let subscription: Awaited<ReturnType<WatchTheme>> | undefined
  let observing: Promise<void> | undefined
  function observe() {
    if (!watchTheme || observing) return
    observing = watchTheme(
      next => {
        if (stopped) return
        theme = next
        page?.update()
      },
      run,
      cwd,
    )
      .then(sub => {
        if (stopped) sub.stop()
        else subscription = sub
      })
      .catch(() => {})
  }
  async function focusBlock(id: number) {
    if (stopped) throw new Error('This omp session has ended.')
    const result = await run(['tern', 'focus', String(id)], { cwd, timeoutMs: 5000 })
    if (result.code !== 0) throw new Error('Tern could not switch panes.')
  }

  async function browser(op: Record<string, unknown>) {
    const response = await run(['tern', 'browser', JSON.stringify(op), '--timeout', '12'], { cwd, timeoutMs: 14000 })
    if (response.code !== 0) throw new Error('Tern could not open the inbox. Use /inbox full, or retry /inbox.')
    const result = JSON.parse(response.stdout)
    if (!result.ok) throw new Error('Tern did not acknowledge the browser operation.')
    return result.ok
  }

  // The user can close a block or navigate it elsewhere. Look up our page before focusing or closing it.
  async function existing(url: string) {
    const result = await browser({ op: 'blocks' })
    const blocks: { block: number; url: string }[] = result.blocks
    return blocks.find(b => b.url === url)?.block
  }

  async function focused(): Promise<number | undefined> {
    const reply = await run(['tern', 'ls', '--json'], { cwd, timeoutMs: 5000 })
    if (reply.code !== 0) return undefined
    type Tab = { shown: boolean; blocks: { id: number; focused: boolean }[] }
    const layout: { sessions: { shown: boolean; tabs: Tab[] }[] } = JSON.parse(reply.stdout)
    return layout.sessions
      .find(s => s.shown)
      ?.tabs.find(t => t.shown)
      ?.blocks.find(b => b.focused)?.id
  }

  async function launch() {
    const state = latest ?? (await host.read())
    observe()
    await observing
    if (stopped) return
    page ??= serveDecisions(
      () => ({ ...decisionView(latest ?? state), theme }),
      replies => {
        if (stopped) throw new Error('This omp session has ended.')
        return sendReplies(host, replies)
      },
      () => focusBlock(target.owner),
      () => subscription?.refresh(),
    )
    const { url } = page
    const found = await existing(url)
    if (stopped) return
    if (found !== undefined) {
      if (focusRequested) await focusBlock(found)
      return
    }
    const previous = focusRequested ? undefined : await focused().catch(() => undefined)
    if (stopped) return
    const { block } = await browser({ op: 'open', owner: target.owner, url, how: 'beside' })
    if (typeof block !== 'number') throw new Error('Tern did not return an inbox block.')
    if (stopped) await browser({ op: 'close', block })
    else {
      await browser({ op: 'release', block })
      if (previous === undefined || focusRequested || stopped) return
      const current = await focused().catch(() => undefined)
      // A manual open or a focus change can arrive while Tern answers the lookup.
      if (current === block && !focusRequested && !stopped)
        await run(['tern', 'focus', String(previous)], { cwd, timeoutMs: 5000 })
    }
  }

  function open(focus = true) {
    tried = true
    if (!opening || focus) focusRequested = focus
    opening ??= launch().finally(() => {
      opening = undefined
    })
    return opening
  }

  return {
    open,
    async keyboard() {
      await open(false)
      if (stopped || !page) throw new Error('The omp session changed.')
      await page.keyboard.connected()
      return { request: page.keyboard.request, signal: lifetime.signal }
    },
    saved(state: OmpState) {
      if (stopped) return
      latest = state
      page?.update()
      if (target.auto && !tried && state.ledger.items.some(i => i.kind === 'question'))
        void open(false).catch(err => {
          if (!stopped) notify(String(err instanceof Error ? err.message : err))
        })
    },
    stop() {
      stopped = true
      lifetime.abort()
      subscription?.stop()
      if (!page) return
      const { url } = page
      page.stop()
      return existing(url)
        .then(block => (block === undefined ? undefined : browser({ op: 'close', block })))
        .catch(() => {})
    },
  }
}

/** Install and revoke the page's access as omp moves between sessions in this terminal. */
export function ternSessions(
  target: ReturnType<typeof ternTarget> | undefined,
  run: Run,
  sessions: SessionCalls,
  watchTheme?: WatchTheme,
) {
  let active: { id: string; panel: ReturnType<typeof ternPane>; sawSave: boolean } | undefined
  return {
    start(ctx: TernContext) {
      if (!target || isUnattended(ctx) || ctx.mode !== 'tui') return
      const id = sessionIdOf(ctx)
      if (active?.id === id) return
      void active?.panel.stop()
      const host = sessions.hostFor(ctx)
      const panel = ternPane(
        target,
        run,
        ctx.cwd,
        {
          ...host,
          deliver: (s, text, key) =>
            active?.panel === panel && sessionIdOf(ctx) === id
              ? host.deliver(s, text, key)
              : Promise.resolve({ state: 'rejected', reason: 'The omp session changed.' }),
        },
        message => ctx.ui.notify(message, 'warning'),
        watchTheme,
      )
      active = { id, panel, sawSave: false }
      void host
        .read()
        .then(state => {
          if (active?.panel === panel && !active.sawSave) panel.saved(state)
        })
        .catch(() => {})
    },
    saved(id: string, state: OmpState) {
      if (active?.id !== id) return
      active.sawSave = true
      active.panel.saved(state)
    },
    async keyboard(ctx: TernContext) {
      if (ctx.mode !== 'tui' || active?.id !== sessionIdOf(ctx)) return
      return active.panel.keyboard()
    },
    async open(ctx: TernContext) {
      if (ctx.mode !== 'tui' || active?.id !== sessionIdOf(ctx)) return false
      try {
        await active.panel.open()
        return true
      } catch (error) {
        ctx.ui.notify(error instanceof Error ? error.message : String(error), 'warning')
        return false
      }
    },
    stop(ctx: OmpContext) {
      if (isUnattended(ctx) || active?.id !== sessionIdOf(ctx)) return
      const closing = active.panel.stop()
      active = undefined
      return closing
    },
  }
}
