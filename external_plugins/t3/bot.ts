#!/usr/bin/env bun
import { createServer, type Socket } from 'net'
import { Readable, Writable } from 'stream'
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'fs'
import { homedir } from 'os'
import { basename, join } from 'path'
import { fileURLToPath } from 'url'
import { randomUUID } from 'crypto'
import { agent, ndJsonStream, PROTOCOL_VERSION, RequestError, type AgentContext, type ContentBlock, type McpServer, type PromptResponse, type SessionConfigOption, type SessionNotification, type StopReason } from '@agentclientprotocol/sdk'
import { startHub } from '../../hub/hub.ts'
import { follow, transcriptPath } from './transcript.ts'
import { version } from './package.json'

const STATE_DIR = process.env.T3_STATE_DIR ?? join(homedir(), '.claude', 'channels', 'hex', 't3')
const INBOX_DIR = join(STATE_DIR, 'inbox')
const SOCKET = join(STATE_DIR, 'acp.sock')
const HEX_DIR = process.env.HEX_DIR ?? process.cwd()
const HOME = homedir()
const SCRATCH = join(HOME, '.t3', 'scratch')
const CLAUDE_JSON = join(HOME, '.claude.json')
const COMMANDS = [{ name: 'compact', description: 'Summarize the conversation so far to free up context' }]
const MODELS = [
  { value: 'claude-opus-5-5', name: 'Opus 5.5', alias: 'opus' },
  { value: 'claude-sonnet-5-5', name: 'Sonnet 5.5', alias: 'sonnet' },
  { value: 'claude-haiku-5-5', name: 'Haiku 5.5', alias: 'haiku' },
  { value: 'claude-fable-5-1', name: 'Fable 5.1', alias: 'fable' },
]
const EFFORTS = [
  { value: 'low', name: 'Low' },
  { value: 'medium', name: 'Medium' },
  { value: 'high', name: 'High' },
  { value: 'xhigh', name: 'Extra High' },
  { value: 'max', name: 'Max' },
]

type Turn = {
  client: AgentContext
  reader?: ReturnType<typeof follow>
  sent: Promise<unknown>
  done: boolean
  compaction?: string
  resolve: (response: PromptResponse) => void
  reject: (error: Error) => void
}

// One ACP prompt per thread at a time: it is answered when the session's turn ends.
const turns = new Map<string, Turn>()

// T3 Code hands each thread its own MCP servers, with tools like html_render, preview
// and delegate_task. A session loads them as it starts, so it starts again when they change.
const servers = new Map<string, string>()

mkdirSync(INBOX_DIR, { recursive: true, mode: 0o700 })

const hub = startHub({
  stateDir: STATE_DIR,
  channel: process.env.T3_CHANNEL ?? 'plugin:t3@hex',
  call: async (_, tool) => {
    throw new Error(`unknown tool: ${tool}`)
  },
  // A new thread's session starts with its first prompt and is only known once it says hello.
  // Its turn is done once a stop leaves no background agent working.
  state: (thread, busy, background) => {
    const turn = turns.get(thread)
    if (!turn) return
    turn.done = !busy && !background
    const session = hub.session(thread)
    if (busy && session && !turn.reader) turn.reader = reader(thread, session, turn, true)
    turn.reader?.settle()
  },
  failed: (thread, reason) => {
    const turn = turns.get(thread)
    turns.delete(thread)
    turn?.reader?.close()
    turn?.reject(RequestError.internalError(undefined, `hex couldn't start this thread's session: ${reason}`))
  },
  args: thread => {
    const config = servers.get(thread)
    return config ? ['--mcp-config', config] : []
  },
  hexDir: HEX_DIR,
  launcher: process.env.HEX_LAUNCHER,
})

function remember(thread: string, list: McpServer[] = []) {
  const entries = list.flatMap(server => {
    if (!('type' in server)) return [[server.name, { command: server.command, args: server.args, env: pairs(server.env) }] as const]
    if (server.type === 'acp') return []
    return [[server.name, { type: server.type, url: server.url, headers: pairs(server.headers) }] as const]
  })
  if (entries.length) servers.set(thread, JSON.stringify({ mcpServers: Object.fromEntries(entries) }))
  else servers.delete(thread)
}

