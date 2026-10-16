import { afterEach, beforeEach, expect, test } from 'bun:test'
import { connect, createServer, type Socket } from 'net'
import { appendFileSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync, chmodSync, existsSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { free, route, stamp, startHub, tappable, transcribe, type ChannelServer, type Message, type Permission } from './hub.ts'

const CHANNEL = 'plugin:telegram@hex'
const SESSION = '0a1b2c3d-0000-4000-8000-000000000000'
const message: Message = { content: 'hi', meta: { chat_id: '1' } }
const SERVER: ChannelServer = { title: 'Telegram', instructions: 'Messages arrive as <channel source="telegram">.', tools: [{ name: 'reply', description: 'Reply.', inputSchema: { type: 'object' } }], permission: true }
// Above Linux's highest pid, so a session's process is always already gone.
const EXITED = 4_194_305

let dir: string
let hub: ReturnType<typeof startHub>
let states: [string, boolean][]
let failures: [string, string][]
let prompts: [string, Permission][]
const sockets: Socket[] = []
const streams: AbortController[] = []
let ids = 0
const listener = Bun.serve({ hostname: '127.0.0.1', port: 0, idleTimeout: 0, fetch: route })

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'hub-'))
  mkdirSync(join(dir, 'hex'), { recursive: true })
  mkdirSync(join(dir, 'jobs', 'job12345'), { recursive: true })
  const fake = join(dir, 'claude')
  writeFileSync(fake, `#!/bin/sh
jq -cn '$ARGS.positional' --args -- "$@" >> "${dir}/calls"
[ "$1 $2" = "agents --json" ] && cat "${dir}/agents" 2>/dev/null
[ "$1" = "--bg" ] && echo "backgrounded · job12345 · test"
[ "$1" = "stop" ] && [ -f "${dir}/agents" ] && jq -c --arg id "$2" 'map(select(.sessionId | startswith($id) | not))' "${dir}/agents" > "${dir}/agents.next" && mv "${dir}/agents.next" "${dir}/agents"
exit 0
`)
  chmodSync(fake, 0o755)
  process.env.PATH = `${dir}:${process.env.PATH}`
  process.env.CLAUDE_CONFIG_DIR = dir
})

afterEach(() => {
  for (const socket of sockets.splice(0)) socket.destroy()
  for (const stream of streams.splice(0)) stream.abort()
  hub?.close()
  process.env.PATH = process.env.PATH!.split(':').slice(1).join(':')
  delete process.env.CLAUDE_CONFIG_DIR
})

// stale: the registry's sessions started with what the hub no longer gives a session, as after an update.
function start(options: { main?: string; general?: boolean; idleStop?: number; cacheWarm?: number; compactAbove?: number; reconnect?: number; launcher?: string; registry?: Record<string, any>; stale?: boolean; agents?: object[]; fresh?: (thread: string) => boolean; capacity?: number; bind?: (thread: string) => Record<string, string>; hooks?: string[] } = {}) {
  const { idleStop, cacheWarm, compactAbove, reconnect, capacity } = options
  if (options.registry) writeFileSync(join(dir, 'threads.json'), JSON.stringify(options.stale ? before(options.registry) : options.registry))
  if (options.agents) writeFileSync(join(dir, 'agents'), JSON.stringify(options.agents))
  const seen: [string, boolean][] = (states = [])
  const failedSeen: [string, string][] = (failures = [])
  const asked: [string, Permission][] = (prompts = [])
  hub = startHub({
    stateDir: dir,
    channel: CHANNEL,
    server: SERVER,
    port: listener.port,
    main: options.main,
    general: options.general,
    call: async (thread, tool) => `${tool} in ${thread}`,
    state: (thread, busy) => void seen.push([thread, busy]),
    failed: (thread, reason) => void failedSeen.push([thread, reason]),
    permission: (thread, request) => void asked.push([thread, request]),
    hexDir: join(dir, 'hex'),
    limits: Object.fromEntries(Object.entries({ idleStop, cacheWarm, compactAbove, reconnect, capacity }).filter(([, value]) => value !== undefined)),
    launcher: options.launcher,
    fresh: options.fresh,
    bind: options.bind,
    hooks: options.hooks,
    mainName: 'hex',
  })
}

// Each thread as an older hub recorded starting its session.
function before(registry: Record<string, any>) {
  return Object.fromEntries(Object.entries(registry).map(([thread, known]) => [thread, { ...known, launched: stamp([], { ...SERVER, instructions: 'older' }) }]))
}

function calls(): string[][] {
  if (!existsSync(join(dir, 'calls'))) return []
  return readFileSync(join(dir, 'calls'), 'utf8').split('\n').slice(0, -1).map(line => JSON.parse(line))
}

async function until<T>(check: () => T | undefined, timeout = 3000): Promise<T> {
  for (const end = Date.now() + timeout; Date.now() < end; await Bun.sleep(20)) {
    const value = check()
    if (value) return value
  }
  throw new Error('timed out')
}

function launched() {
  return until(() => calls().find(args => args[0] === '--bg'))
}

// A session connecting the way Claude Code does over HTTP: it initializes, opens the stream its
// messages arrive on, lists the tools, and lists them again when told they changed. Claude's job
// record has its id from the start.
async function session(thread: string, id = SESSION) {
  writeFileSync(join(dir, 'jobs', 'job12345', 'state.json'), JSON.stringify({ state: 'working', sessionId: id }))
  const line = http(thread)
  await line.initialize()
  await line.open()
  await line.rpc('tools/list')
  await until(() => line.listed() === 2)
  await Bun.sleep(10)
  return line
}

