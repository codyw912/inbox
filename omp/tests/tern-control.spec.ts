import { expect, test } from 'bun:test'
import { controlChannel, inboxKeyboard } from '../src/tern-control'

test('a newly opened page wakes the composer, replies to its caller, and never replays a key on reconnect', async () => {
  const channel = controlChannel()
  const ready = channel.connected()
  const events: string[] = []
  const detach = channel.attach(event => events.push(event))
  await ready
  const first = channel.request({ key: 'read' })
  const { id } = JSON.parse(events[0]!.split('data: ')[1]!)
  channel.answer({ id, value: 'first' })
  expect(await first).toBe('first')
  const second = channel.request({ key: 'enter' })
  const replacement: string[] = []
  channel.attach(event => replacement.push(event))
  await expect(second).rejects.toThrow('disconnected')
  detach()
  expect(replacement).toEqual([])
  const third = channel.request({ key: 'x' })
  channel.disconnect()
  await expect(third).rejects.toThrow('disconnected')
  expect(replacement).toHaveLength(1)
})

test('typed vim keys stay in the editor and an immediate batch send waits for the edited draft', async () => {
  const read = Promise.withResolvers<unknown>(),
    write = Promise.withResolvers<unknown>()
  const actions: { key: string; draft?: { value: string } }[] = []
  let value = '',
    closed = false
  const keyboard = inboxKeyboard(
    {
      request(action) {
        actions.push(action)
        return action.key === 'read' ? read.promise : action.key === 'write' ? write.promise : Promise.resolve()
      },
    },
    () => {},
    () => {
      closed = true
    },
    raw => raw,
    () => ({
      focused: false,
      setText: text => {
        value = text
      },
      getExpandedText: () => value,
      insertText: text => {
        value += text
      },
      handleInput: text => {
        value += text
      },
      render: () => [value],
    }),
    text => text,
  )
  keyboard.handleInput('j')
  keyboard.handleInput('i')
  keyboard.handleInput('k')
  read.resolve({ id: 'i1', revision: 'r1', value: 'draft ' })
  await Bun.sleep(0)
  keyboard.handleInput('enter')
  keyboard.handleInput('q')
  keyboard.handleInput('escape')
  keyboard.handleInput('shift+enter')
  expect(actions.map(a => a.key)).toEqual(['j', 'read', 'write'])
  expect(actions[2]?.draft?.value).toBe('draft k\nq')
  write.resolve(true)
  await Bun.sleep(0)
  expect(actions.map(a => a.key)).toEqual(['j', 'read', 'write', 'shift+enter'])
  keyboard.handleInput('q')
  expect(closed).toBe(true)
})