function pairs(list: { name: string; value: string }[]) {
  return Object.fromEntries(list.map(({ name, value }) => [name, value]))
}

function reader(thread: string, session: string, turn: Turn, fresh: boolean) {
  const cwd = hub.cwd(thread) ?? HEX_DIR
  return follow({
    path: transcriptPath(cwd, session),
    sessionId: thread,
    cwd,
    fresh,
    done: () => turn.done,
    end: error => finish(thread, 'end_turn', error),
    emit: notification => send(turn, notification),
  })
}

function send(turn: Turn, notification: SessionNotification) {
  turn.sent = turn.sent.then(() => turn.client.notify('session/update', notification)).catch(() => {})
}

function compaction(turn: Turn, thread: string, status: string, error?: string) {
  send(turn, { sessionId: thread, update: { sessionUpdate: 'compaction_update', compactionId: turn.compaction!, status, ...(error && { error }) } })
}

function finish(thread: string, stopReason: StopReason, error?: string) {
  const turn = turns.get(thread)
  if (!turn) return
  turns.delete(thread)
  turn.reader?.close()
  if (turn.compaction) compaction(turn, thread, error ? 'failed' : stopReason === 'cancelled' ? 'cancelled' : 'completed', error)
  void turn.sent.then(() => (error ? turn.reject(RequestError.internalError(undefined, error)) : turn.resolve({ stopReason })))
}

function known(thread: string) {
  if (!hub.name(thread)) throw RequestError.resourceNotFound(thread)
  return thread
}

// T3's MCP credentials live only in its running server, so when T3 quits or restarts
// mid-turn (the prompt's request aborts) the session's T3 tools are dead: it stops like a cancel.
function prompt(thread: string, blocks: ContentBlock[], client: AgentContext, signal: AbortSignal): Promise<PromptResponse> {
  const name = hub.name(known(thread))!
  if (turns.has(thread)) throw RequestError.invalidRequest(undefined, 'this thread is already working on a prompt')
  const session = hub.session(thread)
  // T3 Code follows a command with its own context block, which the command doesn't take.
  const compact = blocks[0]?.type === 'text' && blocks[0].text.trim() === '/compact'
  if (compact && !session) throw RequestError.invalidRequest(undefined, 'this thread has nothing to compact yet')
  return new Promise((resolve, reject) => {
    const turn: Turn = { client, sent: Promise.resolve(), done: false, resolve, reject, ...(compact && { compaction: randomUUID() }) }
    turns.set(thread, turn)
    signal.addEventListener('abort', () => turns.get(thread) === turn && cancel(thread), { once: true })
    if (session) turn.reader = reader(thread, session, turn, false)
    if (!compact) {
      const message = { content: render(blocks), meta: { ts: new Date().toISOString() } }
      return hub.deliver(thread, name, message)
    }
    compaction(turn, thread, 'in_progress')
    hub.command(thread, '/compact')
  })
}

// T3 shows these as its model and effort pickers. A thread with no choice of its own
// runs on what hex's settings say, so that's what they show.
function options(thread: string): SessionConfigOption[] {
  const chosen = hub.settings(thread)
  const defaults = settings()
  const model = chosen.model ?? MODELS.find(model => defaults.model === model.alias || defaults.model?.startsWith(model.value))?.value ?? MODELS[0]!.value
  const effort = chosen.effort ?? EFFORTS.find(effort => effort.value === defaults.effortLevel)?.value ?? 'medium'
  return [
    { type: 'select', id: 'model', name: 'Model', category: 'model', currentValue: model, options: MODELS.map(({ value, name }) => ({ value, name })) },
    { type: 'select', id: 'effort', name: 'Effort', category: 'thought_level', currentValue: effort, options: EFFORTS },
  ]
}

function settings(): { model?: string; effortLevel?: string } {
  try {
    return JSON.parse(readFileSync(join(HEX_DIR, '.claude', 'settings.json'), 'utf8'))
  } catch {
    return {}
  }
}

// The thread's session starts again with the new choice at its next prompt.
function configure(thread: string, id: string, value: unknown) {
  const choices = id === 'model' ? MODELS : id === 'effort' ? EFFORTS : undefined
  if (!choices) throw RequestError.invalidParams(undefined, `no option ${id}`)
  if (!choices.some(choice => choice.value === value)) throw RequestError.invalidParams(undefined, `${id} can't be ${value}`)
  hub.configure(known(thread), { [id]: value as string })
  return { configOptions: options(thread) }
}