// Claude Code's side of one connection to the hub over HTTP, a step at a time. deaf: how many
// tools/list_changed it drops, as a session starting cold does before it listens.
function http(thread?: string, extra: Record<string, string> = {}, deaf = 0) {
  const url = `http://127.0.0.1:${listener.port}/telegram`
  const headers = { ...(thread && { 'x-hex-channel': CHANNEL, 'x-hex-thread': thread }), authorization: `Bearer ${readFileSync(join(dir, 'token'), 'utf8')}`, 'content-type': 'application/json', accept: 'application/json, text/event-stream', ...extra }
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
    send: (payload: object) => hook(payload),
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

// A line to hub.sock, the way a session's hooks and hex's own tools reach the hub.
function hook(payload: object) {
  const socket = connect(join(dir, 'hub.sock'))
  sockets.push(socket)
  socket.on('connect', () => socket.end(JSON.stringify(payload) + '\n'))
}

// A session whose plugin runs as its own process and reaches the hub through hub.sock.
async function plugin(thread: string, id = SESSION) {
  const socket = connect(join(dir, 'hub.sock'))
  sockets.push(socket)
  const received: any[] = []
  let buffer = ''
  socket.setEncoding('utf8')
  socket.on('data', (chunk: string) => {
    buffer += chunk
    const lines = buffer.split('\n')
    buffer = lines.pop()!
    received.push(...lines.map(line => JSON.parse(line)))
  })
  await new Promise(resolve => socket.on('connect', resolve))
  socket.write(JSON.stringify({ type: 'hello', thread, session: id }) + '\n')
  return { socket, received, send: (payload: object) => socket.write(JSON.stringify(payload) + '\n') }
}

// Claude's record of a background job, with the flags it restarts with: they read the thread's
// settings file, which binds the session to it. The job defaults to the session's short id, as
// Claude lists a job without one.
function bound(thread: string, id = SESSION, job = id.slice(0, 8), channel = CHANNEL) {
  mkdirSync(join(dir, 'jobs', job), { recursive: true })
  mkdirSync(join(dir, 'sessions'), { recursive: true })
  const settings = join(dir, 'sessions', `${encodeURIComponent(thread)}.json`)
  writeFileSync(settings, JSON.stringify({ enabledPlugins: {}, env: { HEX_CHANNEL: channel, HEX_THREAD: thread } }))
  writeFileSync(join(dir, 'jobs', job, 'state.json'), JSON.stringify({ state: 'working', sessionId: id, respawnFlags: ['--channels', channel, '--settings', settings] }))
}

function saved(id = SESSION, folder = join(dir, 'hex')) {
  const project = join(dir, 'projects', folder.replace(/[^a-zA-Z0-9]/g, '-'))
  mkdirSync(project, { recursive: true })
  writeFileSync(join(project, `${id}.jsonl`), '{}\n')
}

// A line of the session's transcript: a request that sent this much context, or a compaction down to it.
function said(tokens: number, compacted = false, id = SESSION, at = Date.now()) {
  const project = join(dir, 'projects', join(dir, 'hex').replace(/[^a-zA-Z0-9]/g, '-'))
  mkdirSync(project, { recursive: true })
  const line = compacted
    ? { type: 'system', subtype: 'compact_boundary', compactMetadata: { trigger: 'manual', preTokens: 0, postTokens: tokens } }
    : { type: 'assistant', message: { usage: { input_tokens: 2, cache_creation_input_tokens: 100, cache_read_input_tokens: tokens - 102 } } }
  appendFileSync(join(project, `${id}.jsonl`), JSON.stringify({ ...line, timestamp: new Date(at).toISOString() }) + '\n')
}

function settingsOf(args: string[]) {
  return JSON.parse(readFileSync(args[args.indexOf('--settings') + 1]!, 'utf8'))
}

// Without the digest of what each session started with, which only the renew tests look at.
function registry() {
  const threads = JSON.parse(readFileSync(join(dir, 'threads.json'), 'utf8'))
  for (const known of Object.values<any>(threads)) delete known.launched
  return threads
}

test('without a transcriber set up, a recording is never fetched or sent anywhere', async () => {
  delete process.env.TRANSCRIBE_URL
  delete process.env.TRANSCRIBE_MODEL
  let fetched = false
  expect(await transcribe(async () => (fetched = true, 'voice.oga'))).toBeUndefined()
  expect(fetched).toBe(false)
})

test('a message for a new thread starts a session bound to that thread', async () => {
  start()
  hub.deliver('chat:7', 'Desk anchors', message)
  const args = await launched()
  expect(args.slice(0, 5)).toEqual(['--bg', '--channels', CHANNEL, '--name', 'Desk anchors'])
  expect(args).not.toContain('--resume')
  expect(settingsOf(args).env).toEqual({ HEX_CHANNEL: CHANNEL, HEX_THREAD: 'chat:7', HEX_HUB: join(dir, 'hub.sock'), HEX_PORT: String(listener.port), HEX_TOKEN: readFileSync(join(dir, 'token'), 'utf8') })
  expect(states).toEqual([['chat:7', true]])
})

test('a new thread prompt comes last, where --channels cannot swallow it', async () => {
  start()
  hub.open('chat:8', 'OpenAI', 'find the latest model')
  const args = await launched()
  expect(args.at(-1)).toBe('find the latest model')
  expect(args.at(-3)).toBe('--settings')
})

test('queued messages reach the session when it says hello, and its id is kept', async () => {
  start()
  hub.deliver('chat:7', 'Desk anchors', message)
  await launched()
  saved()
  const { received } = await session('chat:7')
  await until(() => received.length)
  expect(received).toEqual([{ type: 'inbound', ...message }])
  expect(registry()['chat:7']).toEqual({ name: 'Desk anchors', session: SESSION })
})

test('a stopped thread has its job record cleared, then resumes under the same id', async () => {
  start({ registry: { 'chat:7': { name: 'Desk anchors', session: SESSION } }, agents: [] })
  hub.deliver('chat:7', 'Desk anchors', message)
  const args = await launched()
  expect(calls().filter(args => args[0] !== 'agents')[0]).toEqual(['rm', SESSION.slice(0, 8)])
  expect(args).toContain('--resume')
  expect(args[args.indexOf('--resume') + 1]).toBe(SESSION)
})

test('a thread whose session is still running is never relaunched', async () => {
  start({ registry: { 'chat:7': { name: 'Desk anchors', session: SESSION } }, agents: [{ sessionId: SESSION, pid: 42 }] })
  hub.deliver('chat:7', 'Desk anchors', message)
  await until(() => calls().length)
  await Bun.sleep(100)
  expect(calls().every(args => args[0] === 'agents')).toBe(true)
  const { received } = await session('chat:7')
  await until(() => received.length)
  expect(received[0].content).toBe('hi')
})

test('the main thread starts with the hub, under its name, with no prompt and no typing', async () => {
  start({ main: 'chat', general: true })
  const args = await launched()
  expect(args.slice(0, 5)).toEqual(['--bg', '--channels', CHANNEL, '--name', 'hex'])
  expect(args.at(-2)).toBe('--settings')
  expect(settingsOf(args).env.HEX_MAIN).toBe('1')
  expect(states).toEqual([])
})

test("only the hub whose main thread is hex's General marks it HEX_MAIN", async () => {
  start({ main: 'chat' })
  const args = await launched()
  expect(settingsOf(args).env.HEX_THREAD).toBe('chat')
  expect(settingsOf(args).env.HEX_MAIN).toBeUndefined()
})

test('a running main thread is left to reconnect, and gets its messages when it does', async () => {
  start({ main: 'chat', registry: { chat: { name: 'chat', session: SESSION } }, agents: [{ sessionId: SESSION, pid: 42 }] })
  hub.deliver('chat', 'hex', message)
  await until(() => calls().length)
  await Bun.sleep(100)
  expect(calls().every(args => args[0] === 'agents')).toBe(true)
  expect(registry().chat.name).toBe('hex')
  const { received } = await session('chat')
  await until(() => received.length)
  expect(received[0].content).toBe('hi')
})

test('a main thread whose session is gone is resumed again, and is never stopped for being idle', async () => {
  start({ main: 'chat', registry: { chat: { name: 'hex', session: SESSION } }, agents: [{ sessionId: SESSION, pid: 42 }], reconnect: 50, idleStop: 20 })
  const { close, send } = await session('chat')
  send({ type: 'state', thread: 'chat', busy: false })
  await Bun.sleep(100)
  expect(calls().filter(args => args[0] === 'stop')).toEqual([])
  writeFileSync(join(dir, 'agents'), '[]')
  close()
  const args = await launched()
  expect(args[args.indexOf('--resume') + 1]).toBe(SESSION)
})

test('a session that dies before its conversation is saved leaves the thread on its last saved one', async () => {
  const OLD = SESSION
  const NEW = '4460ed71-0000-4000-8000-000000000000'
  saved(OLD)
  start({ main: 'chat', registry: { chat: { name: 'hex', session: OLD } }, agents: [], reconnect: 50 })
  await launched()
  const { close } = await session('chat', NEW)
  await Bun.sleep(50)
  expect(registry().chat.session).toBe(OLD)
  close()
  await until(() => calls().filter(args => args[0] === '--bg').length === 2)
  const args = calls().filter(args => args[0] === '--bg')[1]!
  expect(args[args.indexOf('--resume') + 1]).toBe(OLD)
  const back = await session('chat', OLD)
  back.close()
  await until(() => calls().filter(args => args[0] === '--bg').length === 3)
  const next = await session('chat', NEW)
  saved(NEW)
  next.send({ type: 'state', thread: 'chat', busy: false })
  await until(() => registry().chat.session === NEW)
  hub.stop('chat')
  expect(await until(() => calls().find(args => args[0] === 'stop'))).toEqual(['stop', NEW.slice(0, 8)])
})

test('tool calls act on the calling session\'s own thread', async () => {
  start()
  const { call } = await session('chat:9')
  expect(await call('reply', { text: 'yo' })).toEqual({ content: [{ type: 'text', text: 'reply in chat:9' }] })
  const legacy = await plugin('chat:10')
  legacy.send({ type: 'call', id: 1, tool: 'reply', args: { text: 'yo' } })
  await until(() => legacy.received.length)
  expect(legacy.received[0]).toEqual({ type: 'result', id: 1, text: 'reply in chat:10' })
})

test('a permission prompt reaches the client with its thread, and the answer goes back to that session alone', async () => {
  start()
  const desk = await session('chat:9')
  const other = await session('chat:10')
  const request = { request_id: 'abcde', tool_name: 'Bash', description: 'List files', input_preview: '{"command":"ls"}' }
  await desk.ask(request)
  const [thread, asked] = await until(() => prompts[0])
  expect(thread).toBe('chat:9')
  expect(asked).toMatchObject(request)
  hub.answer('chat:9', 'abcde', 'allow')
  await until(() => desk.received.length)
  expect(desk.received).toEqual([{ type: 'permission', request_id: 'abcde', behavior: 'allow' }])
  expect(other.received).toEqual([])
})

test('a dropped channel that comes back while Claude Code reconnects it leaves its session running', async () => {
  start({ registry: { 'chat:7': { name: 'Desk anchors', session: SESSION } }, reconnect: 100 })
  writeFileSync(join(dir, 'agents'), JSON.stringify([{ sessionId: SESSION, pid: 42, startedAt: Date.now() }]))
  const first = await session('chat:7')
  first.close()
  await Bun.sleep(30)
  const back = await session('chat:7')
  await Bun.sleep(200)
  expect(calls().filter(args => args[0] !== 'agents')).toEqual([])
  hub.deliver('chat:7', 'Desk anchors', message)
  await until(() => back.received.length)
})

test('a session still running once its channel stays gone restarts in place, and gets what waited when it reconnects', async () => {
  bound('chat:7')
  start({ registry: { 'chat:7': { name: 'Desk anchors', session: SESSION } }, reconnect: 50 })
  writeFileSync(join(dir, 'agents'), JSON.stringify([{ sessionId: SESSION, pid: 42, startedAt: Date.now() }]))
  const { close } = await session('chat:7')
  close()
  expect(await until(() => calls().find(args => args[0] === 'respawn'))).toEqual(['respawn', SESSION.slice(0, 8)])
  expect(JSON.parse(readFileSync(join(dir, 'sessions', 'chat%3A7.json'), 'utf8')).env.HEX_TOKEN).toBe(readFileSync(join(dir, 'token'), 'utf8'))
  hub.deliver('chat:7', 'Desk anchors', message)
  const back = await session('chat:7')
  await until(() => back.received.length)
  expect(back.received[0].content).toBe('hi')
  await Bun.sleep(150)
  expect(calls().filter(args => args[0] === 'respawn').length).toBe(1)
  expect(failures).toEqual([])
})

test('a session that restarts in place and still gets no channel is reported, not restarted again', async () => {
  bound('chat:7')
  start({ registry: { 'chat:7': { name: 'Desk anchors', session: SESSION } }, reconnect: 50 })
  writeFileSync(join(dir, 'agents'), JSON.stringify([{ sessionId: SESSION, pid: 42, startedAt: Date.now() }]))
  const { close } = await session('chat:7')
  close()
  await until(() => calls().find(args => args[0] === 'respawn'))
  writeFileSync(join(dir, 'agents'), JSON.stringify([{ sessionId: SESSION, pid: 43, startedAt: Date.now() - 10 }]))
  expect(await until(() => failures[0])).toEqual(['chat:7', 'its session runs, but its channel never connects'])
  expect(calls().filter(args => args[0] === 'respawn').length).toBe(1)
})

test('a session that outlived the hub and never reconnects restarts in place', async () => {
  bound('chat:7')
  start({ registry: { 'chat:7': { name: 'Desk anchors', session: SESSION } }, agents: [{ sessionId: SESSION, pid: 42, startedAt: 1 }], reconnect: 50 })
  expect(await until(() => calls().find(args => args[0] === 'respawn'))).toEqual(['respawn', SESSION.slice(0, 8)])
})

test('a session found by the job it was started for restarts in place, though its conversation is not saved', async () => {
  bound('chat:7', '0a1b2c3d-0000-4000-8000-000000000009', 'job99999')
  start({ registry: { 'chat:7': { name: 'Desk anchors' } }, agents: [{ id: 'job99999', sessionId: '0a1b2c3d-0000-4000-8000-000000000009', pid: 42, startedAt: 1 }], reconnect: 50 })
  expect(await until(() => calls().find(args => args[0] === 'respawn'))).toEqual(['respawn', 'job99999'])
})

test('a message for a thread whose new session runs but has no conversation saved yet waits for that session instead of starting another', async () => {
  const NEW = '0a1b2c3d-0000-4000-8000-000000000009'
  bound('chat:7', NEW, 'job99999')
  start({ registry: { 'chat:7': { name: 'Desk anchors' } }, agents: [{ id: 'job99999', sessionId: NEW, pid: 42, startedAt: Date.now() + 60_000 }], reconnect: 60_000 })
  hub.deliver('chat:7', 'Desk anchors', message)
  await Bun.sleep(50)
  const { received } = await session('chat:7', NEW)
  await until(() => received.length)
  expect(calls().some(args => args[0] === '--bg')).toBe(false)
})

test('a message for a running session with no channel waits for it, and starts it again once it has ended', async () => {
  start({ registry: { 'chat:7': { name: 'Desk anchors', session: SESSION } }, agents: [{ sessionId: SESSION, pid: 42, startedAt: Date.now() + 60_000 }], reconnect: 50 })
  hub.deliver('chat:7', 'Desk anchors', message)
  await Bun.sleep(30)
  expect(calls().some(args => args[0] === '--bg')).toBe(false)
  writeFileSync(join(dir, 'agents'), '[]')
  const args = await launched()
  expect(args[args.indexOf('--resume') + 1]).toBe(SESSION)
  const { received } = await session('chat:7')
  await until(() => received.length)
  expect(received[0].content).toBe('hi')
})

test("a new session's channel opens once it lists the tools again after hearing they changed, since Claude Code listens for both at once", async () => {
  start()
  hub.deliver('chat:7', 'Desk anchors', message)
  await launched()
  writeFileSync(join(dir, 'jobs', 'job12345', 'state.json'), JSON.stringify({ state: 'working', sessionId: SESSION }))
  const line = http('chat:7')
  const { result } = await line.rpc('initialize', { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'test', version: '0' } })
  expect(result.capabilities.tools).toEqual({ listChanged: true })
  await line.initialize()
  await line.open()
  await Bun.sleep(50)
  expect(line.received).toEqual([])
  await line.rpc('tools/list')
  await until(() => line.listed() === 2)
  await until(() => line.received.length)
  expect(line.received).toEqual([{ type: 'inbound', ...message }])
})

