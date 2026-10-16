import { readFileSync } from 'fs'
import { join } from 'path'
import { route } from './hub.ts'

// Claude Code's side of a session's channel to a hub, for tests: it initializes, opens the stream
// its messages arrive on, lists the tools, and lists them again when told they changed. deaf: how
// many tools/list_changed it drops, as a session starting cold does before it listens.
export type Session = ReturnType<typeof http>

let ids = 0
const streams: AbortController[] = []
let listener: ReturnType<typeof Bun.serve> | undefined

// The one listener serve.ts opens, for a test's hubs.
export function port() {
  listener ??= Bun.serve({ hostname: '127.0.0.1', port: 0, idleTimeout: 0, fetch: route })
  return listener.port
}

export function hangUpAll() {
  for (const stream of streams.splice(0)) stream.abort()
}

// A client's bot.ts run in its own process the way serve.ts runs it, behind a listener on a free
// port, which the hub reads from HEX_PORT as it loads.
export async function service(bot: string, env: Record<string, string | undefined>) {
  const hub = JSON.stringify(join(import.meta.dir, 'hub.ts'))
  const script = `const listener = Bun.serve({ hostname: '127.0.0.1', port: 0, idleTimeout: 0, fetch: request => route(request) })
process.env.HEX_PORT = String(listener.port)
const { route } = await import(${hub})
console.log(listener.port)
await import(${JSON.stringify(bot)})`
  const child = Bun.spawn(['bun', '-e', script], { env, stdout: 'pipe', stderr: 'ignore' })
  const reader = child.stdout.getReader()
  let out = ''
  while (!out.includes('\n')) {
    const { value, done } = await reader.read()
    if (done) throw new Error(`${bot} exited before it listened`)
    out += new TextDecoder().decode(value)
  }
  void (async () => { while (!(await reader.read()).done); })()
  return { process: child, port: Number(out.split('\n')[0]) }
}

// at: the port of a hub in another process; this process's own listener by default.
export function http({ stateDir, path, channel, thread, extra = {}, deaf = 0, at = port() }: { stateDir: string; path: string; channel: string; thread?: string; extra?: Record<string, string>; deaf?: number; at?: number }) {
  const url = `http://127.0.0.1:${at}${path}`
  const headers = { ...(thread && { 'x-hex-channel': channel, 'x-hex-thread': thread }), authorization: `Bearer ${readFileSync(join(stateDir, 'token'), 'utf8')}`, 'content-type': 'application/json', accept: 'application/json, text/event-stream', ...extra }
  const received: any[] = []
  const stream = new AbortController()
  streams.push(stream)
  let mcp = ''
  let lists = 0
  const post = (body: object) => fetch(url, { method: 'POST', headers: { ...headers, ...(mcp && { 'mcp-session-id': mcp }) }, body: JSON.stringify({ jsonrpc: '2.0', ...body }) })
  const rpc = async (method: string, params: object = {}) => {
    if (method === 'tools/list') lists++
    return (await post({ id: ++ids, method, params })).json() as Promise<any>
  }
  return {
    received,
    listed: () => lists,
    post,
    rpc,
    initialize: async () => (mcp = (await post({ id: ++ids, method: 'initialize', params: { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'test', version: '0' } } })).headers.get('mcp-session-id')!),
    open: async (adopted?: string) => {
      if (adopted) mcp = adopted
      const response = await fetch(url, { headers: { ...headers, 'mcp-session-id': mcp }, signal: stream.signal })
      void listen(response, received, () => void (deaf-- > 0 || rpc('tools/list')))
      return response
    },
    close: () => stream.abort(),
    call: async (tool: string, args: object = {}) => (await rpc('tools/call', { name: tool, arguments: args })).result,
    ask: (request: object) => post({ method: 'notifications/claude/channel/permission_request', params: request }),
  }
}

// A session connected and listening, the way it is once Claude Code has started it. Its tool
// calls answer with the text, or the error, the tool gave.
export async function connect(options: Parameters<typeof http>[0]) {
  const line = http(options)
  await line.initialize()
  await line.open()
  await line.rpc('tools/list')
  for (const end = Date.now() + 3000; line.listed() < 2; await Bun.sleep(10)) if (Date.now() > end) throw new Error('the hub never opened the channel')
  await Bun.sleep(10)
  return {
    ...line,
    call: async (tool: string, args: object = {}) => {
      const { content, isError } = await line.call(tool, args)
      const text: string = content[0].text
      return isError ? { error: text.replace(`${tool} failed: `, '') } : { text }
    },
  }
}

async function listen(response: Response, received: any[], changed: () => void) {
  let buffer = ''
  try {
    for await (const chunk of response.body!) {
      buffer += new TextDecoder().decode(chunk)
      for (let end = buffer.indexOf('\n\n'); end >= 0; end = buffer.indexOf('\n\n')) {
        const data = buffer.slice(0, end).split('\n').find(line => line.startsWith('data: '))
        buffer = buffer.slice(end + 2)
        if (!data) continue
        const { method, params } = JSON.parse(data.slice(6))
        if (method === 'notifications/tools/list_changed') changed()
        else received.push({ type: method === 'notifications/claude/channel' ? 'inbound' : 'permission', ...params })
      }
    }
  } catch {}
}
