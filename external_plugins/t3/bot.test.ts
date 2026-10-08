import { afterEach, beforeEach, expect, test } from 'bun:test'
import { connect, type Socket } from 'net'
import { Readable, Writable } from 'stream'
import { appendFileSync, chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import type { Subprocess } from 'bun'
import { client, ndJsonStream, type SessionNotification } from '@agentclientprotocol/sdk'

const SESSION = '0a1b2c3d-0000-4000-8000-000000000000'

let dir: string
let project: string
let bot: Subprocess
const sockets: Socket[] = []

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 't3-bot-'))
  project = join(dir, 'project')
  for (const path of [project, join(dir, 'hex'), join(dir, 'state'), join(dir, 'config', 'jobs', 'job12345')]) mkdirSync(path, { recursive: true })
  script('claude', `jq -cn '$ARGS.positional' --args -- "$@" >> "${dir}/claude"
[ "$1 $2" = "agents --json" ] && echo '[]'
exit 0`)
  script('launch', `pwd >> "${dir}/cwd"
[ -f "${dir}/broken" ] && { echo "Workspace not trusted." >&2; exit 1; }
echo "backgrounded · job12345 · test"`)
  bot = Bun.spawn(['bun', join(import.meta.dir, 'bot.ts')], {
    env: {
      ...process.env,
      PATH: `${dir}:${process.env.PATH}`,
      T3_STATE_DIR: join(dir, 'state'),
      HEX_DIR: join(dir, 'hex'),
      HEX_LAUNCHER: join(dir, 'launch'),
      CLAUDE_CONFIG_DIR: join(dir, 'config'),
    },
    stderr: 'ignore',
  })
  await until(() => existsSync(join(dir, 'state', 'acp.sock')))
})

afterEach(() => {
  for (const socket of sockets.splice(0)) socket.destroy()
  bot.kill()
})

function script(name: string, body: string) {
  writeFileSync(join(dir, name), `#!/bin/sh\n${body}\n`)
  chmodSync(join(dir, name), 0o755)
}

function lines(file: string) {
  return existsSync(join(dir, file)) ? readFileSync(join(dir, file), 'utf8').split('\n').slice(0, -1) : []
}

async function until<T>(check: () => T, timeout = 5000): Promise<NonNullable<T>> {
  for (const end = Date.now() + timeout; Date.now() < end; await Bun.sleep(20)) {
    const value = check()
    if (value) return value
  }
  throw new Error('timed out')
}

async function open(path: string) {
  const socket = connect(path)
  sockets.push(socket)
  await new Promise(resolve => socket.on('connect', resolve))
  return socket
}

// T3 Code's side: an ACP client on the agent's socket.
async function t3() {
  const socket = await open(join(dir, 'state', 'acp.sock'))
  const updates: SessionNotification['update'][] = []
  const connection = client({ name: 't3' })
    .onNotification('session/update', ({ params }) => void updates.push(params.update))
    .connect(ndJsonStream(Writable.toWeb(socket) as WritableStream<Uint8Array>, Readable.toWeb(socket) as ReadableStream<Uint8Array>))
  const agent = connection.agent
  await agent.request('initialize', { protocolVersion: 1, clientCapabilities: {} })
  return { agent, updates }
}

// The hex session's side: its channel saying hello on the hub socket, and its hooks.
async function session(thread: string) {
  const socket = await open(join(dir, 'state', 'hub.sock'))
  const inbound: any[] = []
  let buffer = ''
  socket.setEncoding('utf8')
  socket.on('data', (chunk: string) => {
    buffer += chunk
    const parts = buffer.split('\n')
    buffer = parts.pop()!
    inbound.push(...parts.map(line => JSON.parse(line)))
  })
  socket.write(JSON.stringify({ type: 'hello', thread, session: SESSION }) + '\n')
  const transcript = join(dir, 'config', 'projects', project.replace(/[^a-zA-Z0-9]/g, '-'), `${SESSION}.jsonl`)
  mkdirSync(join(transcript, '..'), { recursive: true })
  return {
    inbound,
    busy: () => socket.write(JSON.stringify({ type: 'state', thread, busy: true }) + '\n'),
    write: (...entries: object[]) => appendFileSync(transcript, entries.map(entry => JSON.stringify(entry) + '\n').join('')),
  }
}