test('a session starting cold that drops the first tools/list_changed is told again until it lists the tools', async () => {
  start()
  hub.deliver('chat:7', 'Desk anchors', message)
  await launched()
  const line = http('chat:7', {}, 2)
  await line.initialize()
  await line.open()
  await line.rpc('tools/list')
  await Bun.sleep(300)
  expect(line.listed()).toBe(1)
  expect(line.received).toEqual([])
  await until(() => line.received.length)
  expect(line.listed()).toBe(2)
  expect(line.received).toEqual([{ type: 'inbound', ...message }])
})

test('a session that lists the tools before opening its stream hears they changed once the stream opens', async () => {
  start()
  hub.deliver('chat:7', 'Desk anchors', message)
  await launched()
  const line = http('chat:7')
  await line.initialize()
  await line.rpc('tools/list')
  await Bun.sleep(50)
  await line.open()
  await until(() => line.listed() === 2)
  await until(() => line.received.length)
  expect(line.received).toEqual([{ type: 'inbound', ...message }])
})

test('a stream back from before the hub restarted carries on under its old id, without initializing again', async () => {
  start()
  const line = http('chat:7')
  const response = await line.open(crypto.randomUUID())
  expect(response.status).toBe(200)
  await Bun.sleep(20)
  hub.deliver('chat:7', 'Desk anchors', message)
  await until(() => line.received.length)
  expect(calls().some(args => args[0] === '--bg')).toBe(false)
  expect(await line.call('reply', { text: 'yo' })).toEqual({ content: [{ type: 'text', text: 'reply in chat:7' }] })
})

test('the hub declines the newest protocol, whose sessions get no channel, and offers one that has it', async () => {
  start()
  const line = http('chat:7')
  expect((await line.rpc('server/discover')).error.code).toBe(-32601)
  const { result } = await line.rpc('initialize', { protocolVersion: '2026-07-28', capabilities: {}, clientInfo: { name: 'test', version: '0' } })
  expect(result.protocolVersion).toBe('2025-11-25')
  expect(result.capabilities.experimental).toEqual({ 'claude/channel': {}, 'claude/channel/permission': {} })
  expect(result.instructions).toBe(SERVER.instructions)
})

test('a request from a web page, or by a name other than localhost, is refused', async () => {
  start()
  expect((await http('chat:7', { origin: 'https://example.com' }).post({ id: 1, method: 'ping' })).status).toBe(403)
  expect((await http('chat:7', { host: 'example.com' }).post({ id: 1, method: 'ping' })).status).toBe(403)
  expect((await http('chat:7').post({ id: 1, method: 'ping' })).status).toBe(200)
})

test("a request without the hub's token is refused, and the token is the owner's alone", async () => {
  start()
  expect((await http('chat:7', { authorization: 'Bearer guess' }).post({ id: 1, method: 'ping' })).status).toBe(403)
  const { authorization: _, ...anonymous } = { authorization: '' }
  expect((await fetch(`http://127.0.0.1:${listener.port}/telegram`, { method: 'POST', headers: { 'content-type': 'application/json', ...anonymous }, body: '{"jsonrpc":"2.0","id":1,"method":"ping"}' })).status).toBe(403)
  expect(statSync(join(dir, 'token')).mode & 0o777).toBe(0o600)
  hub.deliver('chat:7', 'Desk anchors', message)
  const settings = (await launched()).at(-1)!
  expect(statSync(settings).mode & 0o777).toBe(0o600)
})

test("a session with no thread, or another channel's, gets no messages and acts on no thread", async () => {
  start()
  const unbound = http()
  await unbound.initialize()
  expect(await unbound.call('reply', { text: 'yo' })).toEqual({ content: [{ type: 'text', text: 'reply failed: this session is not bound to a Telegram thread (HEX_THREAD is unset)' }], isError: true })
  const other = http(undefined, { 'x-hex-channel': 'plugin:discord@hex', 'x-hex-thread': 'chat:7' })
  await other.initialize()
  await other.open()
  await other.rpc('tools/list')
  hub.deliver('chat:7', 'Desk anchors', message)
  await Bun.sleep(50)
  expect(other.received).toEqual([])
})

test('busy and idle from session hooks reach the client, and a dropped session is idle', async () => {
  start()
  const { close } = await session('chat:9')
  const hook = (busy: boolean) => connect(join(dir, 'hub.sock')).on('connect', function () {
    this.end(JSON.stringify({ type: 'state', thread: 'chat:9', busy }) + '\n')
  })
  hook(true)
  await until(() => states.length === 1)
  hook(false)
  await until(() => states.length === 2)
  close()
  await until(() => states.length === 3)
  expect(states).toEqual([['chat:9', true], ['chat:9', false], ['chat:9', false]])
})

test('an idle thread is stopped, and a busy one is not', async () => {
  start({ idleStop: 50 })
  hub.deliver('chat:7', 'Desk anchors', message)
  await launched()
  const { send } = await session('chat:7')
  send({ type: 'state', thread: 'chat:7', busy: false })
  send({ type: 'state', thread: 'chat:7', busy: true })
  await Bun.sleep(120)
  expect(calls().some(args => args[0] === 'stop')).toBe(false)
  send({ type: 'state', thread: 'chat:7', busy: false })
  const stop = await until(() => calls().find(args => args[0] === 'stop'))
  expect(stop).toEqual(['stop', SESSION.slice(0, 8)])
})

test('a session that starts without a prompt is stopped once idle', async () => {
  start({ idleStop: 50 })
  hub.open('chat:8', 'OpenAI')
  await launched()
  await session('chat:8')
  expect(await until(() => calls().find(args => args[0] === 'stop'))).toEqual(['stop', SESSION.slice(0, 8)])
})

test('an idle thread whose session Claude still reports busy is not stopped until it goes idle again', async () => {
  start({ idleStop: 50, registry: { 'chat:7': { name: 'Desk anchors', session: SESSION } }, agents: [{ sessionId: SESSION, pid: 42, status: 'busy' }] })
  const { send } = await session('chat:7')
  send({ type: 'state', thread: 'chat:7', busy: false })
  await until(() => calls().some(args => args[0] === 'agents'))
  await Bun.sleep(100)
  expect(calls().some(args => args[0] === 'stop')).toBe(false)
  writeFileSync(join(dir, 'agents'), JSON.stringify([{ sessionId: SESSION, pid: 42, status: 'idle' }]))
  send({ type: 'state', thread: 'chat:7', busy: false })
  expect(await until(() => calls().find(args => args[0] === 'stop'))).toEqual(['stop', SESSION.slice(0, 8)])
})

