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

// In hex the voice plugin restarts with every call's new session, so the hub holds its port:
// each request goes on to the plugin's socket, and one that comes while the plugin is
// restarting waits for it to come back instead of failing.
export function door({ port, socket, wait = 30_000 }: { port: number; socket: string; wait?: number }) {
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

  async function pass(request: Request) {
    const { pathname, search } = new URL(request.url)
    const body = request.method === 'GET' || request.method === 'HEAD' ? undefined : await request.arrayBuffer()
    const until = Date.now() + wait
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
