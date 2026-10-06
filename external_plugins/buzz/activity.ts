import { closeSync, fstatSync, openSync, readFileSync, readSync, statSync } from 'fs'
import { homedir } from 'os'
import { dirname, join, relative, resolve } from 'path'
import { randomUUID } from 'crypto'
import { decrypt, encrypt, getConversationKey } from 'nostr-tools/nip44'
import type { Event } from 'nostr-tools/pure'
import { stripLocalCommandMetadata, toAcpNotifications } from '@agentclientprotocol/claude-agent-acp'
import type { Relay } from './relay.ts'

type Frame = {
  seq: number
  timestamp: string
  kind: string
  agentIndex: number | null
  channelId: string | null
  sessionId: string | null
  turnId: string | null
  startedAt?: string
  payload: unknown
}
type Transcript = { path: string; offset: number; rest: Buffer; since: number; tools: Record<string, any>; tasks: Map<any, any> }
type Turn = { id: string; thread: string; channel: string; startedAt: string; beat: number; session?: string; transcript?: Transcript }
type Target = { channel: string; thread?: string; session?: string }

const KIND = 24200
const LIMIT = 65_535
const TICK = 1000
const LIVENESS = 10_000
const FRESH = 300
const BACKLOG = 4 * 1024 * 1024
const LOG_LINES = 1000
const LOG_LINE_BYTES = 4096
const LOG_LEASE = 60_000

const client = { sessionUpdate: async () => {} } as unknown as Parameters<typeof toAcpNotifications>[4]
const logger = { log: () => {}, error: (...args: unknown[]) => process.stderr.write(`buzz hub: activity: ${args.join(' ')}\n`) }