test('an idle thread with a big conversation compacts while its cache is warm, without showing as working, then stops', async () => {
  const old = Bun.spawn(['sleep', '30'])
  start({ idleStop: 50, compactAbove: 150_000, registry: { 'chat:7': { name: 'Desk anchors', session: SESSION } }, agents: [{ sessionId: SESSION, pid: old.pid, status: 'idle', startedAt: Date.now() + 60_000 }] })
  said(40_000)
  said(200_000)
  const first = await session('chat:7')
  first.send({ type: 'state', thread: 'chat:7', busy: false })
  expect(await until(() => calls().find(args => args[0] === 'stop'))).toEqual(['stop', SESSION.slice(0, 8)])
  writeFileSync(join(dir, 'agents'), '[]')
  first.close()
  old.kill()
  const args = await launched()
  expect(args[args.indexOf('--resume') + 1]).toBe(SESSION)
  expect(args.at(-1)).toBe('/compact')
  said(9_000, true)
  writeFileSync(join(dir, 'agents'), JSON.stringify([{ sessionId: SESSION, pid: 42, status: 'idle', startedAt: Date.now() + 60_000 }]))
  await session('chat:7')
  await until(() => calls().filter(args => args[0] === 'stop').length === 2)
  expect(calls().filter(args => args[0] === '--bg')).toHaveLength(1)
  expect(states.filter(([, busy]) => busy)).toEqual([])
})

test('an idle thread with a small conversation, or one leaving, stops without compacting', async () => {
  start({ idleStop: 50, compactAbove: 150_000, registry: { 'chat:7': { name: 'Desk anchors', session: SESSION } }, agents: [{ sessionId: SESSION, pid: 42, status: 'idle', startedAt: Date.now() + 60_000 }] })
  said(120_000)
  const { send } = await session('chat:7')
  send({ type: 'state', thread: 'chat:7', busy: false })
  await until(() => calls().find(args => args[0] === 'stop'))
  said(400_000)
  void hub.retire('chat:7')
  await until(() => calls().filter(args => args[0] === 'stop').length === 2)
  await Bun.sleep(100)
  expect(calls().some(args => args[0] === '--bg')).toBe(false)
})

test('the main thread compacts a big conversation before its cache goes cold, and otherwise keeps running', async () => {
  const old = Bun.spawn(['sleep', '30'])
  start({ main: 'chat', cacheWarm: 50, compactAbove: 150_000, reconnect: 60_000, registry: { chat: { name: 'hex', session: SESSION } }, agents: [{ sessionId: SESSION, pid: old.pid, status: 'idle', startedAt: Date.now() + 60_000 }] })
  said(100_000)
  const { send, close } = await session('chat')
  send({ type: 'state', thread: 'chat', busy: false })
  await Bun.sleep(200)
  expect(calls().some(args => args[0] === 'stop')).toBe(false)
  said(300_000)
  send({ type: 'state', thread: 'chat', busy: false })
  expect(await until(() => calls().find(args => args[0] === 'stop'))).toEqual(['stop', SESSION.slice(0, 8)])
  writeFileSync(join(dir, 'agents'), '[]')
  close()
  old.kill()
  const args = await launched()
  expect(args[args.indexOf('--resume') + 1]).toBe(SESSION)
  expect(args.at(-1)).toBe('/compact')
  expect(states.filter(([, busy]) => busy)).toEqual([])
})

test('a bad line from a session is dropped, and the lines after it still work', async () => {
  start()
  const { socket, received } = await plugin('chat:9')
  socket.write('not json\nnull\n' + JSON.stringify({ type: 'call', id: 1, tool: 'reply', args: {} }) + '\n')
  await until(() => received.length)
  expect(received[0]).toEqual({ type: 'result', id: 1, text: 'reply in chat:9' })
})

test('an unreadable threads.json is moved aside instead of overwritten, and a malformed thread is dropped', async () => {
  writeFileSync(join(dir, 'threads.json'), '{"chat:7": {"name": "Desk')
  start()
  const aside = await until(() => readdirSync(dir).find(file => file.startsWith('threads.json.corrupt-')))
  expect(readFileSync(join(dir, aside), 'utf8')).toBe('{"chat:7": {"name": "Desk')
  hub.close()
  start({ registry: { 'chat:7': { name: 'Desk anchors', session: SESSION }, 'chat:8': null, 'chat:9': { session: SESSION } } })
  expect(hub.find('chat:7')).toBe('chat:7')
  expect(hub.threads()).toEqual(['chat:7'])
  expect(() => hub.find('chat:8')).toThrow()
  expect(() => hub.find('chat:9')).toThrow()
})

test('a launcher that can\'t run fails the start instead of leaving it hanging', async () => {
  start({ launcher: join(dir, 'missing') })
  hub.deliver('chat:7', 'Desk anchors', message)
  await until(() => failures.length)
  expect(failures[0]![0]).toBe('chat:7')
  expect(states).toEqual([['chat:7', true], ['chat:7', false]])
})

test('a local open request starts a session for an existing topic with its prompt', async () => {
  start()
  connect(join(dir, 'hub.sock')).on('connect', function () {
    this.end(JSON.stringify({ type: 'open', thread: 'chat:5', name: 'Theo clips', prompt: 'pick it up' }) + '\n')
  })
  const args = await launched()
  expect(args.slice(3, 5)).toEqual(['--name', 'Theo clips'])
  expect(args.at(-1)).toBe('pick it up')
  expect(settingsOf(args).env.HEX_THREAD).toBe('chat:5')
})

test('a local inbound request reaches the thread like a message from the app', async () => {
  start({ registry: { 'chat:7': { name: 'Desk anchors', session: SESSION } }, agents: [{ sessionId: SESSION, pid: 42 }] })
  const { received } = await session('chat:7')
  connect(join(dir, 'hub.sock')).on('connect', function () {
    this.end(JSON.stringify({ type: 'inbound', thread: 'chat:7', ...message }) + '\n')
  })
  await until(() => received.length)
  expect(received).toEqual([{ type: 'inbound', ...message }])
})

test('a session that fails to start is reported with its reason, and the next message retries', async () => {
  start()
  hub.deliver('chat:7', 'Desk anchors', message)
  await launched()
  await Bun.sleep(50)
  writeFileSync(join(dir, 'jobs', 'job12345', 'state.json'), JSON.stringify({ state: 'failed', detail: 'exit 1 before init' }))
  await until(() => failures.length)
  expect(failures).toEqual([['chat:7', 'exit 1 before init']])
  expect(states).toEqual([['chat:7', true], ['chat:7', false]])
  hub.deliver('chat:7', 'Desk anchors', message)
  await until(() => calls().filter(args => args[0] === '--bg').length === 2)
})

test('a session that connects ends the watch, so a later failed state is ignored', async () => {
  start()
  hub.deliver('chat:7', 'Desk anchors', message)
  await launched()
  await session('chat:7')
  await Bun.sleep(50)
  writeFileSync(join(dir, 'jobs', 'job12345', 'state.json'), JSON.stringify({ state: 'failed', detail: 'later' }))
  await Bun.sleep(100)
  expect(failures).toEqual([])
})

test('stopping a thread ends its session now, and its next message resumes it', async () => {
  start({ registry: { 'chat:7': { name: 'Desk anchors', session: SESSION } } })
  const { close, send } = await session('chat:7')
  send({ type: 'state', thread: 'chat:7', busy: true })
  await until(() => states.length)
  hub.stop('chat:7')
  expect(await until(() => calls().find(args => args[0] === 'stop'))).toEqual(['stop', SESSION.slice(0, 8)])
  close()
  await until(() => states.length === 2)
  writeFileSync(join(dir, 'agents'), '[]')
  hub.deliver('chat:7', 'Desk anchors', message)
  const args = await launched()
  expect(args[args.indexOf('--resume') + 1]).toBe(SESSION)
  expect(registry()['chat:7']).toEqual({ name: 'Desk anchors', session: SESSION })
})

test('a thread\'s model and effort are kept, and a running session takes them by starting again with its next message', async () => {
  start({ registry: { 'chat:7': { name: 'Desk anchors', session: SESSION } }, agents: [{ sessionId: SESSION, status: 'idle' }] })
  const { received } = await session('chat:7')
  await Bun.sleep(50)
  hub.deliver('chat:7', 'Desk anchors', message)
  await until(() => received.length)
  hub.configure('chat:7', { model: 'claude-fable-5-1', effort: 'xhigh' })
  expect(registry()['chat:7']).toEqual({ name: 'Desk anchors', session: SESSION, model: 'claude-fable-5-1', effort: 'xhigh' })
  hub.deliver('chat:7', 'Desk anchors', { content: 'again', meta: {} })
  const args = await launched()
  expect([args[args.indexOf('--model') + 1], args[args.indexOf('--effort') + 1], args[args.indexOf('--resume') + 1]]).toEqual(['claude-fable-5-1', 'xhigh', SESSION])
  expect(received.map(payload => payload.content)).toEqual(['hi'])
  const fresh = await session('chat:7')
  await until(() => fresh.received.length)
  expect(fresh.received[0]).toMatchObject({ type: 'inbound', content: 'again' })
})

test('a fresh thread with no capacity starts a new session instead of resuming its last, and says so in its env', async () => {
  start({ registry: { dm: { name: 'DM', session: SESSION } }, agents: [], fresh: thread => thread === 'dm', capacity: 0 })
  hub.deliver('dm', 'DM', message)
  const args = await launched()
  expect(args).not.toContain('--resume')
  expect(calls().some(args => args[0] === 'rm')).toBe(false)
  expect(settingsOf(args).env).toEqual({ HEX_CHANNEL: CHANNEL, HEX_THREAD: 'dm', HEX_HUB: join(dir, 'hub.sock'), HEX_PORT: String(listener.port), HEX_TOKEN: readFileSync(join(dir, 'token'), 'utf8'), HEX_FRESH: '1' })
  saved(NEXT)
  const { received } = await session('dm', NEXT)
  await until(() => received.length)
  expect(registry().dm).toEqual({ name: 'DM', session: NEXT })
})