// Sent once the session/new or session/resume answer is out, so the client knows the session.
function advertise(client: AgentContext, sessionId: string) {
  setImmediate(() => client.notify('session/update', { sessionId, update: { sessionUpdate: 'available_commands_update', availableCommands: COMMANDS } }).catch(() => {}))
}

// Stopping the session ends the turn; the next prompt resumes it.
function cancel(thread: string) {
  if (!turns.has(thread)) return
  hub.stop(thread)
  finish(thread, 'cancelled')
}

// Images and binary files land in the inbox, so the session reads them by path.
function render(blocks: ContentBlock[]) {
  return blocks.map(block => {
    switch (block.type) {
      case 'text':
        return block.text
      case 'resource_link':
        return `[${block.name}](${path(block.uri)})`
      case 'resource':
        if ('text' in block.resource) return `<file path="${path(block.resource.uri)}">\n${block.resource.text}\n</file>`
        return `[file: ${save(block.resource.blob, block.resource.mimeType)}] (from ${path(block.resource.uri)})`
      case 'image':
      case 'audio':
        return `[${block.type}: ${save(block.data, block.mimeType)}]`
    }
  }).join('\n\n')
}

function path(uri: string) {
  return uri.startsWith('file://') ? fileURLToPath(uri) : uri
}

function save(base64: string, mimeType?: string | null) {
  const file = join(INBOX_DIR, `${randomUUID()}.${mimeType?.split('/')[1]?.replace(/\W.*/, '') || 'bin'}`)
  writeFileSync(file, Buffer.from(base64, 'base64'), { mode: 0o600 })
  return file
}

// Claude Code never saves trust for the home folder and asks once per new folder,
// but a hex session runs headless with nobody to accept. A T3 chat with no project
// (home or T3's scratch folders) works in hex's own folder; a project folder is
// trusted for good the first time hex opens there.
function folderFor(cwd: string): string | undefined {
  if (cwd === HOME || cwd === HEX_DIR || cwd.startsWith(SCRATCH)) return
  const config = JSON.parse(readFileSync(CLAUDE_JSON, 'utf8'))
  if (config.projects?.[cwd]?.hasTrustDialogAccepted) return cwd
  config.projects = { ...config.projects, [cwd]: { ...config.projects?.[cwd], hasTrustDialogAccepted: true } }
  writeFileSync(`${CLAUDE_JSON}.hex`, JSON.stringify(config, null, 2))
  renameSync(`${CLAUDE_JSON}.hex`, CLAUDE_JSON)
  return cwd
}

function serve(socket: Socket) {
  agent({ name: 'hex' })
    .onRequest('initialize', () => ({
      protocolVersion: PROTOCOL_VERSION,
      agentInfo: { name: 'hex', title: 'hex', version },
      agentCapabilities: {
        promptCapabilities: { image: true, audio: true, embeddedContext: true },
        sessionCapabilities: { resume: {} },
      },
      authMethods: [],
    }))
    .onRequest('session/new', ({ params, client }) => {
      const thread = randomUUID()
      const folder = folderFor(params.cwd)
      remember(thread, params.mcpServers)
      hub.register(thread, basename(folder ?? HEX_DIR), folder)
      advertise(client, thread)
      return { sessionId: thread, configOptions: options(thread) }
    })
    .onRequest('session/resume', ({ params, client }) => {
      remember(known(params.sessionId), params.mcpServers)
      advertise(client, params.sessionId)
      return { configOptions: options(params.sessionId) }
    })
    .onRequest('session/set_config_option', ({ params }) => configure(params.sessionId, params.configId, params.value))
    .onRequest('session/prompt', ({ params, client, signal }) => prompt(params.sessionId, params.prompt, client, signal))
    .onNotification('session/cancel', ({ params }) => cancel(params.sessionId))
    .connect(ndJsonStream(Writable.toWeb(socket) as WritableStream<Uint8Array>, Readable.toWeb(socket) as ReadableStream<Uint8Array>))
  socket.on('error', () => {})
}

rmSync(SOCKET, { force: true })
createServer(serve).listen(SOCKET)
