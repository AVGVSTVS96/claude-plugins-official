import type { Server } from 'bun'

export type Tool = { name: string; description: string; inputSchema: object; _meta?: object }
// What a chat app's channel says to each session: how to read its messages, and the tools that act in its thread.
export type ChannelServer = { title: string; instructions: string; tools: Tool[]; permission?: boolean }
export type Payload = { type: 'inbound'; content: string; meta: Record<string, string> } | { type: 'permission'; request_id: string; behavior: string }
export type Line = { send: (payload: Payload) => void }

type Hooks = {
  call: (thread: string, tool: string, args: Record<string, unknown>) => Promise<string>
  permission: (thread: string, request: any) => void
  open: (thread: string, line: Line) => void
  close: (thread: string, line: Line) => void
}

// The revisions whose standalone GET stream carries server notifications. Claude Code first probes
// `server/discover` for 2026-07-28, where it registers no channel ("no unsolicited notification
// path"), and falls back to `initialize` when that's declined.
const REVISIONS = ['2025-11-25', '2025-06-18', '2025-03-26']
// Claude Code starts listening for a server's channel some tens of milliseconds after it lists the
// server's tools, says nothing when it does, and drops what comes before.
const LISTENING = 1000
const encoder = new TextEncoder()

// A channel over MCP's Streamable HTTP transport, for sessions whose plugin's .mcp.json points here
// with their binding in headers. Every session id is taken as it comes, so a session that connected
// before the hub restarted carries on where it was without initializing again.
export function endpoint(name: string, channel: string, server: ChannelServer, hooks: Hooks, listening = LISTENING) {
  // Sessions initialized here whose stream hasn't ended: when they listed the tools, and the
  // stream waiting for that.
  const starting = new Map<string, { listed?: number; open?: () => void }>()

  function threadOf(request: Request) {
    const thread = request.headers.get('x-hex-thread')
    return request.headers.get('x-hex-channel') === channel && thread ? thread : undefined
  }

  function result(id: unknown, value: object) {
    return Response.json({ jsonrpc: '2.0', id, result: value })
  }

  async function call(thread: string | undefined, tool: string, args: Record<string, unknown>) {
    try {
      if (!thread) throw new Error(`this session is not bound to a ${server.title} thread (HEX_THREAD is unset)`)
      return { content: [{ type: 'text', text: await hooks.call(thread, tool, args) }] }
    } catch (error) {
      return { content: [{ type: 'text', text: `${tool} failed: ${error instanceof Error ? error.message : String(error)}` }], isError: true }
    }
  }

  // A new session's stream opens to the hub once Claude Code listens on it; a stream that comes
  // back after a drop opens at once. Bun starts a response's body only once it sends it, so writes wait for that.
  function stream(thread: string | undefined, session: string | null) {
    let controller: ReadableStreamDefaultController<Uint8Array> | undefined
    let line: Line | undefined
    let keepAlive: ReturnType<typeof setInterval> | undefined
    const waiting = [': open\n\n']
    const write = (text: string) => {
      if (!controller) return void waiting.push(text)
      try {
        controller.enqueue(encoder.encode(text))
      } catch {
        gone()
      }
    }
    function gone() {
      clearInterval(keepAlive)
      if (session) starting.delete(session)
      if (thread && line) hooks.close(thread, line)
      line = undefined
    }
    const body = new ReadableStream<Uint8Array>({
      start(started) {
        controller = started
        for (const text of waiting.splice(0)) write(text)
      },
      cancel: gone,
    })
    if (thread) {
      line = { send: payload => write(`event: message\ndata: ${JSON.stringify(notification(payload))}\n\n`) }
      keepAlive = setInterval(write, 15_000, ': keepalive\n\n')
      const open = () => line && hooks.open(thread, line)
      const started = session ? starting.get(session) : undefined
      if (!started) open()
      else if (started.listed) setTimeout(open, started.listed + listening - Date.now())
      else started.open = open
    }
    return new Response(body, { headers: { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', ...(session && { 'mcp-session-id': session }) } })
  }

  return async (request: Request): Promise<Response> => {
    if (request.headers.has('origin') || !['127.0.0.1', 'localhost'].includes(new URL(request.url).hostname)) return new Response('Forbidden', { status: 403 })
    const thread = threadOf(request)
    const session = request.headers.get('mcp-session-id')
    if (request.method === 'GET') return stream(thread, session)
    if (request.method === 'DELETE') return new Response(null, { status: 204 })
    if (request.method !== 'POST') return new Response('Method Not Allowed', { status: 405 })
    let message: any
    try {
      message = await request.json()
    } catch {
      return Response.json({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } }, { status: 400 })
    }
    const { id, method, params } = message ?? {}
    if (id === undefined || !method) {
      if (method === 'notifications/claude/channel/permission_request' && thread) hooks.permission(thread, params)
      return new Response(null, { status: 202 })
    }
    if (method === 'initialize') {
      const opened = crypto.randomUUID()
      starting.set(opened, {})
      const capabilities = { tools: {}, experimental: { 'claude/channel': {}, ...(server.permission && { 'claude/channel/permission': {} }) } }
      const revision = REVISIONS.includes(params?.protocolVersion) ? params.protocolVersion : REVISIONS[0]
      const response = result(id, { protocolVersion: revision, capabilities, serverInfo: { name, version: '1.0.0' }, instructions: server.instructions })
      response.headers.set('mcp-session-id', opened)
      return response
    }
    if (method === 'tools/list') {
      const started = session ? starting.get(session) : undefined
      if (started && !started.listed) {
        started.listed = Date.now()
        if (started.open) setTimeout(started.open, listening)
      }
      return result(id, { tools: server.tools })
    }
    if (method === 'tools/call') return result(id, await call(thread, params?.name, params?.arguments ?? {}))
    if (method === 'ping') return result(id, {})
    return Response.json({ jsonrpc: '2.0', id, error: { code: -32601, message: `Method not found: ${method}` } })
  }
}

function notification(payload: Payload) {
  if (payload.type === 'inbound') return { jsonrpc: '2.0', method: 'notifications/claude/channel', params: { content: payload.content, meta: payload.meta } }
  return { jsonrpc: '2.0', method: 'notifications/claude/channel/permission', params: { request_id: payload.request_id, behavior: payload.behavior } }
}

const listeners = new Map<number, { server: Server; routes: Map<string, (request: Request) => Promise<Response>> }>()

// Every hub in a process serves on one port, each under its own path. Port 0 gets a port of its own.
export function serve(port: number, path: string, handle: (request: Request) => Promise<Response>) {
  let listener = listeners.get(port)
  if (!listener) {
    const routes = new Map<string, (request: Request) => Promise<Response>>()
    const server = Bun.serve({
      hostname: '127.0.0.1',
      port,
      idleTimeout: 0,
      fetch: request => routes.get(new URL(request.url).pathname)?.(request) ?? new Response('Not Found', { status: 404 }),
    })
    listener = { server, routes }
    listeners.set(server.port!, listener)
  }
  const { server, routes } = listener
  routes.set(path, handle)
  return {
    port: server.port!,
    close() {
      routes.delete(path)
      if (routes.size) return
      listeners.delete(server.port!)
      void server.stop(true)
    },
  }
}