test('a message to a fresh thread with no capacity steers its session while Claude reports it working, and starts a new one once it is done', async () => {
  start({ registry: { dm: { name: 'DM', session: SESSION } }, agents: [{ sessionId: SESSION, pid: 999999, status: 'busy' }], fresh: thread => thread === 'dm', capacity: 0 })
  const { received, send } = await session('dm')
  await Bun.sleep(50)
  hub.deliver('dm', 'DM', message)
  await until(() => received.length)
  expect(received).toEqual([{ type: 'inbound', ...message }])
  said(50_000)
  writeFileSync(join(dir, 'agents'), JSON.stringify([{ sessionId: SESSION, pid: 999999, status: 'idle' }]))
  send({ type: 'state', thread: 'dm', busy: false })
  await until(() => states.length)
  hub.deliver('dm', 'DM', { content: 'next', meta: {} })
  expect(await until(() => calls().find(args => args[0] === 'stop'))).toEqual(['stop', SESSION.slice(0, 8)])
  const args = await launched()
  expect(args).not.toContain('--resume')
  expect(received).toHaveLength(1)
  const next = await session('dm', '0a1b2c3d-0000-4000-8000-000000000001')
  await until(() => next.received.length)
  expect(next.received[0]).toMatchObject({ type: 'inbound', content: 'next' })
})

test('a fresh thread keeps its session while it waits on a permission prompt or its turn is still running', async () => {
  start({ registry: { dm: { name: 'DM', session: SESSION } }, agents: [{ sessionId: SESSION, pid: 999999, state: 'blocked' }], fresh: thread => thread === 'dm' })
  const { received, send } = await session('dm')
  await Bun.sleep(50)
  hub.deliver('dm', 'DM', message)
  await until(() => received.length)
  writeFileSync(join(dir, 'agents'), JSON.stringify([{ sessionId: SESSION, pid: 999999, status: 'idle' }]))
  send({ type: 'state', thread: 'dm', busy: true })
  await until(() => states.length)
  hub.deliver('dm', 'DM', { content: 'more', meta: {} })
  await until(() => received.length === 2)
  expect(calls().some(args => args[0] === 'stop' || args[0] === '--bg')).toBe(false)
})

const NEXT = '0a1b2c3d-0000-4000-8000-000000000001'
const dm = (agents: object[], options: { capacity?: number; cacheWarm?: number; idleStop?: number; compactAbove?: number; reconnect?: number; stale?: boolean } = {}) =>
  start({ registry: { dm: { name: 'DM', session: SESSION } }, agents, fresh: thread => thread === 'dm', capacity: 1000, ...options })

test('a fresh thread\'s warm session takes every message as it comes, and stays up while it rests', async () => {
  dm([{ sessionId: SESSION, pid: 999999, status: 'idle', startedAt: Date.now() + 60_000 }], { idleStop: 10 })
  said(500)
  const { received, send } = await session('dm')
  await Bun.sleep(50)
  hub.deliver('dm', 'DM', message)
  send({ type: 'state', thread: 'dm', busy: false })
  await until(() => states.length)
  hub.deliver('dm', 'DM', { content: 'next', meta: {} })
  await until(() => received.length === 2)
  await Bun.sleep(100)
  expect(calls().some(args => args[0] === 'stop' || args[0] === '--bg')).toBe(false)
})

test('a fresh thread whose session stopped starts a new one, warm or not, since a start rewrites its view past the cache', async () => {
  dm([])
  said(500)
  hub.deliver('dm', 'DM', message)
  expect(await launched()).not.toContain('--resume')
  expect(calls().some(args => args[0] === 'rm')).toBe(false)
})

test('a fresh thread\'s session that fills up hands over at the rest the Stop hook reports, though Claude still calls it busy', async () => {
  const old = Bun.spawn(['sleep', '30'])
  dm([{ sessionId: SESSION, pid: old.pid, status: 'busy', startedAt: Date.now() + 60_000 }])
  const first = await session('dm')
  await Bun.sleep(50)
  said(1500)
  first.send({ type: 'state', thread: 'dm', busy: false })
  expect(await until(() => calls().find(args => args[0] === 'stop'))).toEqual(['stop', SESSION.slice(0, 8)])
  first.close()
  old.kill()
  expect(await launched()).not.toContain('--resume')
})

test('a fresh thread\'s session on a five-minute cache hands over five minutes after its last request, not an hour', async () => {
  const old = Bun.spawn(['sleep', '30'])
  dm([{ sessionId: SESSION, pid: old.pid, status: 'idle', startedAt: Date.now() + 60_000 }], { cacheWarm: 60_000 })
  const project = join(dir, 'projects', join(dir, 'hex').replace(/[^a-zA-Z0-9]/g, '-'))
  mkdirSync(project, { recursive: true })
  const usage = { input_tokens: 2, cache_creation_input_tokens: 100, cache_read_input_tokens: 398, cache_creation: { ephemeral_5m_input_tokens: 100, ephemeral_1h_input_tokens: 0 } }
  appendFileSync(join(project, `${SESSION}.jsonl`), JSON.stringify({ type: 'assistant', message: { usage }, timestamp: new Date(Date.now() - 4800).toISOString() }) + '\n')
  const first = await session('dm')
  first.send({ type: 'state', thread: 'dm', busy: false })
  await until(() => calls().find(args => args[0] === 'stop'))
  first.close()
  old.kill()
  expect(await launched()).not.toContain('--resume')
})

test('once a fresh thread\'s session is full, a new one takes over as soon as it rests, before the next message', async () => {
  const old = Bun.spawn(['sleep', '30'])
  dm([{ sessionId: SESSION, pid: old.pid, status: 'busy', startedAt: Date.now() + 60_000 }])
  const first = await session('dm')
  await Bun.sleep(50)
  hub.deliver('dm', 'DM', message)
  await until(() => first.received.length)
  said(1500)
  writeFileSync(join(dir, 'agents'), JSON.stringify([{ sessionId: SESSION, pid: old.pid, status: 'idle', startedAt: Date.now() + 60_000 }]))
  first.send({ type: 'state', thread: 'dm', busy: false })
  expect(await until(() => calls().find(args => args[0] === 'stop'))).toEqual(['stop', SESSION.slice(0, 8)])
  first.close()
  old.kill()
  const args = await launched()
  expect(args).not.toContain('--resume')
  expect(args.at(-2)).toBe('--settings')
  const next = await session('dm', NEXT)
  await Bun.sleep(50)
  hub.deliver('dm', 'DM', { content: 'next', meta: {} })
  await until(() => next.received.length)
  expect(next.received[0]).toMatchObject({ type: 'inbound', content: 'next' })
  expect(first.received).toHaveLength(1)
})

test('a fresh thread\'s session hands over when its cache expires, timed from its last request', async () => {
  const old = Bun.spawn(['sleep', '30'])
  dm([{ sessionId: SESSION, pid: old.pid, status: 'idle', startedAt: Date.now() + 60_000 }], { cacheWarm: 400 })
  said(500, false, SESSION, Date.now() - 200)
  const first = await session('dm')
  const rested = Date.now()
  first.send({ type: 'state', thread: 'dm', busy: false })
  await until(() => calls().find(args => args[0] === 'stop'))
  expect(Date.now() - rested).toBeGreaterThanOrEqual(150)
  expect(Date.now() - rested).toBeLessThan(350)
  first.close()
  old.kill()
  expect(await launched()).not.toContain('--resume')
})

test('a message that finds a fresh thread\'s session gone cold goes to a new one', async () => {
  const old = Bun.spawn(['sleep', '30'])
  dm([{ sessionId: SESSION, pid: old.pid, status: 'idle', startedAt: Date.now() + 60_000 }], { cacheWarm: 60_000 })
  said(500, false, SESSION, Date.now() - 61_000)
  const first = await session('dm')
  await until(() => calls().find(args => args[0] === 'stop'))
  hub.deliver('dm', 'DM', message)
  first.close()
  old.kill()
  expect(await launched()).not.toContain('--resume')
  const next = await session('dm', NEXT)
  await until(() => next.received.length)
  expect(next.received[0]).toMatchObject({ type: 'inbound', ...message })
  expect(first.received).toHaveLength(0)
})

test('a fresh thread never compacts or idles out, however big its session', async () => {
  dm([{ sessionId: SESSION, pid: 999999, status: 'idle', startedAt: Date.now() + 60_000 }], { capacity: 400_000, compactAbove: 150_000, idleStop: 20 })
  said(200_000)
  const { send } = await session('dm')
  send({ type: 'state', thread: 'dm', busy: false })
  await until(() => states.length)
  await Bun.sleep(150)
  expect(calls().filter(args => args[0] !== 'agents')).toEqual([])
})

test('a fresh thread\'s warm session that started with what the hub no longer gives starts over as a new one at its rest', async () => {
  const old = Bun.spawn(['sleep', '30'])
  dm([{ sessionId: SESSION, pid: old.pid, status: 'idle', startedAt: 1 }], { stale: true })
  said(500)
  const first = await session('dm')
  expect(await until(() => calls().find(args => args[0] === 'stop'))).toEqual(['stop', SESSION.slice(0, 8)])
  writeFileSync(join(dir, 'agents'), '[]')
  first.close()
  old.kill()
  expect(await launched()).not.toContain('--resume')
})

