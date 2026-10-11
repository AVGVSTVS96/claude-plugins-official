import { afterEach, beforeEach, expect, test } from 'bun:test'
import { connect, type Socket } from 'net'
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, writeFileSync, chmodSync, existsSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { startHub, tappable, type Message, type Permission } from './hub.ts'

const CHANNEL = 'plugin:telegram@hex'
const SESSION = '0a1b2c3d-0000-4000-8000-000000000000'
const message: Message = { content: 'hi', meta: { chat_id: '1' } }

let dir: string
let hub: ReturnType<typeof startHub>
let states: [string, boolean][]
let failures: [string, string][]
let prompts: [string, Permission][]
const sockets: Socket[] = []

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'hub-'))
  mkdirSync(join(dir, 'hex'), { recursive: true })
  mkdirSync(join(dir, 'jobs', 'job12345'), { recursive: true })
  const fake = join(dir, 'claude')
  writeFileSync(fake, `#!/bin/sh
jq -cn '$ARGS.positional' --args -- "$@" >> "${dir}/calls"
[ "$1 $2" = "agents --json" ] && cat "${dir}/agents" 2>/dev/null
[ "$1" = "--bg" ] && echo "backgrounded · job12345 · test"
exit 0
`)
  chmodSync(fake, 0o755)
  process.env.PATH = `${dir}:${process.env.PATH}`
})

afterEach(() => {
  for (const socket of sockets.splice(0)) socket.destroy()
  hub?.close()
  process.env.PATH = process.env.PATH!.split(':').slice(1).join(':')
})

