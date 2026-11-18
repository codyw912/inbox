import type { Component, NativeNode, NativeUiEvent } from './host'
import type { DecisionSession, Question } from './decision-session'
import type { Style } from './panel'
import { fit } from './panel-text'

type Editor = Component & {
  focused: boolean
  setText(text: string): void
  getExpandedText(): string
  insertText(text: string): void
  handleInput(data: string): void
}
type Line = { text: string; tone?: 'muted' | 'strong' | 'accent'; action?: string; lines?: number }
const clean = (text: string) =>
  text
    .replace(/[\x00-\x1f\x7f-\x9f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
const node = (line: Line): NativeNode => ({
  k: 'text',
  key: line.action,
  p: {
    spans: [{ t: clean(line.text), s: line.tone }],
    lines: line.lines ?? 1,
    wrap: line.lines ? 'word' : 'none',
    truncate: 'end',
    ...(line.action && { actions: { click: line.action } }),
  },
})

export function summaryLine(review: DecisionSession, width: number): string {
  const n = review.questions.length
  const count = width < 45 ? `${n} ask${n === 1 ? '' : 's'}` : `${n} question${n === 1 ? '' : 's'}`
  const staged = review.drafts.size ? ` · ${review.drafts.size} staged` : ''
  const hint = width < 60 ? '/inbox' : 'Ctrl+Alt+I'
  return `${count}${staged} · ${hint} · ${clean(review.current?.ask ?? '')}`
}

export const summaryNode = (review: DecisionSession, cols: number): NativeNode =>
  node({
    text: summaryLine(review, cols),
    tone: 'accent',
  })

const keys = [
  'j/k   Next / previous question',
  'h/l   Move between choices',
  'Space or 1–9   Stage choice',
  'i   Write reply · x   Clear',
  'v   Read the full question and choices',
  'Enter   Send current reply',
  's or Shift+Enter   Send staged',
  'q or Esc   Return to prompt',
]

/** Both renderers consume the same question, cursor, drafts and controls. */
export function answerComponent(
  review: DecisionSession,
  redraw: () => void,
  done: () => void,
  parse: (raw: string) => string | undefined,
  editorFor: () => Editor,
  style: Style,
  wrap: (text: string, width: number) => string[],
) {
  let edit: { question: Question; editor: Editor; initial: string } | undefined
  let detail: { revision: string; offset: number } | undefined
  let help = false
  const stop = review.subscribe(redraw)

  function lines(width: number): Line[] {
    const q = review.current
    if (help) return [...keys, '?   Close help'].map(text => ({ text }))
    if (detail && detail.revision !== q?.revision) detail = undefined
    if (q && detail) {
      const paragraphs = [
        q.ask,
        q.context,
        ...q.options.flatMap((opt, i) => [`${i + 1}. ${opt}${opt === q.rec ? ' ★' : ''}`, q.descriptions?.[opt]]),
        q.reason,
      ]
      const full = paragraphs.filter((p): p is string => !!p).flatMap(p => wrap(clean(p), Math.max(1, width)))
      const page = 5
      detail.offset = Math.max(0, Math.min(detail.offset, full.length - page))
      return [
        ...full.slice(detail.offset, detail.offset + page).map(text => ({ text })),
        { text: 'j/k scroll · v back', tone: 'muted' },
      ]
    }
    const rows: Line[] = []
    if (edit) {
      rows.push(
        { text: edit.question.ask, tone: 'strong', lines: 2 },
        { text: 'Esc keep · Ctrl+G cancel', tone: 'muted' },
      )
    } else if (q) {
      rows.push({
        text: `Question ${review.index + 1}/${review.questions.length} · ${review.drafts.size} staged`,
        tone: 'muted',
      })
      rows.push({ text: q.ask, tone: 'strong', lines: 3 })
      const draft = review.drafts.get(q.id)
      const first = Math.max(0, Math.min(review.choice - 1, q.options.length - 3))
      for (let i = first; i < Math.min(q.options.length, first + 3); i++) {
        const option = q.options[i]!
        const staged = draft?.kind === 'choice' && draft.value === option
        rows.push({
          text: `${i === review.choice ? '›' : '·'} ${i + 1} ${staged ? '✓ ' : ''}${option}${option === q.rec ? ' ★' : ''}`,
          tone: i === review.choice ? 'accent' : undefined,
          action: `stage-${q.revision}-${i}`,
        })
      }
      const selected = q.options[review.choice]
      const detail =
        draft?.kind === 'text'
          ? `✓ ${draft.value}`
          : (selected && q.descriptions?.[selected]) || (selected === q.rec && q.reason) || q.context
      if (detail) rows.push({ text: detail, tone: 'muted', lines: 2 })
      rows.push({
        text:
          width < 45 ? 'i write · s send staged · ? keys' : '1–9 stage · i write · Enter send · s send staged · ? keys',
        tone: 'muted',
      })
    } else {
      rows.push({ text: 'No open questions.' }, { text: 'Esc back · /inbox full for all items', tone: 'muted' })
    }
    if (review.notice) rows.push({ text: review.notice, tone: 'accent', lines: 2 })
    return rows
  }

  function choose(q: Question, i: number) {
    if (review.busy || !q.options[i]) return
    review.choice = i
    review.stage(q, 'choice', q.options[i]!)
  }
  function input(raw: string) {
    if (review.lifetime.signal.aborted) return
    const key = parse(raw)
    if (edit) {
      if (key === 'escape' || key === 'ctrl+g') {
        const old = edit
        const value = old.editor.getExpandedText()
        if (
          key === 'ctrl+g' ||
          value === old.initial ||
          review.stage(old.question, 'text', value) ||
          old.question.revision !== review.current?.revision
        )
          edit = undefined
      } else if (key === 'enter') edit.editor.insertText('\n')
      else edit.editor.handleInput(raw)
    } else if (detail && detail.revision === review.current?.revision) {
      if (key === 'j' || key === 'k') detail.offset += key === 'j' ? 1 : -1
      else if (key === 'v' || key === 'escape') detail = undefined
      else if (key === 'q') done()
    } else if (help) {
      help = false
    } else if (key === 'escape' || key === 'q' || key === 'ctrl+alt+i') {
      done()
      return
    } else if (key === '?' || key === 'shift+?') help = true
    else if (key === 'j' || key === 'k') review.move(key === 'j' ? 1 : -1)
    else if (key === 'enter' || key === 's' || key === 'shift+enter') void review.send(key !== 'enter')
    else if (review.current && !review.busy) {
      const q = review.current
      if (key === 'v') detail = { revision: q.revision, offset: 0 }
      else if (key === 'h' || key === 'l')
        review.choice = Math.max(0, Math.min(q.options.length - 1, review.choice + (key === 'l' ? 1 : -1)))
      else if (key === 'space') choose(q, review.choice)
      else if (key && /^[1-9]$/.test(key)) choose(q, Number(key) - 1)
      else if (key === 'x') review.stage(q, 'text', '')
      else if (key === 'i') {
        const editor = editorFor()
        const draft = review.drafts.get(q.id)
        const initial = draft?.kind === 'text' ? draft.value : ''
        editor.setText(initial)
        editor.focused = true
        edit = { question: q, editor, initial }
      }
    }
    redraw()
  }
  return {
    handleInput: input,
    handleNativeEvent(event: NativeUiEvent) {
      if (event.type !== 'action' || !review.current || edit || help || detail || review.lifetime.signal.aborted) return
      const match = /^stage-([a-f0-9]+)-(\d+)$/.exec(event.act)
      if (match?.[1] === review.current.revision) choose(review.current, Number(match[2]))
    },
    render(width: number) {
      width = Math.max(1, width)
      const rows = lines(width).flatMap(line => {
        const text = clean(line.text)
        const parts = line.lines ? wrap(text, width) : [text]
        const limit = line.lines ?? 1
        return parts.slice(0, limit).map((p, i) => {
          const value = fit(p + (i === limit - 1 && parts.length > limit ? '…' : ''), width)
          return line.tone === 'strong'
            ? style.bold(value)
            : line.tone === 'muted'
              ? style.dim(value)
              : line.tone === 'accent'
                ? style.tone('accent', value)
                : value
        })
      })
      return [...rows, ...(edit?.editor.render(width) ?? [])]
    },
    describe({ cols }: { cols: number }): NativeNode {
      return { k: 'col', p: { role: 'inbox.questions' }, c: [...lines(cols).map(node), ...(edit ? [edit.editor] : [])] }
    },
    invalidate() {
      edit?.editor.invalidate?.()
    },
    dispose: stop,
  }
}