test('a warm DM session the last hub started but never saved takes the next message, and hands over in its turn, instead of a second session', async () => {
  bound('dm', NEXT, 'job99999')
  dm([{ id: 'job99999', sessionId: NEXT, pid: 42, status: 'idle', startedAt: Date.now() + 60_000 }], { reconnect: 60_000 })
  hub.deliver('dm', 'DM', message)
  await Bun.sleep(50)
  const { received, send } = await session('dm', NEXT)
  await until(() => received.length)
  expect(hub.session('dm')).toBe(NEXT)
  said(1500, false, NEXT)
  send({ type: 'state', thread: 'dm', busy: false })
  expect(await until(() => calls().find(args => args[0] === 'stop'))).toEqual(['stop', NEXT.slice(0, 8)])
  expect(calls().some(args => args[0] === '--bg')).toBe(false)
})

test('a thread that asks to renew starts over as a new session once its turn ends', async () => {
  const old = Bun.spawn(['sleep', '30'])
  start({ main: 'voice', registry: { voice: { name: 'voice', session: SESSION } }, agents: [{ sessionId: SESSION, pid: old.pid, status: 'idle' }], reconnect: 60_000, fresh: () => true, capacity: 0 })
  const { send } = await session('voice')
  send({ type: 'state', thread: 'voice', busy: true })
  send({ type: 'renew', thread: 'voice' })
  await Bun.sleep(100)
  expect(calls().some(args => args[0] === 'stop' || args[0] === '--bg')).toBe(false)
  send({ type: 'state', thread: 'voice', busy: false })
  expect(await until(() => calls().find(args => args[0] === 'stop'))).toEqual(['stop', SESSION.slice(0, 8)])
  old.kill()
  expect(await launched()).not.toContain('--resume')
})

test('a renew waits out background agents the turn ended with, then starts over at the next idle', async () => {
  const old = Bun.spawn(['sleep', '30'])
  start({ main: 'voice', registry: { voice: { name: 'voice', session: SESSION } }, agents: [{ sessionId: SESSION, pid: old.pid, status: 'busy' }], reconnect: 60_000, fresh: () => true, capacity: 0 })
  const { send } = await session('voice')
  send({ type: 'renew', thread: 'voice' })
  send({ type: 'state', thread: 'voice', busy: false, background: true })
  await Bun.sleep(150)
  expect(calls().some(args => args[0] === 'stop' || args[0] === '--bg')).toBe(false)
  send({ type: 'state', thread: 'voice', busy: false })
  await until(() => calls().find(args => args[0] === 'stop'))
  old.kill()
  expect(await launched()).not.toContain('--resume')
})

test('a renew goes through at a rest the Stop hook reports, though Claude still calls the session busy (its status lags, and a running shell counts)', async () => {
  const old = Bun.spawn(['sleep', '30'])
  start({ main: 'voice', registry: { voice: { name: 'voice', session: SESSION } }, agents: [{ sessionId: SESSION, pid: old.pid, status: 'busy' }], reconnect: 60_000, fresh: () => true, capacity: 0 })
  const { send } = await session('voice')
  send({ type: 'state', thread: 'voice', busy: true })
  send({ type: 'renew', thread: 'voice' })
  send({ type: 'state', thread: 'voice', busy: false })
  expect(await until(() => calls().find(args => args[0] === 'stop'))).toEqual(['stop', SESSION.slice(0, 8)])
  old.kill()
  expect(await launched()).not.toContain('--resume')
})

test('a session that started with what the hub no longer gives and runs a shell renews only once Claude reports it idle, since it never asked', async () => {
  start({ stale: true, registry: { 'chat:7': { name: 'Desk anchors', session: SESSION } }, agents: [{ sessionId: SESSION, pid: 42, status: 'busy', startedAt: 1 }] })
  const { send } = await session('chat:7')
  send({ type: 'state', thread: 'chat:7', busy: false })
  await Bun.sleep(150)
  expect(calls().some(args => args[0] === 'stop')).toBe(false)
})

test('a call that comes while a renew is on its way waits for the new session to say hello', async () => {
  const old = Bun.spawn(['sleep', '30'])
  start({ main: 'voice', registry: { voice: { name: 'voice', session: SESSION } }, agents: [{ sessionId: SESSION, pid: old.pid, status: 'busy' }], reconnect: 60_000, fresh: () => true, capacity: 0 })
  let through = false
  await hub.renewal('voice')
  const { send } = await session('voice')
  send({ type: 'state', thread: 'voice', busy: true })
  send({ type: 'renew', thread: 'voice' })
  await Bun.sleep(50)
  void hub.renewal('voice').then(() => (through = true))
  send({ type: 'state', thread: 'voice', busy: false })
  await until(() => calls().find(args => args[0] === 'stop'))
  old.kill()
  await launched()
  await Bun.sleep(50)
  expect(through).toBe(false)
  await session('voice', '0a1b2c3d-0000-4000-8000-000000000009')
  await until(() => through)
})

test('a call waits for no renew held up by background agents, or called off by a call already in the session', async () => {
  start({ main: 'voice', registry: { voice: { name: 'voice', session: SESSION } }, agents: [{ sessionId: SESSION, pid: 42, status: 'busy' }], reconnect: 60_000, fresh: () => true, capacity: 0 })
  let through = 0
  const { send } = await session('voice')
  send({ type: 'state', thread: 'voice', busy: true })
  send({ type: 'renew', thread: 'voice' })
  await Bun.sleep(50)
  void hub.renewal('voice').then(() => through++)
  send({ type: 'state', thread: 'voice', busy: false, background: true })
  await until(() => through === 1)
  send({ type: 'state', thread: 'voice', busy: true })
  send({ type: 'renew', thread: 'voice' })
  await Bun.sleep(50)
  void hub.renewal('voice').then(() => through++)
  send({ type: 'keep', thread: 'voice' })
  await until(() => through === 2)
  expect(calls().some(args => args[0] === 'stop')).toBe(false)
})

test('a fresh main thread still running when the hub starts is left to reconnect instead of getting a second session', async () => {
  start({ main: 'voice', registry: { voice: { name: 'voice', session: SESSION } }, agents: [{ sessionId: SESSION, pid: 42, status: 'idle' }], reconnect: 150, fresh: () => true, capacity: 0 })
  await Bun.sleep(50)
  await session('voice')
  await Bun.sleep(250)
  expect(calls().some(args => args[0] === '--bg')).toBe(false)
})

test('a fresh main thread whose newest session is still running but not yet saved is left to reconnect too', async () => {
  bound('voice', '0a1b2c3d-0000-4000-8000-000000000009', 'job99999')
  start({ main: 'voice', registry: { voice: { name: 'voice', session: SESSION } }, agents: [{ id: 'job99999', sessionId: '0a1b2c3d-0000-4000-8000-000000000009', pid: 43 }], reconnect: 150, fresh: () => true, capacity: 0 })
  await Bun.sleep(50)
  await session('voice', '0a1b2c3d-0000-4000-8000-000000000009')
  await Bun.sleep(250)
  expect(calls().some(args => args[0] === '--bg')).toBe(false)
})

test('a fresh main thread whose session is gone when the hub starts gets a new one at once', async () => {
  start({ main: 'voice', registry: { voice: { name: 'voice', session: SESSION } }, agents: [], reconnect: 60_000, fresh: () => true, capacity: 0 })
  expect(await launched()).not.toContain('--resume')
})

test('a thread that asked to renew keeps running when it asks to keep before its turn ends (a new call started)', async () => {
  start({ main: 'voice', registry: { voice: { name: 'voice', session: SESSION } }, agents: [{ sessionId: SESSION, pid: 42, status: 'idle' }], reconnect: 50, fresh: () => true, capacity: 0 })
  const { send } = await session('voice')
  send({ type: 'state', thread: 'voice', busy: true })
  send({ type: 'renew', thread: 'voice' })
  send({ type: 'keep', thread: 'voice' })
  send({ type: 'state', thread: 'voice', busy: false })
  await Bun.sleep(150)
  expect(calls().some(args => args[0] === 'stop')).toBe(false)
})

test('a session that started with what the hub no longer gives stops at its next rest, so its next message resumes it on the current code', async () => {
  start({ stale: true, registry: { 'chat:7': { name: 'Desk anchors', session: SESSION } }, agents: [{ sessionId: SESSION, pid: 42, status: 'busy', startedAt: 1 }] })
  const { send } = await session('chat:7')
  await Bun.sleep(150)
  expect(calls().some(args => args[0] === 'stop')).toBe(false)
  writeFileSync(join(dir, 'agents'), JSON.stringify([{ sessionId: SESSION, pid: 42, status: 'idle', startedAt: 1 }]))
  send({ type: 'state', thread: 'chat:7', busy: false })
  expect(await until(() => calls().find(args => args[0] === 'stop'))).toEqual(['stop', SESSION.slice(0, 8)])
  expect(calls().some(args => args[0] === '--bg')).toBe(false)
})

test('a change to only the hooks a session loads renews it at its next rest', async () => {
  const hooks = join(dir, 'hooks.json')
  writeFileSync(hooks, '{"hooks":{}}')
  const launched = stamp([], SERVER, [hooks])
  expect(stamp([], SERVER, [hooks])).toBe(launched)
  writeFileSync(hooks, '{"hooks":{"Stop":[]}}')
  expect(stamp([], SERVER, [hooks])).not.toBe(launched)
  start({ hooks: [hooks], registry: { 'chat:7': { name: 'Desk anchors', session: SESSION, launched } }, agents: [{ sessionId: SESSION, pid: 42, status: 'idle', startedAt: 1 }] })
  const { send } = await session('chat:7')
  send({ type: 'state', thread: 'chat:7', busy: false })
  expect(await until(() => calls().find(args => args[0] === 'stop'))).toEqual(['stop', SESSION.slice(0, 8)])
})

