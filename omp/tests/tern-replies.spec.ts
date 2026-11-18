import { afterEach, beforeEach, expect, test } from 'bun:test'
import { randomUUID } from 'node:crypto'
import { emptyState, readState, updateState } from '../src/state'
import { decisionView, sendReplies } from '../src/tern-replies'
import { serveDecisions } from '../src/tern-server'
import { ternPane, ternTarget } from '../src/tern-pane'
import type { OmpState } from '../src/state'
import type { ReplyHost } from '../src/tern-replies'
import { notePrompt } from '../../hooks/session-turns'
import { OMP } from '../src/texts'
import { endWorld, startWorld, w } from './host-harness'

beforeEach(startWorld)
afterEach(endWorld)

async function fixture() {
  const read = () => readState(w.dir, 'test')
  const update = (fn: (s: OmpState) => OmpState | Promise<OmpState>) => updateState(w.dir, 'test', fn)
  const initial = await update(s => ({
    ...s,
    ledger: {
      ...s.ledger,
      items: ['Use Rust?', 'Use SQLite?'].map((ask, i) => ({
        id: 'i' + i,
        kind: 'question',
        ask,
        options: ['Yes', 'No'],
        rec: 'Yes',
        at: 1,
        from: 'record',
        turn: 1,
        helps: [],
        label: null,
      })),
    },
  }))
  const calls: string[] = []
  const host = {
    read,
    update,
    now: () => ++w.clock,
    newId: randomUUID,
    comparePage: '',
    compareInBackground: false,
    deliver: async (_s: OmpState, text: string) => {
      calls.push(text)
      return { state: 'accepted', queuedId: null }
    },
  } satisfies ReplyHost
  const replies = decisionView(initial).questions.map(q => ({
    id: q.id,
    revision: q.revision,
    kind: 'choice',
    value: 'Yes',
  }))
  return { host, replies, calls, initial }
}

test('two answers enter one omp turn and arrival settles both rows', async () => {
  const { host, replies, calls } = await fixture()
  await Promise.allSettled([sendReplies(host, replies), sendReplies(host, replies)])
  expect(calls).toEqual(['Re "Use Rust?": Yes\n\nRe "Use SQLite?": Yes'])
  const before = await host.read()
  expect(before.sent).toHaveLength(1)
  expect(before.ledger.closed).toHaveLength(2)
  const { state } = notePrompt(OMP, before, calls[0]!, false)
  expect(state.sent).toHaveLength(0)
  for (const r of replies) expect(state.lastActions[r.id]?.delivery?.state).toBe('arrived')
})

test('a changed question rejects the entire set before saving or sending', async () => {
  const { host, replies, calls } = await fixture()
  await host.update(s => ({
    ...s,
    ledger: { ...s.ledger, items: s.ledger.items.map((q, i) => (i ? { ...q, ask: 'Use Postgres?' } : q)) },
  }))
  await expect(sendReplies(host, replies)).rejects.toThrow('changed')
  expect(calls).toEqual([])
  expect((await host.read()).ledger.items).toHaveLength(2)
})

test('refusal restores the selected choices and a single retry leaves the other open', async () => {
  const { host, replies, calls } = await fixture()
  await expect(
    sendReplies({ ...host, deliver: async () => ({ state: 'rejected', reason: 'cost cap' }) }, replies),
  ).rejects.toThrow('cost cap')
  const failed = await host.read()
  expect(failed.ledger.items).toHaveLength(2)
  expect(failed.sent).toHaveLength(0)
  await sendReplies(host, [replies[0]])
  expect(calls).toEqual(['Re "Use Rust?": Yes'])
  expect((await host.read()).ledger.items).toHaveLength(1)
})

test('a typed follow-up keeps the question open and the original submission cannot replay', async () => {
  const { host, replies, calls } = await fixture()
  const typed = { ...replies[0], kind: 'text', value: 'How big is the binary?' }
  await sendReplies(host, [typed])
  await expect(sendReplies(host, [typed])).rejects.toThrow('changed')
  expect(calls[0]).toContain('How big is the binary?')
  expect((await host.read()).ledger.items).toHaveLength(2)
})

test('pane page serves a snapshot on connect, pushes changes, and accepts only same-origin replies', async () => {
  const { initial, host, replies, calls } = await fixture()
  let current = initial
  let projections = 0
  const page = serveDecisions(
    () => {
      projections++
      return decisionView(current)
    },
    r => sendReplies(host, r),
  )
  try {
    page.update()
    expect(projections).toBe(0)
    const { origin } = new URL(page.url)
    expect((await fetch(origin)).status).toBe(404)
    expect(await (await fetch(page.url)).text()).toContain('Send replies')
    const events = await fetch(page.url + 'events')
    const reader = events.body!.getReader()
    const next = async () =>
      JSON.parse(
        new TextDecoder()
          .decode((await reader.read()).value)
          .trim()
          .slice(6),
      )
    expect((await next()).questions).toHaveLength(2)
    const post = (origin: string) =>
      fetch(page.url + 'send', {
        method: 'POST',
        headers: { origin, 'content-type': 'application/json' },
        body: JSON.stringify(replies),
      })
    expect((await post('https://example.com')).status).toBe(403)
    expect((await post(origin)).status).toBe(204)
    current = await host.read()
    page.update()
    expect((await next()).questions).toHaveLength(0)
    expect(calls).toHaveLength(1)
    await reader.cancel()
  } finally {
    page.stop()
  }
})

test('Tern opens one sibling on the first question, reuses it on demand, and can reopen a closed block', async () => {
  const { initial, host } = await fixture()
  const ops: string[] = []
  let block: { block: number; url: string } | undefined
  const pane = ternPane(
    { owner: 7, auto: true },
    async args => {
      if (args[1] === 'focus') {
        ops.push('focus')
        return { code: 0, stdout: '', stderr: '' }
      }
      const op = JSON.parse(args[2]!)
      ops.push(op.op)
      if (op.op === 'open') {
        expect(op).toMatchObject({ owner: 7, how: 'beside' })
        block = { block: 11, url: op.url }
      }
      const ok = op.op === 'blocks' ? { blocks: block ? [block] : [] } : op.op === 'open' ? { block: 11 } : {}
      return { code: 0, stdout: JSON.stringify({ ok }), stderr: '' }
    },
    '/work',
    host,
    () => {},
  )
  try {
    pane.saved(emptyState('test'))
    expect(ops).toEqual([])
    pane.saved(initial)
    pane.saved(initial)
    await pane.open()
    expect(ops).toEqual(['blocks', 'open', 'release'])
    await pane.open()
    expect(ops.slice(-2)).toEqual(['blocks', 'focus'])
    block = undefined
    pane.saved(initial)
    expect(ops.filter(op => op === 'open')).toHaveLength(1)
    await pane.open()
    expect(ops.filter(op => op === 'open')).toHaveLength(2)
  } finally {
    pane.stop()
  }
  expect(ternTarget({ TERN_PANE: '7' })).toBeNull()
  expect(ternTarget({ TERN_PANE: '7', TERN_PANE_SOCKET: 's', OMP_INBOX_TERN: 'manual' })).toEqual({
    owner: 7,
    auto: false,
  })
})
