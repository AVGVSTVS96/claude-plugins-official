#!/usr/bin/env bun
import { createServer, type Socket } from 'net'
import { Readable, Writable } from 'stream'
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'fs'
import { homedir } from 'os'
import { basename, join } from 'path'
import { fileURLToPath } from 'url'
import { randomUUID } from 'crypto'
import { agent, ndJsonStream, PROTOCOL_VERSION, RequestError, type AgentContext, type ContentBlock, type PromptResponse, type StopReason } from '@agentclientprotocol/sdk'
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

type Turn = {
  client: AgentContext
  reader?: ReturnType<typeof follow>
  sent: Promise<unknown>
  resolve: (response: PromptResponse) => void
  reject: (error: Error) => void
}

// One ACP prompt per thread at a time: it is answered when the session's turn ends.
const turns = new Map<string, Turn>()

mkdirSync(INBOX_DIR, { recursive: true, mode: 0o700 })

const hub = startHub({
  stateDir: STATE_DIR,
  channel: 'plugin:t3@hex',
  call: async (_, tool) => {
    throw new Error(`unknown tool: ${tool}`)
  },
  // A new thread's session is only known once it says hello, before its first prompt.
  state: (thread, busy) => {
    const turn = turns.get(thread)
    const session = hub.session(thread)
    if (busy && turn && session && !turn.reader) turn.reader = reader(thread, session, turn, true)
  },
  failed: (thread, reason) => {
    const turn = turns.get(thread)
    turns.delete(thread)
    turn?.reader?.close()
    turn?.reject(RequestError.internalError(undefined, `hex couldn't start this thread's session: ${reason}`))
  },
  hexDir: HEX_DIR,
  launcher: process.env.HEX_LAUNCHER,
})

function reader(thread: string, session: string, turn: Turn, fresh: boolean) {
  const cwd = hub.cwd(thread) ?? HEX_DIR
  return follow({
    path: transcriptPath(cwd, session),
    sessionId: thread,
    cwd,
    fresh,
    end: () => finish(thread, 'end_turn'),
    emit: notification => (turn.sent = turn.sent.then(() => turn.client.notify('session/update', notification)).catch(() => {})),
  })
}

function finish(thread: string, stopReason: StopReason) {
  const turn = turns.get(thread)
  if (!turn) return
  turns.delete(thread)
  turn.reader?.close()
  void turn.sent.then(() => turn.resolve({ stopReason }))
}

function known(thread: string) {
  if (!hub.name(thread)) throw RequestError.resourceNotFound(thread)
  return thread
}

function prompt(thread: string, blocks: ContentBlock[], client: AgentContext): Promise<PromptResponse> {
  const name = hub.name(known(thread))!
  if (turns.has(thread)) throw RequestError.invalidRequest(undefined, 'this thread is already working on a prompt')
  return new Promise((resolve, reject) => {
    const turn: Turn = { client, sent: Promise.resolve(), resolve, reject }
    turns.set(thread, turn)
    const session = hub.session(thread)
    if (session) turn.reader = reader(thread, session, turn, false)
    hub.deliver(thread, name, { content: render(blocks), meta: { ts: new Date().toISOString() } })
  })
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
    .onRequest('session/new', ({ params }) => {
      const thread = randomUUID()
      const folder = folderFor(params.cwd)
      hub.open(thread, basename(folder ?? HEX_DIR), undefined, folder)
      return { sessionId: thread }
    })
    .onRequest('session/resume', ({ params }) => (known(params.sessionId), {}))
    .onRequest('session/prompt', ({ params, client }) => prompt(params.sessionId, params.prompt, client))
    .onNotification('session/cancel', ({ params }) => cancel(params.sessionId))
    .connect(ndJsonStream(Writable.toWeb(socket) as WritableStream<Uint8Array>, Readable.toWeb(socket) as ReadableStream<Uint8Array>))
  socket.on('error', () => {})
}

rmSync(SOCKET, { force: true })
createServer(serve).listen(SOCKET)