test('a session whose hooks are unchanged keeps running across a hub restart', async () => {
  const hooks = join(dir, 'hooks.json')
  writeFileSync(hooks, '{"hooks":{}}')
  start({ hooks: [hooks], registry: { 'chat:7': { name: 'Desk anchors', session: SESSION, launched: stamp([], SERVER, [hooks]) } }, agents: [{ sessionId: SESSION, pid: 42, status: 'idle', startedAt: 1 }] })
  const { send } = await session('chat:7')
  send({ type: 'state', thread: 'chat:7', busy: false })
  await Bun.sleep(150)
  expect(calls().some(args => args[0] === 'stop')).toBe(false)
})

test('a main thread whose session started with what the hub no longer gives starts over as soon as it rests', async () => {
  const old = Bun.spawn(['sleep', '30'])
  start({ stale: true, main: 'chat', registry: { chat: { name: 'hex', session: SESSION } }, agents: [{ sessionId: SESSION, pid: old.pid, status: 'idle', startedAt: 1 }], reconnect: 60_000 })
  await session('chat')
  expect(await until(() => calls().find(args => args[0] === 'stop'))).toEqual(['stop', SESSION.slice(0, 8)])
  writeFileSync(join(dir, 'agents'), '[]')
  old.kill()
  expect(await launched()).toContain('--resume')
})

test('a session that started with what the hub still gives keeps running across a hub restart, however old', async () => {
  start({ registry: { 'chat:7': { name: 'Desk anchors', session: SESSION } }, agents: [{ sessionId: SESSION, pid: 42, status: 'idle', startedAt: 1 }] })
  const { send } = await session('chat:7')
  send({ type: 'state', thread: 'chat:7', busy: false })
  await Bun.sleep(150)
  expect(calls().some(args => args[0] === 'stop')).toBe(false)
})

test('a session records what it started with, and the hub tells a change of arguments or channel from a plain restart', async () => {
  start({ registry: { 'chat:7': { name: 'Desk anchors' } }, stale: true, agents: [] })
  hub.deliver('chat:7', 'Desk anchors', message)
  await launched()
  const launched_ = JSON.parse(readFileSync(join(dir, 'threads.json'), 'utf8'))['chat:7'].launched
  expect(launched_).toBe(stamp([], SERVER))
  expect(stamp(['--model', 'opus'], SERVER)).not.toBe(launched_)
  expect(stamp([], { ...SERVER, instructions: 'new' })).not.toBe(launched_)
  expect(stamp([])).not.toBe(launched_)
})

test('a voice session that started with what the hub no longer gives waits out its call before starting over', async () => {
  start({ stale: true, main: 'voice', registry: { voice: { name: 'voice', session: SESSION } }, agents: [{ sessionId: SESSION, pid: 42, status: 'busy', startedAt: 1 }], reconnect: 60_000, fresh: () => true, capacity: 0 })
  const { send } = await session('voice')
  send({ type: 'keep', thread: 'voice' })
  await Bun.sleep(100)
  writeFileSync(join(dir, 'agents'), JSON.stringify([{ sessionId: SESSION, pid: EXITED, status: 'idle', startedAt: 1 }]))
  send({ type: 'state', thread: 'voice', busy: false })
  await Bun.sleep(150)
  expect(calls().some(args => args[0] === 'stop')).toBe(false)
  send({ type: 'renew', thread: 'voice' })
  send({ type: 'state', thread: 'voice', busy: false })
  await until(() => calls().find(args => args[0] === 'stop'))
})

test('a restart waits for every call to hang up, or for its session to go', async () => {
  start({ main: 'voice', registry: { voice: { name: 'voice', session: SESSION } }, reconnect: 60_000, fresh: () => true, capacity: 0 })
  let freed = false
  await free()
  const first = await session('voice')
  first.send({ type: 'keep', thread: 'voice' })
  await Bun.sleep(50)
  void free().then(() => (freed = true))
  await Bun.sleep(50)
  expect(freed).toBe(false)
  first.send({ type: 'renew', thread: 'voice' })
  await until(() => freed)
  freed = false
  const second = await session('voice')
  second.send({ type: 'keep', thread: 'voice' })
  await Bun.sleep(50)
  void free().then(() => (freed = true))
  second.close()
  await until(() => freed)
})

test('closing an idle thread stops its session right away, then forgets the thread', async () => {
  start({ registry: { 'chat:7': { name: 'Desk anchors', session: SESSION } } })
  const { close } = await session('chat:7')
  await Bun.sleep(50)
  void hub.retire('chat:7')
  expect(await until(() => calls().find(args => args[0] === 'stop'))).toEqual(['stop', SESSION.slice(0, 8)])
  expect(registry()['chat:7']).toBeDefined()
  close()
  await until(() => !registry()['chat:7'])
})

test("a forgotten thread's settings file goes with it", async () => {
  start()
  hub.deliver('chat:7', 'Desk anchors', message)
  const settings = (await launched()).at(-1)!
  const { close, send } = await session('chat:7')
  expect(existsSync(settings)).toBe(true)
  send({ type: 'state', thread: 'chat:7', busy: false })
  await until(() => states.length === 2)
  void hub.retire('chat:7')
  await until(() => calls().find(args => args[0] === 'stop'))
  close()
  await until(() => !existsSync(settings))
})

test('a session whose flags read no settings file of the hub stops and resumes once its channel stays gone, since a respawn would lose its binding', async () => {
  const old = Bun.spawn(['sleep', '30'])
  start({ registry: { 'chat:7': { name: 'Desk anchors', session: SESSION } }, agents: [{ sessionId: SESSION, pid: old.pid, startedAt: 1 }], reconnect: 50 })
  expect(await until(() => calls().find(args => args[0] === 'stop'))).toEqual(['stop', SESSION.slice(0, 8)])
  writeFileSync(join(dir, 'agents'), '[]')
  old.kill()
  const args = await launched()
  expect(args[args.indexOf('--resume') + 1]).toBe(SESSION)
  expect(calls().some(args => args[0] === 'respawn')).toBe(false)
})

test('HEX_CHAT_CAPACITY may be 0, and must be a number', async () => {
  const load = (tokens: string) => Bun.spawnSync(['bun', '-e', `import(${JSON.stringify(join(import.meta.dir, 'hub.ts'))}).then(() => console.log('ok'))`], { env: { ...process.env, HEX_CHAT_CAPACITY: tokens } })
  expect(load('0').stdout.toString()).toBe('ok\n')
  expect(load('lots').stderr.toString()).toContain('HEX_CHAT_CAPACITY must be a number of tokens, got "lots"')
})

test('closing a thread with no live session forgets it at once', () => {
  start({ registry: { 'chat:7': { name: 'Desk anchors', session: SESSION } } })
  void hub.retire('chat:7')
  expect(registry()['chat:7']).toBeUndefined()
  expect(calls()).toEqual([])
})

test('closing a thread whose session Claude reports busy waits for its next idle', async () => {
  start({ registry: { 'chat:7': { name: 'Desk anchors', session: SESSION } }, agents: [{ sessionId: SESSION, pid: 42, status: 'busy' }] })
  const { send } = await session('chat:7')
  await Bun.sleep(50)
  void hub.retire('chat:7')
  await until(() => calls().some(args => args[0] === 'agents'))
  await Bun.sleep(100)
  expect(calls().some(args => args[0] === 'stop')).toBe(false)
  send({ type: 'state', thread: 'chat:7', busy: false })
  await until(() => calls().find(args => args[0] === 'stop'))
})

test('closing a busy thread stops its session at its next idle, not before', async () => {
  start({ registry: { 'chat:7': { name: 'Desk anchors', session: SESSION } } })
  const { send } = await session('chat:7')
  send({ type: 'state', thread: 'chat:7', busy: true })
  await until(() => states.length)
  void hub.retire('chat:7')
  await Bun.sleep(100)
  expect(calls().some(args => args[0] === 'stop')).toBe(false)
  send({ type: 'state', thread: 'chat:7', busy: false })
  await until(() => calls().find(args => args[0] === 'stop'))
})

test("a client's own binding for a thread reaches its session's settings env, under the hub's own", async () => {
  start({ main: 'voice', bind: thread => ({ VOICE_SOCKET: `/run/${thread}.sock`, HEX_THREAD: 'not this' }) })
  expect(settingsOf(await launched()).env).toMatchObject({ VOICE_SOCKET: '/run/voice.sock', HEX_THREAD: 'voice' })
})

test('the main thread cannot be closed', () => {
  start({ main: 'chat' })
  expect(() => hub.retire('chat')).toThrow('the main thread stays open')
})

test('threads are found by name or id, and renames are kept', () => {
  start({ registry: { 'chat:7': { name: 'Desk anchors', session: SESSION }, 'chat:8': { name: 'Clips' } } })
  expect(hub.find('desk anchors')).toBe('chat:7')
  expect(hub.find('chat:8')).toBe('chat:8')
  expect(() => hub.find('Nope')).toThrow('no thread named "Nope"')
  hub.rename('chat:8', 'Theo clips')
  expect(hub.find('Theo clips')).toBe('chat:8')
  expect(hub.name('chat:8')).toBe('Theo clips')
  expect(hub.name('chat:9')).toBeUndefined()
  expect(registry()['chat:8'].name).toBe('Theo clips')
})