// NIP-AO telemetry for Buzz Desktop's activity panel: each turn's Claude Code
// transcript as ACP session/update frames, at most one relay event a second.
export function startActivity({ relay, secretKey, owner, hexDir, cancel }: {
  relay: Relay
  secretKey: Uint8Array
  owner: string
  hexDir: string
  cancel: (target: Target) => 'sent' | 'no_active_turn' | 'ambiguous_target'
}) {
  const key = getConversationKey(secretKey, owner)
  const projects = join(process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), '.claude'), 'projects', hexDir.replace(/[^a-zA-Z0-9]/g, '-'))
  const turns = new Map<string, Turn>()
  const announced = new Set<string>()
  const queue: { frame: Frame; bytes: number }[] = []
  const logs: string[] = []
  let following = 0
  let streamed: string[] = []
  let dropped = 0
  let seq = 1
  let backlog = 0
  let sending = false

  function push(kind: string, payload: unknown, turn?: Turn, channel = turn?.channel ?? null) {
    const frame: Frame = {
      seq: seq++,
      timestamp: new Date().toISOString(),
      kind,
      agentIndex: turn ? 0 : null,
      channelId: channel,
      sessionId: turn?.session ?? null,
      turnId: turn?.id ?? null,
      ...(turn && { startedAt: turn.startedAt }),
      payload,
    }
    fit(frame)
    const bytes = size(frame)
    queue.push({ frame, bytes })
    backlog += bytes
    while (backlog > BACKLOG) backlog -= queue.shift()!.bytes
  }

  function busy({ thread, channel, session, triggers }: { thread: string; channel: string; session?: string; triggers: string[] }) {
    const turn = turns.get(thread)
    if (turn) {
      if (session && !turn.transcript) follow(turn, session, false)
      return
    }
    const opened: Turn = { id: randomUUID(), thread, channel, startedAt: new Date().toISOString(), beat: Date.now(), session }
    turns.set(thread, opened)
    push('turn_started', { source: 'channel', triggeringEventIds: triggers, ...root(opened) }, opened)
    if (session) follow(opened, session, true)
  }

  // Lines already in the transcript belong to earlier turns, unless the session
  // was only learned mid-turn: then the turn's lines are those written since it began.
  function follow(turn: Turn, session: string, fresh: boolean) {
    turn.session = session
    const path = join(projects, `${session}.jsonl`)
    turn.transcript = { path, offset: fresh ? sizeOf(path) : 0, rest: Buffer.alloc(0), since: Date.parse(turn.startedAt), tools: {}, tasks: new Map() }
    if (announced.has(session)) return
    announced.add(session)
    push('acp_write', { jsonrpc: '2.0', id: 0, method: 'session/new', params: { cwd: hexDir, mcpServers: [], systemPrompt: instructions() } }, turn)
  }

  function read(turn: Turn) {
    const transcript = turn.transcript
    if (!transcript) return
    let fd
    try {
      fd = openSync(transcript.path, 'r')
    } catch {
      return
    }
    try {
      const end = fstatSync(fd).size
      if (end <= transcript.offset) return
      const chunk = Buffer.alloc(end - transcript.offset)
      readSync(fd, chunk, 0, chunk.length, transcript.offset)
      transcript.offset = end
      const data = Buffer.concat([transcript.rest, chunk])
      const last = data.lastIndexOf(10)
      transcript.rest = data.subarray(last + 1)
      if (last >= 0) for (const line of data.subarray(0, last).toString('utf8').split('\n')) convert(turn, line)
    } finally {
      closeSync(fd)
    }
  }

  // Prompts injected by channels or plugins are skipped: the panel links the
  // Buzz message that started the turn instead.
  function convert(turn: Turn, line: string) {
    let entry
    try {
      entry = JSON.parse(line)
    } catch {
      return
    }
    if ((entry.type !== 'assistant' && entry.type !== 'user') || entry.isSidechain) return
    if (!(Date.parse(entry.timestamp) >= turn.transcript!.since)) return
    if (entry.type === 'user' && (entry.isMeta || entry.origin)) return
    const content = entry.type === 'user' ? stripLocalCommandMetadata(entry.message?.content) : entry.message?.content
    if (content == null) return
    const { tools, tasks } = turn.transcript!
    const notifications = toAcpNotifications(content as any, entry.type, turn.session!, tools, client, logger, {
      registerHooks: false,
      replay: true,
      cwd: hexDir,
      taskState: tasks,
      messageId: entry.type === 'assistant' ? entry.message.id : entry.uuid,
      toolUseResult: entry.toolUseResult,
    })
    for (const notification of notifications) push('acp_read', { jsonrpc: '2.0', method: 'session/update', params: notification }, turn)
  }

  function idle(thread: string) {
    const turn = turns.get(thread)
    if (!turn) return
    read(turn)
    turns.delete(thread)
    push('turn_completed', {}, turn)
  }

  function instructions() {
    const files = loaded('AGENTS.md', new Set())
    const body = files.map(([path, text]) => `── ${path} ──\n${text.trim()}`).join('\n\n')
    return `<workspace>\n${hexDir}\n</workspace>\n\n<agent-instructions>\n${body}\n</agent-instructions>`
  }

  // AGENTS.md as Claude Code loads it: the file, then each `@path` it imports
  // (relative to the importing file, `~/` for home), five levels deep at most.
  function loaded(path: string, seen: Set<string>, depth = 0): [string, string][] {
    const file = resolve(hexDir, path)
    if (seen.has(file) || depth > 5) return []
    seen.add(file)
    let text
    try {
      text = readFileSync(file, 'utf8')
    } catch {
      return []
    }
    const imports = [...text.matchAll(/(?:^|\s)@(\S+)/g)].map(([, target]) => target!.startsWith('~/') ? join(homedir(), target!.slice(2)) : resolve(dirname(file), target!))
    return [[relative(hexDir, file), text], ...imports.flatMap(target => loaded(target, seen, depth + 1))]
  }

  function control(event: Event) {
    if (event.pubkey !== owner || !event.tags.some(([name, value]) => name === 'frame' && value === 'control')) return
    if (Math.abs(event.created_at - Date.now() / 1000) > FRESH) return
    let request
    try {
      request = JSON.parse(decrypt(event.content, key))
    } catch (error) {
      return process.stderr.write(`buzz hub: dropped an unreadable activity control frame: ${error}\n`)
    }
    if (request?.type === 'cancel_turn' && typeof request.channelId === 'string') {
      const status = cancel(target(request.channelId))
      push('control_result', { type: 'cancel_turn', status, requestId: request.requestId }, undefined, request.channelId)
    } else if (request?.type === 'log_follow') {
      const tail = Math.max(0, Math.min(LOG_LINES, Number(request.tail) || 0))
      following = Date.now() + LOG_LEASE
      streamed = []
      dropped = 0
      push('log', bounded(tail ? logs.slice(-tail) : [], 0))
    }
  }

  // Desktop names only the channel; the open turn there, if it is the only one, says more.
  function target(channel: string): Target {
    const open = [...turns.values()].filter(turn => turn.channel === channel)
    if (open.length !== 1) return { channel }
    return { channel, thread: open[0]!.thread, ...(open[0]!.session && { session: open[0]!.session }) }
  }

  function log(line: string) {
    line = clip(line, LOG_LINE_BYTES)
    logs.push(line)
    if (logs.length > LOG_LINES) logs.shift()
    if (Date.now() > following) return
    streamed.push(line)
    if (streamed.length > LOG_LINES) {
      streamed.shift()
      dropped++
    }
  }

  // Drops the oldest lines until the frame fits, counting them as skipped.
  function bounded(lines: string[], skipped: number) {
    const base = size({ seq, timestamp: new Date().toISOString(), kind: 'log', agentIndex: null, channelId: null, sessionId: null, turnId: null, payload: { lines: [], dropped: skipped + lines.length } })
    let total = base + lines.reduce((sum, line) => sum + Buffer.byteLength(JSON.stringify(line)) + 1, 0)
    let first = 0
    for (; total > LIMIT; first++) total -= Buffer.byteLength(JSON.stringify(lines[first])) + 1
    return { lines: lines.slice(first), dropped: skipped + first }
  }

  function tick() {
    for (const turn of turns.values()) {
      read(turn)
      if (Date.now() - turn.beat < LIVENESS) continue
      turn.beat = Date.now()
      push('turn_liveness', root(turn), turn)
    }
    if (streamed.length || dropped) push('log', bounded(streamed, dropped))
    streamed = []
    dropped = 0
    if (sending || !queue.length) return
    sending = true
    send(take()).finally(() => (sending = false))
  }

  // One relay event per tick: the front frame and every later one from its
  // channel that still fits (a frame never mixes channels; Desktop files it by channelId).
  function take(): Frame {
    const channel = queue[0]!.frame.channelId
    const picked: Frame[] = []
    let total = 0
    let full = false
    const kept = queue.filter(({ frame, bytes }) => {
      if (full || frame.channelId !== channel) return true
      if (picked.length && size(batch([frame])) + total + picked.length > LIMIT) return (full = true)
      picked.push(frame)
      total += bytes
      return false
    })
    queue.splice(0, queue.length, ...kept)
    backlog -= total
    return picked.length === 1 ? picked[0]! : batch(picked)
  }

  async function send(frame: Frame) {
    try {
      await relay.publish({ kind: KIND, content: encrypt(JSON.stringify(frame), key), tags: [['p', owner], ['agent', relay.pubkey], ['frame', 'telemetry']] })
    } catch (error) {
      process.stderr.write(`buzz hub: dropped an activity frame: ${error instanceof Error ? error.message : error}\n`)
    }
  }

  const unsubscribe = relay.subscribe([{ kinds: [KIND], '#p': [relay.pubkey], authors: [owner], since: Math.floor(Date.now() / 1000) }], control)
  const timer = setInterval(tick, TICK)

  return {
    busy,
    idle,
    log,
    close() {
      clearInterval(timer)
      unsubscribe()
      turns.clear()
    },
  }
}

