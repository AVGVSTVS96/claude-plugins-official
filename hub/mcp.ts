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
const encoder = new TextEncoder()
const NUDGE = 250

// How far a session initialized here is from listening. Claude Code drops channel messages that come
// before it listens and says nothing when it starts, but it registers its channel handler in the same
// step as its tools/list_changed handler, so once its stream is open and it has listed the tools, it's
// told they changed, and the list that answers is the sign it listens. A session starting cold
// registers them a while after it lists the tools and drops what came before, so it's told again
// until it answers.
type Handshake = { is: 'initialized' } | { is: 'listed' } | { is: 'streaming'; nudge: () => void; open: () => void } | { is: 'nudged'; open: () => void }

// A channel over MCP's Streamable HTTP transport, for sessions whose plugin's .mcp.json points here
// with their binding and the hub's token in headers. Every session id is taken as it comes, so a
// session that connected before the hub restarted carries on where it was without initializing again.
export function endpoint(name: string, channel: string, token: string, server: ChannelServer, hooks: Hooks) {
  const starting = new Map<string, Handshake>()

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

  function listed(session: string | null) {
    const step = session ? starting.get(session) : undefined
    if (step?.is === 'initialized') starting.set(session!, { is: 'listed' })
    if (step?.is === 'streaming') {
      starting.set(session!, { is: 'nudged', open: step.open })
      step.nudge()
    }
    if (step?.is === 'nudged') {
      starting.delete(session!)
      step.open()
    }
  }

  // Bun starts a response's body only once it sends it, so writes wait for that.
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
    const event = (message: object) => write(`event: message\ndata: ${JSON.stringify({ jsonrpc: '2.0', ...message })}\n\n`)
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
      line = { send: payload => event(notification(payload)) }
      keepAlive = setInterval(write, 15_000, ': keepalive\n\n')
      const open = () => line && hooks.open(thread, line)
      const nudge = () => {
        event({ method: 'notifications/tools/list_changed' })
        setTimeout(() => line && starting.get(session!)?.is === 'nudged' && nudge(), NUDGE)
      }
      const step = session ? starting.get(session) : undefined
      if (!step) open()
      else if (step.is === 'listed') {
        starting.set(session!, { is: 'nudged', open })
        nudge()
      } else starting.set(session!, { is: 'streaming', nudge, open })
    }
    return new Response(body, { headers: { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', ...(session && { 'mcp-session-id': session }) } })
  }

  return async (request: Request): Promise<Response> => {
    // The token comes as Authorization: Claude Code then takes a refusal as a failed connection,
    // where with any other header it marks the server as needing a login for 15 minutes.
    if (request.headers.has('origin') || !['127.0.0.1', 'localhost'].includes(new URL(request.url).hostname) || request.headers.get('authorization') !== `Bearer ${token}`) return new Response('Forbidden', { status: 403 })
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
      starting.set(opened, { is: 'initialized' })
      const capabilities = { tools: { listChanged: true }, experimental: { 'claude/channel': {}, ...(server.permission && { 'claude/channel/permission': {} }) } }
      const revision = REVISIONS.includes(params?.protocolVersion) ? params.protocolVersion : REVISIONS[0]
      const response = result(id, { protocolVersion: revision, capabilities, serverInfo: { name, version: '1.0.0' }, instructions: server.instructions })
      response.headers.set('mcp-session-id', opened)
      return response
    }
    if (method === 'tools/list') {
      listed(session)
      return result(id, { tools: server.tools })
    }
    if (method === 'tools/call') return result(id, await call(thread, params?.name, params?.arguments ?? {}))
    if (method === 'ping') return result(id, {})
    return Response.json({ jsonrpc: '2.0', id, error: { code: -32601, message: `Method not found: ${method}` } })
  }
}

function notification(payload: Payload) {
  if (payload.type === 'inbound') return { method: 'notifications/claude/channel', params: { content: payload.content, meta: payload.meta } }
  return { method: 'notifications/claude/channel/permission', params: { request_id: payload.request_id, behavior: payload.behavior } }
}