test('a session\'s settings enable only its channel plugin', async () => {
  start()
  hub.open('chat:7', 'Desk anchors', 'go')
  expect(Object.keys(settingsOf(await launched()))).toEqual(['enabledPlugins', 'env'])
  expect(settingsOf(await launched()).enabledPlugins).toEqual({ 'telegram@hex': true })
})

test('sessions start through the launcher, in the hex folder, with nothing of the hub\'s own in its env', async () => {
  const launcher = join(dir, 'launch')
  writeFileSync(launcher, `#!/bin/sh
pwd > "${dir}/cwd"
env | grep -c -e _BOT_TOKEN= -e ^HEX_ -e ^BUZZ_ > "${dir}/leaked"
exec claude "$@"
`)
  chmodSync(launcher, 0o755)
  process.env.TELEGRAM_BOT_TOKEN = 'secret'
  process.env.BUZZ_PRIVATE_KEY = 'secret'
  process.env.HEX_DIR = 'somewhere'
  try {
    start({ launcher })
    hub.open('chat:7', 'Desk anchors', 'go')
    await launched()
  } finally {
    delete process.env.TELEGRAM_BOT_TOKEN
    delete process.env.BUZZ_PRIVATE_KEY
    delete process.env.HEX_DIR
  }
  expect(readFileSync(join(dir, 'cwd'), 'utf8').trim()).toBe(join(dir, 'hex'))
  expect(readFileSync(join(dir, 'leaked'), 'utf8').trim()).toBe('0')
})

test('a thread opened in a project starts its session there, and keeps that folder when it resumes', async () => {
  const project = join(dir, 'project')
  mkdirSync(project)
  const launcher = join(dir, 'launch')
  writeFileSync(launcher, `#!/bin/sh
pwd >> "${dir}/cwd"
exec claude "$@"
`)
  chmodSync(launcher, 0o755)
  start({ launcher, agents: [] })
  hub.open('t3:1', 'project', undefined, project)
  await launched()
  saved(SESSION, project)
  const { close } = await session('t3:1')
  await until(() => existsSync(join(dir, 'threads.json')) && registry()['t3:1'])
  expect(registry()['t3:1']).toEqual({ name: 'project', cwd: project, session: SESSION })
  expect(hub.cwd('t3:1')).toBe(project)
  close()
  await until(() => states.some(([thread, busy]) => thread === 't3:1' && !busy))
  hub.deliver('t3:1', 'project', message)
  await until(() => readFileSync(join(dir, 'cwd'), 'utf8').split('\n').length > 2)
  expect(readFileSync(join(dir, 'cwd'), 'utf8').trim().split('\n')).toEqual([project, project])
})

test('a thread in the hex folder keeps no folder of its own', async () => {
  start()
  hub.open('chat:7', 'Desk anchors', 'go')
  await launched()
  saved()
  await session('chat:7')
  await until(() => existsSync(join(dir, 'threads.json')) && registry()['chat:7'])
  expect(registry()['chat:7']).toEqual({ name: 'Desk anchors', session: SESSION })
  expect(hub.cwd('chat:7')).toBeUndefined()
})

test('releasing an idle thread stops its session, then forgets it once the socket closes', async () => {
  start({ registry: { 'chat:7': { name: 'Desk anchors', session: SESSION } } })
  const { close } = await session('chat:7')
  await Bun.sleep(50)
  let released: string | undefined
  void hub.release('chat:7').then(id => (released = id))
  expect(await until(() => calls().find(args => args[0] === 'stop'))).toEqual(['stop', SESSION.slice(0, 8)])
  await Bun.sleep(50)
  expect(released).toBeUndefined()
  expect(registry()['chat:7']).toBeDefined()
  close()
  expect(await until(() => released)).toBe(SESSION)
  expect(registry()['chat:7']).toBeUndefined()
})

test('releasing a busy thread waits for its next idle', async () => {
  start({ registry: { 'chat:7': { name: 'Desk anchors', session: SESSION } } })
  const { close, send } = await session('chat:7')
  send({ type: 'state', thread: 'chat:7', busy: true })
  await until(() => states.length)
  let released: string | undefined
  void hub.release('chat:7').then(id => (released = id))
  await Bun.sleep(100)
  expect(calls().some(args => args[0] === 'stop')).toBe(false)
  send({ type: 'state', thread: 'chat:7', busy: false })
  await until(() => calls().find(args => args[0] === 'stop'))
  close()
  expect(await until(() => released)).toBe(SESSION)
  expect(registry()['chat:7']).toBeUndefined()
})

test('releasing a thread with no live session resolves at once', async () => {
  start({ registry: { 'chat:7': { name: 'Desk anchors', session: SESSION } } })
  expect(await hub.release('chat:7')).toBe(SESSION)
  expect(registry()['chat:7']).toBeUndefined()
  expect(calls()).toEqual([])
})

test('the main thread and a thread without a session cannot be released', () => {
  start({ main: 'chat', registry: { 'chat:8': { name: 'Clips' } } })
  expect(() => hub.release('chat')).toThrow('the main thread stays here')
  expect(() => hub.release('chat:8')).toThrow('this thread has no session yet')
})

test('an adopted thread clears the old job record, then resumes its session with the prompt last', async () => {
  start({ agents: [] })
  hub.adopt('chat:7', 'Desk anchors', SESSION, 'carry on')
  const args = await launched()
  expect(calls().filter(args => args[0] !== 'agents')[0]).toEqual(['rm', SESSION.slice(0, 8)])
  expect(args[args.indexOf('--resume') + 1]).toBe(SESSION)
  expect(args.at(-1)).toBe('carry on')
  expect(registry()['chat:7']).toEqual({ name: 'Desk anchors', session: SESSION })
})

test('an adopted thread keeps the folder its session ran in', async () => {
  start({ agents: [] })
  hub.adopt('chat:7', 'Desk anchors', SESSION, 'carry on', dir)
  await launched()
  expect(registry()['chat:7']).toEqual({ name: 'Desk anchors', session: SESSION, cwd: dir })
})

test('a fork resumes a copy of the session without checking agents or clearing its job record', async () => {
  start()
  hub.fork('chat:7', 'Desk anchors', SESSION, 'carry on')
  const args = await launched()
  const resume = args.indexOf('--resume')
  expect(args.slice(resume, resume + 3)).toEqual(['--resume', SESSION, '--fork-session'])
  expect(args.at(-1)).toBe('carry on')
  await Bun.sleep(50)
  expect(calls().map(args => args[0])).toEqual(['--bg'])
})

test('a buzz:// link becomes a web link that opens it, in plain text and in Markdown', () => {
  const link = 'buzz://message?channel=c-1&id=abc'
  const web = `https://hex-sand.vercel.app/open.html#${encodeURIComponent(link)}`
  expect(tappable(`see ${link}.`)).toBe(`see ${web}.`)
  expect(tappable(`open ${link}?`)).toBe(`open ${web}?`)
  expect(tappable(`[the thread](${link})`)).toBe(`[the thread](${web})`)
  expect(tappable('no links here')).toBe('no links here')
})

test("a session's stop hook reports whether background agents are still working, which shells don't count as", async () => {
  const socket = join(dir, 'state.sock')
  const received: object[] = []
  const server = createServer(client => client.on('data', chunk => received.push(JSON.parse(String(chunk))))).listen(socket)
  const stop = async (tasks: object[]) => {
    const hook = Bun.spawn(['bun', join(import.meta.dir, 'state.ts'), 'idle'], { env: { ...process.env, HEX_HUB: socket, HEX_THREAD: 't1' }, stdin: new Blob([JSON.stringify({ hook_event_name: 'Stop', background_tasks: tasks })]) })
    await hook.exited
  }
  await stop([{ type: 'subagent', status: 'running' }])
  await stop([{ type: 'shell', status: 'running' }])
  await until(() => received.length === 2 || undefined)
  server.close()
  expect(received).toEqual([{ type: 'state', thread: 't1', busy: false, background: true }, { type: 'state', thread: 't1', busy: false }])
})

test('a main thread whose new session ends before its channel connects is reported and started again', async () => {
  start({ main: 'chat', agents: [], reconnect: 50 })
  await launched()
  expect(await until(() => failures[0])).toEqual(['chat', 'its session ended before its channel connected'])
  await until(() => calls().filter(args => args[0] === '--bg').length === 2)
})

test('a thread whose new session ends before its channel connects is reported, and its next message starts it again', async () => {
  start({ registry: { 'chat:7': { name: 'Desk anchors', session: SESSION } }, agents: [], reconnect: 50 })
  hub.deliver('chat:7', 'Desk anchors', message)
  await launched()
  expect(await until(() => failures[0])).toEqual(['chat:7', 'its session ended before its channel connected'])
  hub.deliver('chat:7', 'Desk anchors', { ...message, content: 'again' })
  await until(() => calls().filter(args => args[0] === '--bg').length === 2)
  const { received } = await session('chat:7')
  await until(() => received.length === 2)
  expect(received.map(m => m.content)).toEqual(['hi', 'again'])
})

test('a session that restarts in place and then ends is reported, and the thread starts again on its next message', async () => {
  bound('chat:7')
  start({ registry: { 'chat:7': { name: 'Desk anchors', session: SESSION } }, reconnect: 50 })
  writeFileSync(join(dir, 'agents'), JSON.stringify([{ sessionId: SESSION, pid: 42, startedAt: Date.now() }]))
  const { close } = await session('chat:7')
  close()
  await until(() => calls().find(args => args[0] === 'respawn'))
  writeFileSync(join(dir, 'agents'), '[]')
  expect(await until(() => failures[0])).toEqual(['chat:7', 'its session ended before its channel connected'])
  hub.deliver('chat:7', 'Desk anchors', message)
  await launched()
})
