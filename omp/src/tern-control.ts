import { randomUUID } from 'node:crypto'

type Draft = { id: string; revision: string; value: string }
type Action = { key: string; draft?: Draft }
type Editor = {
  focused: boolean
  setText(text: string): void
  getExpandedText(): string
  insertText(text: string): void
  handleInput(raw: string): void
  render(width: number): readonly string[]
}
const disconnected = 'Inbox disconnected. Press Esc to return to omp.'

/** Address the visible page's keyboard commands over its existing stream. Never replay a key on reconnect. */
export function controlChannel() {
  const pending = new Map<string, (answer?: { value?: unknown; error?: string }) => void>()
  let send: ((s: string) => void) | undefined
  let ready = Promise.withResolvers<void>()
  function disconnect() {
    send = undefined
    for (const finish of pending.values()) finish()
    ready = Promise.withResolvers<void>()
  }
  return {
    attach(write: (s: string) => void) {
      if (send) disconnect()
      send = write
      ready.resolve()
      return () => {
        if (send === write) disconnect()
      }
    },
    disconnect,
    async connected() {
      if (send) return
      let timer: ReturnType<typeof setTimeout> | undefined
      try {
        await Promise.race([
          ready.promise,
          new Promise((_, reject) => {
            timer = setTimeout(() => reject(new Error(disconnected)), 3000)
          }),
        ])
      } finally {
        clearTimeout(timer)
      }
    },
    request(action: Action): Promise<unknown> {
      if (!send) return Promise.reject(new Error(disconnected))
      const id = randomUUID()
      const { promise, resolve, reject } = Promise.withResolvers<unknown>()
      const finish = (answer?: { value?: unknown; error?: string }) => {
        clearTimeout(timer)
        pending.delete(id)
        if (!answer || answer.error) reject(new Error(answer?.error || disconnected))
        else resolve(answer.value)
      }
      const timer = setTimeout(finish, 3000)
      pending.set(id, finish)
      try {
        send('event: control\ndata: ' + JSON.stringify({ id, ...action }) + '\n\n')
      } catch {
        disconnect()
      }
      return promise
    },
    answer(body: unknown) {
      if (!body || typeof body !== 'object' || !('id' in body) || typeof body.id !== 'string')
        throw new Error('Invalid command response.')
      pending.get(body.id)?.({
        value: 'value' in body ? body.value : undefined,
        error: 'error' in body && typeof body.error === 'string' ? body.error : undefined,
      })
    },
  }
}
type KeyboardPage = Pick<ReturnType<typeof controlChannel>, 'request'>

/** A small replacement for the composer while the sibling inbox has the person's attention. */
export function inboxKeyboard(
  page: KeyboardPage,
  redraw: () => void,
  done: () => void,
  parse: (raw: string) => string | undefined,
  editorFor: () => Editor,
  fit: (text: string, width: number) => string,
) {
  let editor: Editor | undefined
  let editing: Draft | undefined
  let opening: string[] | undefined
  let saving: string[] | undefined
  let stopped = false
  let notice = ''
  const hint = 'Inbox · Esc back · j/k questions · 1–9 select · i write · ? keys'
  function failed(error: unknown) {
    if (stopped) return
    notice = error instanceof Error ? error.message : String(error)
    redraw()
  }
  function saveDraft() {
    if (!editor || !editing || saving) return
    saving = []
    const value = editor.getExpandedText()
    void (value === editing.value ? Promise.resolve() : page.request({ key: 'write', draft: { ...editing, value } }))
      .then(() => {
        editor = undefined
        editing = undefined
        notice = ''
        const buffered = saving ?? []
        saving = undefined
        for (const data of buffered) input(data)
      })
      .catch(failed)
      .finally(() => {
        saving = undefined
        if (!stopped) redraw()
      })
  }
  function input(raw: string) {
    if (stopped) return
    const key = parse(raw)
    const waiting = opening ?? saving
    if (waiting) {
      if (waiting.length < 256) waiting.push(raw)
      return
    }
    if (editor) {
      if (key === 'escape') saveDraft()
      else if (key === 'ctrl+g') {
        editor = undefined
        editing = undefined
        notice = ''
        redraw()
      } else {
        if (key === 'enter') editor.insertText('\n')
        else editor.handleInput(raw)
        redraw()
      }
      return
    }
    if (key === 'escape' || key === 'q' || key === 'ctrl+alt+i') {
      done()
      return
    }
    if (key === 'i') {
      opening = []
      void page
        .request({ key: 'read' })
        .then(value => {
          if (stopped) return
          const draft = value as Draft | undefined
          if (
            !draft ||
            typeof draft.id !== 'string' ||
            typeof draft.revision !== 'string' ||
            typeof draft.value !== 'string'
          )
            throw new Error('No open question to write a reply to.')
          editing = draft
          editor = editorFor()
          editor.focused = true
          editor.setText(draft.value)
          const buffered = opening ?? []
          opening = undefined
          notice = ''
          for (const data of buffered) input(data)
          redraw()
        })
        .catch(error => {
          opening = undefined
          failed(error)
        })
      return
    }
    if (key && /^(?:[jkhlx?1-9]|shift\+\?|space|enter|shift\+enter)$/.test(key)) {
      notice = ''
      void page.request({ key: key === 'shift+?' ? '?' : key }).catch(failed)
    }
  }
  return {
    render: (width: number) => [
      fit(editor ? 'Inbox · Esc keep · Ctrl+G cancel' : width < 45 ? 'Inbox · Esc back · ? keys' : hint, width),
      ...(notice ? [fit(notice, width)] : []),
      ...(editor ? editor.render(width) : []),
    ],
    handleInput: input,
    invalidate: () => {},
    dispose: () => {
      stopped = true
    },
  }
}