function start(options: { main?: string; idleStop?: number; relaunch?: number; launcher?: string; registry?: object; agents?: object[] } = {}) {
  if (options.registry) writeFileSync(join(dir, 'threads.json'), JSON.stringify(options.registry))
  if (options.agents) writeFileSync(join(dir, 'agents'), JSON.stringify(options.agents))
  const seen: [string, boolean][] = (states = [])
  const failedSeen: [string, string][] = (failures = [])
  const asked: [string, Permission][] = (prompts = [])
  hub = startHub({
    stateDir: dir,
    channel: CHANNEL,
    main: options.main,
    call: async (thread, tool) => `${tool} in ${thread}`,
    state: (thread, busy) => void seen.push([thread, busy]),
    failed: (thread, reason) => void failedSeen.push([thread, reason]),
    permission: (thread, request) => void asked.push([thread, request]),
    jobsDir: join(dir, 'jobs'),
    hexDir: join(dir, 'hex'),
    projectsDir: join(dir, 'projects'),
    idleStop: options.idleStop,
    relaunch: options.relaunch,
    launcher: options.launcher,
    mainName: 'hex',
  })
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

async function session(thread: string, id = SESSION) {
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

function saved(id = SESSION, folder = join(dir, 'hex')) {
  const project = join(dir, 'projects', folder.replace(/[^a-zA-Z0-9]/g, '-'))
  mkdirSync(project, { recursive: true })
  writeFileSync(join(project, `${id}.jsonl`), '{}\n')
}

function settingsOf(args: string[]) {
  return JSON.parse(args[args.indexOf('--settings') + 1]!)
}

function registry() {
  return JSON.parse(readFileSync(join(dir, 'threads.json'), 'utf8'))
}

test('a message for a new thread starts a session bound to that thread', async () => {
  start()
  hub.deliver('chat:7', 'Desk anchors', message)
  const args = await launched()
  expect(args.slice(0, 5)).toEqual(['--bg', '--channels', CHANNEL, '--name', 'Desk anchors'])
  expect(args).not.toContain('--resume')
  expect(settingsOf(args).env).toEqual({ HEX_CHANNEL: CHANNEL, HEX_THREAD: 'chat:7', HEX_HUB: join(dir, 'hub.sock') })
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
  expect(calls().slice(0, 2)).toEqual([['agents', '--json'], ['rm', SESSION.slice(0, 8)]])
  expect(args).toContain('--resume')
  expect(args[args.indexOf('--resume') + 1]).toBe(SESSION)
})

test('a thread whose session is still running is never relaunched', async () => {
  start({ registry: { 'chat:7': { name: 'Desk anchors', session: SESSION } }, agents: [{ sessionId: SESSION, pid: 42 }] })
  hub.deliver('chat:7', 'Desk anchors', message)
  await until(() => calls().length)
  await Bun.sleep(100)
  expect(calls()).toEqual([['agents', '--json']])
  const { received } = await session('chat:7')
  await until(() => received.length)
  expect(received[0].content).toBe('hi')
})

test('the main thread starts with the hub, under its name, with no prompt and no typing', async () => {
  start({ main: 'chat' })
  const args = await launched()
  expect(args.slice(0, 5)).toEqual(['--bg', '--channels', CHANNEL, '--name', 'hex'])
  expect(args.at(-2)).toBe('--settings')
  expect(settingsOf(args).env.HEX_MAIN).toBe('1')
  expect(states).toEqual([])
})

test('a running main thread is left to reconnect, and gets its messages when it does', async () => {
  start({ main: 'chat', registry: { chat: { name: 'chat', session: SESSION } }, agents: [{ sessionId: SESSION, pid: 42 }] })
  hub.deliver('chat', 'hex', message)
  await until(() => calls().length)
  await Bun.sleep(100)
  expect(calls()).toEqual([['agents', '--json']])
  expect(registry().chat.name).toBe('hex')
  const { received } = await session('chat')
  await until(() => received.length)
  expect(received[0].content).toBe('hi')
})

test('a main thread whose session is gone is resumed again, and is never stopped for being idle', async () => {
  start({ main: 'chat', registry: { chat: { name: 'hex', session: SESSION } }, agents: [{ sessionId: SESSION, pid: 42 }], relaunch: 50, idleStop: 20 })
  const { socket, send } = await session('chat')
  send({ type: 'state', thread: 'chat', busy: false })
  await Bun.sleep(100)
  expect(calls().filter(args => args[0] === 'stop')).toEqual([])
  writeFileSync(join(dir, 'agents'), '[]')
  socket.destroy()
  const args = await launched()
  expect(args[args.indexOf('--resume') + 1]).toBe(SESSION)
})

test('a session that dies before its conversation is saved leaves the thread on its last saved one', async () => {
  const OLD = SESSION
  const NEW = '4460ed71-0000-4000-8000-000000000000'
  saved(OLD)
  start({ main: 'chat', registry: { chat: { name: 'hex', session: OLD } }, agents: [], relaunch: 50 })
  await launched()
  const { socket } = await session('chat', NEW)
  await Bun.sleep(50)
  expect(registry().chat.session).toBe(OLD)
  socket.destroy()
  await until(() => calls().filter(args => args[0] === '--bg').length === 2)
  const args = calls().filter(args => args[0] === '--bg')[1]!
  expect(args[args.indexOf('--resume') + 1]).toBe(OLD)
  const back = await session('chat', OLD)
  back.socket.destroy()
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
  const { send, received } = await session('chat:9')
  send({ type: 'call', id: 1, tool: 'reply', args: { text: 'yo' } })
  await until(() => received.length)
  expect(received[0]).toEqual({ type: 'result', id: 1, text: 'reply in chat:9' })
})

test('a permission prompt reaches the client with its thread, and the answer goes back to that session alone', async () => {
  start()
  const desk = await session('chat:9')
  const other = await session('chat:10')
  const request = { request_id: 'abcde', tool_name: 'Bash', description: 'List files', input_preview: '{"command":"ls"}' }
  desk.send({ type: 'permission_request', ...request })
  const [thread, asked] = await until(() => prompts[0])
  expect(thread).toBe('chat:9')
  expect(asked).toMatchObject(request)
  hub.answer('chat:9', 'abcde', 'allow')
  await until(() => desk.received.length)
  expect(desk.received).toEqual([{ type: 'permission', request_id: 'abcde', behavior: 'allow' }])
  expect(other.received).toEqual([])
})

test('busy and idle from session hooks reach the client, and a dropped session is idle', async () => {
  start()
  const { socket } = await session('chat:9')
  const hook = (busy: boolean) => connect(join(dir, 'hub.sock')).on('connect', function () {
    this.end(JSON.stringify({ type: 'state', thread: 'chat:9', busy }) + '\n')
  })
  hook(true)
  await until(() => states.length === 1)
  hook(false)
  await until(() => states.length === 2)
  socket.destroy()
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

test('a bad line from a session is dropped, and the lines after it still work', async () => {
  start()
  const { socket, received } = await session('chat:9')
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
  const { socket, send } = await session('chat:7')
  send({ type: 'state', thread: 'chat:7', busy: true })
  await until(() => states.length)
  hub.stop('chat:7')
  expect(await until(() => calls().find(args => args[0] === 'stop'))).toEqual(['stop', SESSION.slice(0, 8)])
  socket.destroy()
  await until(() => states.length === 2)
  writeFileSync(join(dir, 'agents'), '[]')
  hub.deliver('chat:7', 'Desk anchors', message)
  const args = await launched()
  expect(args[args.indexOf('--resume') + 1]).toBe(SESSION)
  expect(registry()['chat:7']).toEqual({ name: 'Desk anchors', session: SESSION })
})

test('closing an idle thread stops its session right away, then forgets the thread', async () => {
  start({ registry: { 'chat:7': { name: 'Desk anchors', session: SESSION } } })
  const { socket } = await session('chat:7')
  await Bun.sleep(50)
  void hub.retire('chat:7')
  expect(await until(() => calls().find(args => args[0] === 'stop'))).toEqual(['stop', SESSION.slice(0, 8)])
  expect(registry()['chat:7']).toBeDefined()
  socket.destroy()
  await until(() => !registry()['chat:7'])
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
  const { socket } = await session('t3:1')
  await until(() => existsSync(join(dir, 'threads.json')) && registry()['t3:1'])
  expect(registry()['t3:1']).toEqual({ name: 'project', cwd: project, session: SESSION })
  expect(hub.cwd('t3:1')).toBe(project)
  socket.destroy()
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
  const { socket } = await session('chat:7')
  await Bun.sleep(50)
  let released: string | undefined
  void hub.release('chat:7').then(id => (released = id))
  expect(await until(() => calls().find(args => args[0] === 'stop'))).toEqual(['stop', SESSION.slice(0, 8)])
  await Bun.sleep(50)
  expect(released).toBeUndefined()
  expect(registry()['chat:7']).toBeDefined()
  socket.destroy()
  expect(await until(() => released)).toBe(SESSION)
  expect(registry()['chat:7']).toBeUndefined()
})

test('releasing a busy thread waits for its next idle', async () => {
  start({ registry: { 'chat:7': { name: 'Desk anchors', session: SESSION } } })
  const { socket, send } = await session('chat:7')
  send({ type: 'state', thread: 'chat:7', busy: true })
  await until(() => states.length)
  let released: string | undefined
  void hub.release('chat:7').then(id => (released = id))
  await Bun.sleep(100)
  expect(calls().some(args => args[0] === 'stop')).toBe(false)
  send({ type: 'state', thread: 'chat:7', busy: false })
  await until(() => calls().find(args => args[0] === 'stop'))
  socket.destroy()
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
  expect(calls().slice(0, 2)).toEqual([['agents', '--json'], ['rm', SESSION.slice(0, 8)]])
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