const prompt = { type: 'user', origin: { kind: 'channel' }, isMeta: true, message: { content: '<channel source="t3">hi</channel>' } }
const reply = { type: 'assistant', message: { id: 'm1', content: [{ type: 'text', text: 'hi from hex' }] } }
const done = { type: 'system', subtype: 'turn_duration' }

test('a new thread starts a hex session in its project, and a prompt streams the turn until the transcript ends it', async () => {
  const { agent, updates } = await t3()
  const { sessionId } = await agent.request('session/new', { cwd: project, mcpServers: [] })
  await until(() => lines('cwd').length)
  expect(lines('cwd')).toEqual([project])
  const hex = await session(sessionId)
  const answer = agent.request('session/prompt', { sessionId, prompt: [{ type: 'text', text: 'hi' }] })
  await until(() => hex.inbound.length)
  expect(hex.inbound[0]).toMatchObject({ type: 'inbound', content: 'hi' })
  hex.busy()
  await Bun.sleep(100)
  hex.write(prompt, reply, done)
  expect(await answer).toEqual({ stopReason: 'end_turn' })
  expect(updates).toEqual([expect.objectContaining({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'hi from hex' } })])
})

test('a known thread resumes and an unknown one is not found', async () => {
  const { agent } = await t3()
  const { sessionId } = await agent.request('session/new', { cwd: project, mcpServers: [] })
  expect(await agent.request('session/resume', { sessionId, cwd: project, mcpServers: [] })).toEqual({})
  expect(agent.request('session/resume', { sessionId: 'nope', cwd: project, mcpServers: [] })).rejects.toThrow('Resource not found')
})

test('cancelling stops the session and answers the prompt as cancelled', async () => {
  const { agent } = await t3()
  const { sessionId } = await agent.request('session/new', { cwd: project, mcpServers: [] })
  const hex = await session(sessionId)
  const answer = agent.request('session/prompt', { sessionId, prompt: [{ type: 'text', text: 'run for a while' }] })
  await until(() => hex.inbound.length)
  await agent.notify('session/cancel', { sessionId })
  expect(await answer).toEqual({ stopReason: 'cancelled' })
  await until(() => lines('claude').some(line => line.startsWith('["stop"')))
  expect(lines('claude')).toContain(JSON.stringify(['stop', SESSION.slice(0, 8)]))
})

test('a session that fails to start fails the prompt with its reason', async () => {
  writeFileSync(join(dir, 'broken'), '')
  const { agent } = await t3()
  const { sessionId } = await agent.request('session/new', { cwd: project, mcpServers: [] })
  expect(agent.request('session/prompt', { sessionId, prompt: [{ type: 'text', text: 'hi' }] })).rejects.toThrow('Workspace not trusted.')
})

test('images and files reach the session as paths it can read', async () => {
  const { agent } = await t3()
  const { sessionId } = await agent.request('session/new', { cwd: project, mcpServers: [] })
  const hex = await session(sessionId)
  agent.request('session/prompt', {
    sessionId,
    prompt: [
      { type: 'text', text: 'look' },
      { type: 'image', data: Buffer.from('png bytes').toString('base64'), mimeType: 'image/png' },
      { type: 'resource_link', name: 'notes.md', uri: 'file:///work/notes.md' },
      { type: 'resource', resource: { uri: 'file:///work/a.ts', text: 'export {}' } },
    ],
  }).catch(() => {})
  await until(() => hex.inbound.length)
  const [text, image, link, file] = hex.inbound[0].content.split('\n\n')
  expect(text).toBe('look')
  const saved = image.match(/^\[image: (.+\.png)\]$/)[1]
  expect(readFileSync(saved, 'utf8')).toBe('png bytes')
  expect(link).toBe('[notes.md](/work/notes.md)')
  expect(file).toBe('<file path="/work/a.ts">\nexport {}\n</file>')
})
