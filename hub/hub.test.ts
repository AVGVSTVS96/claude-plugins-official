import { afterEach, beforeEach, expect, test } from 'bun:test'
import { connect, type Socket } from 'net'
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, writeFileSync, chmodSync, existsSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { startHub, type Message } from './hub.ts'

const CHANNEL = 'plugin:telegram@hex'
const SESSION = '0a1b2c3d-0000-4000-8000-000000000000'
const message: Message = { content: 'hi', meta: { chat_id: '1' } }

let dir: string
let hub: ReturnType<typeof startHub>
let states: [string, boolean][]
let failures: [string, string][]
const sockets: Socket[] = []

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'hub-'))
  mkdirSync(join(dir, 'assistant', '.claude'), { recursive: true })
  writeFileSync(join(dir, 'assistant', '.claude', 'thread.json'), JSON.stringify({ enabledPlugins: { 'telegram@hex': true } }))
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

function start(options: { main?: string; idleStop?: number; registry?: object; agents?: object[] } = {}) {
  if (options.registry) writeFileSync(join(dir, 'threads.json'), JSON.stringify(options.registry))
  if (options.agents) writeFileSync(join(dir, 'agents'), JSON.stringify(options.agents))
  const seen: [string, boolean][] = (states = [])
  const failedSeen: [string, string][] = (failures = [])
  hub = startHub({
    stateDir: dir,
    channel: CHANNEL,
    main: options.main,
    call: async (thread, tool) => `${tool} in ${thread}`,
    state: (thread, busy) => void seen.push([thread, busy]),
    failed: (thread, reason) => void failedSeen.push([thread, reason]),
    jobsDir: join(dir, 'jobs'),
    assistantDir: join(dir, 'assistant'),
    idleStop: options.idleStop,
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
  expect(settingsOf(args).env).toEqual({ ASSISTANT_THREAD: 'chat:7', ASSISTANT_HUB: join(dir, 'hub.sock') })
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

test('the main thread is never launched by the hub', async () => {
  start({ main: 'chat' })
  hub.deliver('chat', 'main', message)
  await Bun.sleep(150)
  expect(calls()).toEqual([])
  const { received } = await session('chat')
  await until(() => received.length)
  expect(received[0].content).toBe('hi')
})

test('tool calls act on the calling session\'s own thread', async () => {
  start()
  const { send, received } = await session('chat:9')
  send({ type: 'call', id: 1, tool: 'reply', args: { text: 'yo' } })
  await until(() => received.length)
  expect(received[0]).toEqual({ type: 'result', id: 1, text: 'reply in chat:9' })
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

test('a thread.json that can\'t be read fails the start instead of leaving it hanging', async () => {
  writeFileSync(join(dir, 'assistant', '.claude', 'thread.json'), '{')
  start()
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
  expect(settingsOf(args).env.ASSISTANT_THREAD).toBe('chat:5')
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
  expect(registry()['chat:8'].name).toBe('Theo clips')
})

test('the channel plugin is enabled for the session whatever thread.json says', async () => {
  writeFileSync(join(dir, 'assistant', '.claude', 'thread.json'), JSON.stringify({ enabledPlugins: { 'telegram@hex': false, 'other@hex': true } }))
  start()
  hub.open('chat:7', 'Desk anchors', 'go')
  expect(settingsOf(await launched()).enabledPlugins).toEqual({ 'telegram@hex': true })
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
