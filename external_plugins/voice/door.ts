import { readFileSync, watch, type FSWatcher } from 'fs'
import { homedir } from 'os'
import { basename, dirname, join } from 'path'

type Pipe = { path: string; queue: (string | Buffer)[]; upstream?: WebSocket }

export function voicePort(env = join(homedir(), '.claude', 'channels', 'voice', '.env')) {
  let text = ''
  try {
    text = readFileSync(env, 'utf8')
  } catch {}
  return Number(process.env.VOICE_PORT ?? text.match(/^\s*VOICE_PORT\s*=\s*(\d+)/m)?.[1] ?? 8790)
}

// Twilio gives up on a webhook after 15 seconds, so a phone call waits less for a new session
// and lands in the old one rather than failing.
const PHONE_WAIT = 10_000

// In hex the voice plugin restarts with every call's new session, so the hub holds its port:
// each request goes on to the plugin's socket, and one that comes while the plugin is
// restarting waits for it to come back instead of failing. A call that comes while the last
// call's session is winding down to renew waits for the new session (renewal).
export function door({ port, socket, wait = 30_000, renewal }: { port: number; socket: string; wait?: number; renewal?: () => Promise<void> }) {
  const dir = dirname(socket)
  const name = basename(socket)

  function moved(until: number) {
    let watcher: FSWatcher | undefined
    let timer: ReturnType<typeof setTimeout> | undefined
    const settled = new Promise<void>(resolve => {
      watcher = watch(dir, (_, file) => file === name && resolve())
      timer = setTimeout(resolve, Math.max(0, until - Date.now()))
    })
    return { settled, close: () => (watcher?.close(), clearTimeout(timer)) }
  }

  function within(done: Promise<void>, until: number) {
    let timer: ReturnType<typeof setTimeout> | undefined
    return Promise.race([done, new Promise<void>(resolve => (timer = setTimeout(resolve, Math.max(0, until - Date.now()))))]).finally(() => clearTimeout(timer))
  }

  async function pass(request: Request) {
    const { pathname, search } = new URL(request.url)
    const body = request.method === 'GET' || request.method === 'HEAD' ? undefined : await request.arrayBuffer()
    const until = Date.now() + wait
    const calling = request.method === 'POST' && (pathname === '/session' || pathname === '/twilio/incoming')
    if (calling && renewal) await within(renewal(), pathname === '/session' ? until : Date.now() + PHONE_WAIT)
    for (;;) {
      const next = moved(until)
      try {
        return await fetch(`http://voice${pathname}${search}`, { unix: socket, method: request.method, headers: request.headers, body, redirect: 'manual', signal: request.signal })
      } catch (error) {
        if ((error as { code?: string }).code !== 'FailedToOpenSocket' || Date.now() >= until) return new Response("hex voice isn't answering", { status: 503 })
        await next.settled
      } finally {
        next.close()
      }
    }
  }

  function listen() {
    try {
      return Bun.serve<Pipe>({
        hostname: '127.0.0.1',
        port,
        idleTimeout: 120,
        fetch(request, server) {
          if (request.headers.get('upgrade')?.toLowerCase() !== 'websocket') return pass(request)
          const { pathname, search } = new URL(request.url)
          return server.upgrade(request, { data: { path: pathname + search, queue: [] } }) ? undefined : new Response('upgrade failed', { status: 400 })
        },
        websocket: {
          open(client) {
            const upstream = (client.data.upstream = new WebSocket(`ws+unix://${socket}:${client.data.path}`))
            upstream.binaryType = 'nodebuffer'
            upstream.onopen = () => client.data.queue.splice(0).forEach(message => upstream.send(message))
            upstream.onmessage = ({ data }) => client.send(data)
            upstream.onclose = () => client.close()
          },
          message(client, message) {
            const { upstream, queue } = client.data
            if (upstream?.readyState === WebSocket.OPEN) upstream.send(message)
            else queue.push(message)
          },
          close(client) {
            client.data.upstream?.close()
          },
        },
      })
    } catch (error) {
      if ((error as { code?: string }).code !== 'EADDRINUSE') throw error
      process.stderr.write(`voice door: port ${port} is taken, so it tries again once the plugin comes up on ${socket}\n`)
      const watcher = watch(dir, (_, file) => file === name && (watcher.close(), listen()))
    }
  }

  return listen()
}
