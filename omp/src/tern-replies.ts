import { createHash } from 'node:crypto'
import type { Item, LastAction } from '../../types'
import { applyPress, reopenOnFailure, withFailure } from '../../hooks/press-reducer'
import { completedAttempt } from '../../hooks/session-presses'
import type { SendOutcome } from '../../hooks/session-presses'
import type { SessionHost } from '../../hooks/session-host'
import type { OmpState } from './state'

export type ReplyHost = Pick<
  SessionHost<OmpState>,
  'read' | 'update' | 'now' | 'newId' | 'deliver' | 'comparePage' | 'compareInBackground' | 'answerMessage'
>

type Reply = { id: string; revision: string; kind: 'choice' | 'text'; value: string }

function revision(item: Item, last?: LastAction) {
  const sent = last?.delivery?.state === 'failed' ? null : last?.at
  return createHash('sha256')
    .update(JSON.stringify([item, sent ?? null]))
    .digest('hex')
}

export function decisionView(s: OmpState) {
  return {
    questions: s.ledger.items
      .filter(i => i.kind === 'question')
      .map(i => ({
        id: i.id,
        ask: i.ask,
        options: i.options,
        rec: i.rec,
        reason: i.recReason,
        context: i.context,
        descriptions: i.optionDescriptions,
        revision: revision(i, s.lastActions[i.id]),
      })),
    focus: s.ledger.overview?.head?.title,
    tasks: s.ledger.items.filter(i => i.kind === 'task').map(i => i.ask),
    findings: s.ledger.findings.map(f => f.title),
    prs: s.ledger.prs,
    stale: s.presence.ledgerState !== 'current',
  }
}

function isReply(value: unknown): value is Reply {
  if (!value || typeof value !== 'object') return false
  const r = value as Partial<Reply>
  return (
    typeof r.id === 'string' &&
    typeof r.revision === 'string' &&
    (r.kind === 'choice' || r.kind === 'text') &&
    typeof r.value === 'string' &&
    !!r.value.trim() &&
    r.value.length <= 16000
  )
}

/** One saved attempt for all the rows, matched by omp when the combined message actually enters the conversation. */
export async function sendReplies(host: ReplyHost, input: unknown): Promise<void> {
  if (
    !Array.isArray(input) ||
    !input.length ||
    input.length > 128 ||
    !input.every(isReply) ||
    new Set(input.map(r => r.id)).size !== input.length
  )
    throw new Error('Choose a reply for each selected question.')
  const replies: Reply[] = input
  const deliveryId = host.newId()
  const saved = await host.update(async s => {
    const at = await host.now()
    let ledger = s.ledger
    const lastActions = { ...s.lastActions }
    const parts: string[] = []
    for (const r of replies) {
      const item = ledger.items.find(i => i.id === r.id && i.kind === 'question')
      if (!item || revision(item, lastActions[r.id]) !== r.revision)
        throw new Error('A question changed. Review your selections and send again.')
      const press =
        r.kind === 'choice'
          ? { action: 'answer' as const, id: r.id, option: r.value }
          : { action: 'type' as const, id: r.id, text: r.value }
      const result = applyPress(ledger, lastActions[r.id], press, {
        now: at,
        turnsStarted: s.presence.turnsStarted,
        holdMs: 0,
        extraSteps: [],
        comparePage: host.comparePage,
        compareInBackground: host.compareInBackground,
        answerMessage: host.answerMessage,
      })
      if ('stale' in result || !result.last) throw new Error('This reply is no longer available.')
      const held = result.last.delivery
      const send = result.effects.find(e => e.kind === 'send')
      const words = held?.state === 'held' ? held.message : send?.text
      if (!words) throw new Error('This reply is no longer available.')
      parts.push(words)
      lastActions[r.id] = result.last
      ledger = result.ledger
    }
    const text = parts.join('\n\n')
    for (const { id } of replies)
      lastActions[id] = { ...lastActions[id]!, delivery: { state: 'unconfirmed', message: text, id: deliveryId } }
    const first = replies[0]!
    return {
      ...s,
      ledger,
      lastActions,
      sent: [
        ...s.sent,
        {
          text,
          press: replies.length === 1 && first.kind === 'choice' ? { id: first.id, action: 'answer' } : null,
          at,
          row: first.id,
          queuedId: null,
          pressedAt: at,
          deliveryId,
          phase: 'attempting',
        },
      ],
    }
  })
  const attempt = saved.sent.find(m => m.deliveryId === deliveryId)!
  const at = attempt.at
  const outcome: SendOutcome = await host
    .deliver(saved, attempt.text, deliveryId)
    .catch((e: unknown) => ({ state: 'unconfirmed', reason: String(e) }))
  await host.update(s => {
    const next = completedAttempt(s, deliveryId, outcome)
    if (outcome.state !== 'rejected') return next
    const lastActions = withFailure(
      next.lastActions,
      replies.map(r => r.id),
      at,
      outcome.reason,
      deliveryId,
    )
    let ledger = next.ledger
    for (const { id } of replies) {
      const action = lastActions[id]
      if (action?.delivery?.state === 'failed' && action.delivery.id === deliveryId && action.kind === 'mark')
        ledger = reopenOnFailure(ledger, id, at)
    }
    return { ...next, lastActions, ledger }
  })
  if (outcome.state === 'rejected') throw new Error(outcome.reason)
  if (outcome.state === 'unconfirmed') throw new Error('Delivery unconfirmed. Check the conversation before retrying.')
}