function root(turn: Turn) {
  return /^[0-9a-f]{64}$/.test(turn.thread) ? { threadRootEventId: turn.thread } : {}
}

function batch(events: Frame[]): Frame {
  const { payload, ...last } = events.at(-1)!
  return { ...last, kind: 'batch', payload: { events } }
}

function size(value: unknown) {
  return Buffer.byteLength(JSON.stringify(value))
}

function sizeOf(path: string) {
  try {
    return statSync(path).size
  } catch {
    return 0
  }
}

function clip(text: string, bytes: number) {
  if (Buffer.byteLength(text) <= bytes) return text
  let clipped = Buffer.from(text).subarray(0, bytes).toString('utf8')
  while (Buffer.byteLength(clipped) > bytes) clipped = clipped.slice(0, -1)
  return clipped
}

// Cuts the middle out of the longest string until the frame fits, keeping the
// start and end of what was cut (a tool output's tail, a prompt's closing tag).
function fit(frame: Frame) {
  for (let over = size(frame) - LIMIT; over > 0; over = size(frame) - LIMIT) {
    const leaf = longest(frame, 'payload')
    if (!leaf || leaf.text.length <= 64) {
      frame.payload = { elided: `${frame.kind} payload too large` }
      return
    }
    const cut = Math.min(leaf.text.length, over + 64)
    const keep = leaf.text.length - cut
    const tail = Math.min(1000, Math.floor(keep / 4))
    leaf.holder[leaf.key] = `${leaf.text.slice(0, keep - tail)}\n[… ${cut} characters cut …]\n${leaf.text.slice(leaf.text.length - tail)}`
  }
}

function longest(holder: any, key: string | number): { holder: any; key: string | number; text: string } | undefined {
  const value = holder[key]
  if (typeof value === 'string') return { holder, key, text: value }
  if (!value || typeof value !== 'object') return
  let best: ReturnType<typeof longest>
  for (const inner of Object.keys(value)) {
    const found = longest(value, inner)
    if (found && (!best || found.text.length > best.text.length)) best = found
  }
  return best
}
