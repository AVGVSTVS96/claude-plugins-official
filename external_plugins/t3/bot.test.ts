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
  for (const path of [project, join(dir, 'hex'), join(dir, 'state'), join(dir, 'config', 'jobs', 'job12345'), join(dir, '.t3', 'scratch', 'chat')]) mkdirSync(path, { recursive: true })
  writeFileSync(join(dir, '.claude.json'), '{"projects":{}}')
  script('claude', `jq -cn '$ARGS.positional' --args -- "$@" >> "${dir}/claude"
[ "$1 $2" = "agents --json" ] && { cat "${dir}/agents" 2>/dev/null || echo '[]'; }
[ "$1" = stop ] && [ -f "${dir}/agents" ] && pid=$(jq '.[0].pid' "${dir}/agents") && rm "${dir}/agents" && kill "$pid"
exit 0`)
  script('launch', `pwd >> "${dir}/cwd"
jq -cn '$ARGS.positional' --args -- "$@" >> "${dir}/launched"
[ -f "${dir}/broken" ] && { echo "Workspace not trusted." >&2; exit 1; }
echo "backgrounded · job12345 · test"`)
  bot = Bun.spawn(['bun', join(import.meta.dir, 'bot.ts')], {
    env: {
      ...process.env,
      HOME: dir,
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
  expect(updates.filter(update => update.sessionUpdate !== 'available_commands_update')).toEqual([expect.objectContaining({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'hi from hex' } })])
})

test('a session advertises /compact once T3 knows it', async () => {
  const { agent, updates } = await t3()
  await agent.request('session/new', { cwd: project, mcpServers: [] })
  await until(() => updates.length)
  expect(updates).toEqual([{ sessionUpdate: 'available_commands_update', availableCommands: [expect.objectContaining({ name: 'compact' })] }])
})

test('/compact stops a running session, resumes it with the command once it has exited, and ends at the compaction', async () => {
  const { agent, updates } = await t3()
  const { sessionId } = await agent.request('session/new', { cwd: project, mcpServers: [] })
  const hex = await session(sessionId)
  hex.write(prompt, reply, done)
  const running = Bun.spawn(['sleep', '60'])
  writeFileSync(join(dir, 'agents'), JSON.stringify([{ sessionId: SESSION, pid: running.pid, status: 'idle' }]))
  await until(() => updates.length)
  updates.length = 0
  const answer = agent.request('session/prompt', { sessionId, prompt: [{ type: 'text', text: '/compact' }, { type: 'text', text: 'T3 context' }] })
  await until(() => lines('launched').some(line => line.includes('"/compact"')))
  expect(lines('claude')).toContain(JSON.stringify(['stop', SESSION.slice(0, 8)]))
  expect(JSON.parse(lines('launched').at(-1)!)).toEqual(expect.arrayContaining(['--resume', SESSION, '/compact']))
  hex.write(
    { type: 'user', message: { content: '/compact' } },
    { type: 'system', subtype: 'compact_boundary', compactMetadata: { trigger: 'manual' } },
  )
  expect(await answer).toEqual({ stopReason: 'end_turn' })
  expect(hex.inbound).toEqual([])
  expect(updates.map(update => update.sessionUpdate === 'compaction_update' && update.status)).toEqual(['in_progress', 'completed'])
})

test('a /compact that fails fails the prompt with the command\'s error', async () => {
  const { agent, updates } = await t3()
  const { sessionId } = await agent.request('session/new', { cwd: project, mcpServers: [] })
  const hex = await session(sessionId)
  const answer = agent.request('session/prompt', { sessionId, prompt: [{ type: 'text', text: '/compact' }] })
  await until(() => lines('launched').some(line => line.includes('"/compact"')))
  hex.write({ type: 'system', subtype: 'local_command', content: '<local-command-stderr>Error: No messages to compact</local-command-stderr>' })
  await expect(answer).rejects.toThrow('Error: No messages to compact')
  await until(() => updates.some(update => update.sessionUpdate === 'compaction_update' && update.status === 'failed'))
})

const t3Tools = (token: string) => ({ name: 't3-code', command: '/opt/t3code', args: ['acp-mcp-bridge'], env: [{ name: 'T3_ACP_MCP_AUTHORIZATION', value: token }] })

test('a session gets T3\'s MCP servers, and starts again with them when they change', async () => {
  const { agent } = await t3()
  const { sessionId } = await agent.request('session/new', { cwd: project, mcpServers: [t3Tools('one'), { type: 'http', name: 'docs', url: 'http://localhost:9/mcp', headers: [{ name: 'Authorization', value: 'Bearer x' }] }] })
  await until(() => lines('launched').length)
  const launched = JSON.parse(lines('launched')[0]!)
  expect(JSON.parse(launched[launched.indexOf('--mcp-config') + 1])).toEqual({
    mcpServers: {
      't3-code': { command: '/opt/t3code', args: ['acp-mcp-bridge'], env: { T3_ACP_MCP_AUTHORIZATION: 'one' } },
      docs: { type: 'http', url: 'http://localhost:9/mcp', headers: { Authorization: 'Bearer x' } },
    },
  })
  const saved = join(dir, 'config', 'projects', project.replace(/[^a-zA-Z0-9]/g, '-'))
  mkdirSync(saved, { recursive: true })
  writeFileSync(join(saved, `${SESSION}.jsonl`), '')
  const hex = await session(sessionId)
  await until(() => existsSync(join(dir, 'state', 'threads.json')) && readFileSync(join(dir, 'state', 'threads.json'), 'utf8').includes(SESSION))
  const running = Bun.spawn(['sleep', '60'])
  writeFileSync(join(dir, 'agents'), JSON.stringify([{ sessionId: SESSION, pid: running.pid, status: 'idle' }]))
  await agent.request('session/resume', { sessionId, cwd: project, mcpServers: [t3Tools('two')] })
  agent.request('session/prompt', { sessionId, prompt: [{ type: 'text', text: 'hi' }] }).catch(() => {})
  await until(() => lines('launched').length === 2)
  expect(lines('claude')).toContain(JSON.stringify(['stop', SESSION.slice(0, 8)]))
  expect(lines('launched')[1]).toContain('two')
  expect(hex.inbound).toEqual([])
  const fresh = await session(sessionId)
  await until(() => fresh.inbound.length)
  expect(fresh.inbound[0]).toMatchObject({ type: 'inbound', content: 'hi' })
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

test('a chat with no project works in hex\'s folder, and a project folder is trusted for good', async () => {
  const { agent } = await t3()
  for (const cwd of [dir, join(dir, '.t3', 'scratch', 'chat'), project]) await agent.request('session/new', { cwd, mcpServers: [] })
  await until(() => lines('cwd').length === 3)
  expect(lines('cwd')).toEqual([join(dir, 'hex'), join(dir, 'hex'), project])
  expect(JSON.parse(readFileSync(join(dir, '.claude.json'), 'utf8')).projects).toEqual({ [project]: { hasTrustDialogAccepted: true } })
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
