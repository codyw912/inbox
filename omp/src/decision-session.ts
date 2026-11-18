import { isUnattended, sessionIdOf, type OmpContext } from './host-context'
import { questionsOf, sendReplies, type Reply, type ReplyHost } from './decision-replies'
import type { OmpState } from './state'

export type Question = ReturnType<typeof questionsOf>[number]

/** Review state belongs to the current omp session. Only sending writes to its ledger. */
export class DecisionSession {
  questions: Question[] = []
  index = 0
  choice = 0
  drafts = new Map<string, Reply>()
  busy = false
  open = false
  notice = ''
  private changedDraft = false
  private listeners = new Set<() => void>()
  readonly lifetime = new AbortController()

  constructor(private host: ReplyHost) {}

  get current() {
    return this.questions[this.index]
  }

  subscribe(fn: () => void) {
    this.listeners.add(fn)
    return () => void this.listeners.delete(fn)
  }

  redraw() {
    for (const fn of this.listeners) fn()
  }

  saved(state: OmpState) {
    const rows = questionsOf(state)
    if (rows.length === this.questions.length && rows.every((q, i) => q.revision === this.questions[i]?.revision))
      return
    const previous = this.current
    this.questions = rows
    const retained = rows.findIndex(q => q.id === previous?.id)
    this.index = retained >= 0 ? retained : Math.max(0, Math.min(this.index, rows.length - 1))
    if (this.current?.revision !== previous?.revision) this.choice = 0
    if (!this.busy && this.prune()) this.notice = 'A staged question changed. Review remaining replies.'
    this.redraw()
  }

  private prune() {
    let removed = false
    for (const [id, draft] of this.drafts) {
      if (this.questions.some(q => q.id === id && q.revision === draft.revision)) continue
      this.drafts.delete(id)
      this.changedDraft = true
      removed = true
    }
    return removed
  }

  move(by: number) {
    if (!this.questions.length) return
    this.index = (this.index + by + this.questions.length) % this.questions.length
    const q = this.current!
    const draft = this.drafts.get(q.id)
    this.choice = Math.max(0, draft?.kind === 'choice' ? q.options.indexOf(draft.value) : 0)
    this.redraw()
  }

  stage(q: Question, kind: Reply['kind'], value: string) {
    if (this.busy) return false
    if (this.current?.revision !== q.revision) {
      this.notice = 'Question changed. Review it before answering.'
    } else if (value.length > 16000) {
      this.notice = 'Reply exceeds 16,000 characters.'
    } else {
      if (value.trim()) this.drafts.set(q.id, { id: q.id, revision: q.revision, kind, value })
      else this.drafts.delete(q.id)
      this.notice = ''
      this.redraw()
      return true
    }
    this.redraw()
    return false
  }

  async send(all: boolean) {
    if (this.busy || this.lifetime.signal.aborted) return
    const selected = (all ? this.questions : this.current ? [this.current] : []).flatMap(
      q => this.drafts.get(q.id) ?? [],
    )
    if (all && this.changedDraft) {
      this.changedDraft = false
      this.notice = 'Staged set changed. Review, then send again.'
    } else if (!selected.length) {
      this.notice = 'Stage a reply first.'
    } else {
      this.busy = true
      this.notice = 'Sending…'
      this.redraw()
      try {
        await sendReplies(this.host, selected)
        for (const r of selected) this.drafts.delete(r.id)
        this.notice = selected.length === 1 ? 'Sent reply.' : `Sent ${selected.length} replies together.`
      } catch (error) {
        this.notice = error instanceof Error ? error.message : String(error)
      } finally {
        this.busy = false
        this.prune()
      }
    }
    this.redraw()
  }
}

export function decisionSessions(hostFor: (ctx: OmpContext) => ReplyHost) {
  let active: { id: string; review: DecisionSession; sawSave: boolean } | undefined
  function start(ctx: OmpContext & { mode: string }) {
    if (ctx.mode !== 'tui' || isUnattended(ctx)) return
    const id = sessionIdOf(ctx)
    if (active?.id === id) return active.review
    active?.review.lifetime.abort()
    const host = hostFor(ctx)
    const review: DecisionSession = new DecisionSession({
      ...host,
      deliver: (s, text, key) =>
        active?.review === review && sessionIdOf(ctx) === id
          ? host.deliver(s, text, key)
          : Promise.resolve({ state: 'rejected', reason: 'The omp session changed.' }),
    })
    active = { id, review, sawSave: false }
    void host
      .read()
      .then(s => {
        if (active?.review === review && !active.sawSave) review.saved(s)
      })
      .catch(() => {})
    return review
  }
  return {
    start,
    get(ctx: OmpContext) {
      return active?.id === sessionIdOf(ctx) ? active.review : undefined
    },
    saved(id: string, s: OmpState) {
      if (active?.id !== id) return
      active.sawSave = true
      active.review.saved(s)
    },
    stop(ctx: OmpContext) {
      if (isUnattended(ctx) || active?.id !== sessionIdOf(ctx)) return
      active.review.lifetime.abort()
      active = undefined
    },
  }
}
