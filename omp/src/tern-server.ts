import { controlChannel } from './tern-control'
import { randomUUID } from 'node:crypto'
import type { TernPalette } from './tern-theme'
import type { decisionView } from './tern-replies'

// Bun loads the text attribute as a string. Its ambient *.html type describes the default HTML bundle loader.
import markup from '../ui/decisions.html' with { type: 'text' }
import css from '../ui/decisions.css' with { type: 'text' }
const page = String(markup).replace('/* decision styles */', () => String(css))

type View = ReturnType<typeof decisionView> & { theme?: TernPalette }

/** A loopback page scoped to one omp session. Publish only changes visible in the decision pane. */
export function serveDecisions(
  readView: () => View,
  submit: (replies: unknown) => Promise<void>,
  returnToOmp: () => Promise<void>,
  refreshTheme?: () => void,
) {
  const base = '/' + randomUUID() + '/'
  const streams = new Set<ReadableStreamDefaultController<string>>()
  const headers = {
    'cache-control': 'no-store',
    'referrer-policy': 'no-referrer',
    'x-content-type-options': 'nosniff',
    'content-security-policy':
      "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'",
  }
  const keyboard = controlChannel()
  let data = ''
  const emit = () => 'data: ' + data + '\n\n'
  const server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    maxRequestBodySize: 512 * 1024,
    async fetch(req, server) {
      const url = new URL(req.url)
      if (url.origin !== server.url.origin || !url.pathname.startsWith(base)) return new Response(null, { status: 404 })
      const route = url.pathname.slice(base.length)
      if (!route && req.method === 'GET')
        return new Response(page, { headers: { ...headers, 'content-type': 'text/html; charset=utf-8' } })
      if (route === 'events' && req.method === 'GET') {
        server.timeout(req, 0)
        let client: ReadableStreamDefaultController<string>
        let detach: (() => void) | undefined
        const stream = new ReadableStream<string>({
          start(c) {
            client = c
            streams.add(c)
            data = JSON.stringify(readView())
            c.enqueue(emit())
            detach = keyboard.attach(message => c.enqueue(message))
          },
          cancel() {
            streams.delete(client)
            detach?.()
          },
        })
        return new Response(stream, { headers: { ...headers, 'content-type': 'text/event-stream' } })
      }
      if (
        (route !== 'send' && route !== 'return' && route !== 'answer' && route !== 'appearance') ||
        req.method !== 'POST'
      )
        return new Response(null, { status: 404 })
      if (req.headers.get('origin') !== server.url.origin || req.headers.get('content-type') !== 'application/json')
        return new Response(null, { status: 403 })
      try {
        if (route === 'appearance') refreshTheme?.()
        else if (route === 'answer') keyboard.answer(await req.json())
        else if (route === 'return') await returnToOmp()
        else await submit(await req.json())
        return new Response(null, { status: 204 })
      } catch (error) {
        return new Response(error instanceof Error ? error.message : 'omp could not complete the request.', {
          status: 409,
          headers,
        })
      }
    },
  })
  server.unref()
  return {
    keyboard,
    url: new URL(base, server.url).href,
    update() {
      if (!streams.size) return
      const next = JSON.stringify(readView())
      if (next === data) return
      data = next
      for (const c of streams) {
        try {
          c.enqueue(emit())
        } catch {
          streams.delete(c)
        }
      }
    },
    stop() {
      keyboard.disconnect()
      for (const c of streams) c.close()
      streams.clear()
      void server.stop(true)
    },
  }
}
