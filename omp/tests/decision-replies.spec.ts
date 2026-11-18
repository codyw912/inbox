import { DecisionSession } from '../src/decision-session'
import { afterEach, beforeEach, expect, test } from 'bun:test'
import { randomUUID } from 'node:crypto'
import { readState, updateState } from '../src/state'
import { questionsOf, sendReplies } from '../src/decision-replies'
import type { OmpState } from '../src/state'
import type { ReplyHost } from '../src/decision-replies'
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
  const replies = questionsOf(initial).map(q => ({
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

test('an updated question invalidates its draft and a delayed edit cannot overwrite the next question', async () => {
  const { host, initial, calls } = await fixture()
  const review = new DecisionSession(host)
  review.saved(initial)
  const old = review.current!
  review.stage(old, 'choice', 'No')
  review.move(1)
  review.stage(review.current!, 'choice', 'Yes')
  const changed = await host.update(s => ({ ...s, ledger: { ...s.ledger, items: s.ledger.items.slice(1) } }))
  review.saved(changed)
  expect(review.stage(old, 'text', 'old edit')).toBe(false)
  expect(review.drafts.size).toBe(1)
  await review.send(true)
  expect(calls).toEqual([])
  await review.send(true)
  expect(calls).toEqual(['Re "Use SQLite?": Yes'])
})

test('a rejected batch restores its staged replies across optimistic ledger writes and rapid duplicate sends', async () => {
  const { host, initial } = await fixture()
  const reply = Promise.withResolvers<void>()
  let attempts = 0
  const review = new DecisionSession({
    ...host,
    update: async fn => {
      const s = await host.update(fn)
      review.saved(s)
      return s
    },
    deliver: async () => {
      attempts++
      await reply.promise
      return { state: 'rejected', reason: 'agent stopped' }
    },
  })
  review.saved(initial)
  for (const q of review.questions) {
    review.stage(q, 'choice', 'Yes')
    review.move(1)
  }
  const sending = review.send(true)
  await review.send(true)
  reply.resolve()
  await sending
  expect(attempts).toBe(1)
  expect(review.questions.length).toBe(2)
  expect(review.drafts.size).toBe(2)
  expect(review.notice).toBe('agent stopped')
})
