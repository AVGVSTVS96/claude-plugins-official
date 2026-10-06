import { afterEach, beforeEach, expect, setSystemTime, test } from 'bun:test'
import { appendFileSync, mkdirSync, mkdtempSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { randomUUID } from 'crypto'
import { finalizeEvent, generateSecretKey, getPublicKey, type Event } from 'nostr-tools/pure'
import { decrypt, encrypt, getConversationKey } from 'nostr-tools/nip44'
import type { Filter } from 'nostr-tools/filter'
import { startActivity } from './activity.ts'
import type { Relay } from './relay.ts'

const SESSION = '0a1b2c3d-0000-4000-8000-000000000000'
const CHANNEL = '5f0c2b9e-7a1d-4c3e-9b8a-2d6f1e0a4c7b'
const ROOT = 'a'.repeat(64)
const TRIGGER = 'b'.repeat(64)
const agentKey = generateSecretKey()
const ownerKey = generateSecretKey()
const agent = getPublicKey(agentKey)
const owner = getPublicKey(ownerKey)
const key = getConversationKey(ownerKey, agent)

let dir: string
let hexDir: string
let transcript: string
let activity: ReturnType<typeof startActivity>
let published: { event: Event; at: number }[]
let filters: Filter[][]
let deliver: (event: Event) => void
let cancels: object[]

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'activity-'))
  hexDir = join(dir, 'hex')
  mkdirSync(join(hexDir, '.hex'), { recursive: true })
  writeFileSync(join(hexDir, 'AGENTS.md'), '@.hex/HEX.md\n@SOUL.md\n@MEMORY.md\n\n# My rules for you\n\nBe brief.\n')
  writeFileSync(join(hexDir, 'SOUL.md'), 'You are hex.\n')
  writeFileSync(join(hexDir, 'MEMORY.md'), 'Bassim likes short answers.\n')
  writeFileSync(join(hexDir, '.hex', 'HEX.md'), 'How hex works.\n')
  process.env.CLAUDE_CONFIG_DIR = join(dir, 'claude')
  const projects = join(dir, 'claude', 'projects', hexDir.replace(/[^a-zA-Z0-9]/g, '-'))
  mkdirSync(projects, { recursive: true })
  transcript = join(projects, `${SESSION}.jsonl`)
  published = []
  filters = []
  cancels = []
  const relay: Relay = {
    pubkey: agent,
    publish: async event => {
      published.push({ event: event as Event, at: Date.now() })
      return event as Event
    },
    subscribe: (wanted, onEvent) => {
      filters.push(wanted)
      deliver = onEvent
      return () => {}
    },
    query: async () => [],
    close: () => {},
  }
  activity = startActivity({
    relay,
    secretKey: agentKey,
    owner,
    hexDir,
    cancel: target => {
      cancels.push(target)
      return 'sent'
    },
  })
})

afterEach(() => {
  activity.close()
  setSystemTime()
})

function line(entry: object) {
  appendFileSync(transcript, JSON.stringify({
    parentUuid: null,
    isSidechain: false,
    userType: 'external',
    cwd: hexDir,
    sessionId: SESSION,
    version: '2.1.291',
    gitBranch: 'main',
    uuid: randomUUID(),
    timestamp: new Date().toISOString(),
    ...entry,
  }) + '\n')
}

function assistant(id: string, block: object) {
  line({ type: 'assistant', requestId: 'req_01', message: { id, type: 'message', role: 'assistant', model: 'claude-opus-5-5', content: [block], stop_reason: null, usage: { input_tokens: 3, output_tokens: 9 } } })
}

function prompt(text: string) {
  line({ type: 'user', isMeta: true, origin: { kind: 'channel', server: 'plugin:buzz:buzz' }, promptSource: 'system', message: { role: 'user', content: `<channel source="plugin:buzz:buzz">${text}</channel>` } })
}

function bash(id: string, tool: string, command: string, output: string) {
  assistant(id, { type: 'tool_use', id: tool, name: 'Bash', input: { command, description: 'Run it' }, caller: { type: 'direct' } })
  line({ type: 'user', message: { role: 'user', content: [{ tool_use_id: tool, type: 'tool_result', content: output, is_error: false }] }, toolUseResult: { stdout: output, stderr: '', interrupted: false, isImage: false, noOutputExpected: false } })
}

function plaintexts() {
  return published.map(({ event }) => decrypt(event.content, key))
}

function frames(): any[] {
  return plaintexts().flatMap(text => {
    const frame = JSON.parse(text)
    return frame.kind === 'batch' ? frame.payload.events : [frame]
  })
}

function updates() {
  return frames().filter(frame => frame.kind === 'acp_read').map(frame => frame.payload.params.update)
}

async function until<T>(check: () => T | undefined, timeout = 8000): Promise<T> {
  for (const end = Date.now() + timeout; Date.now() < end; await Bun.sleep(50)) {
    const value = check()
    if (value) return value
  }
  throw new Error('timed out')
}

function control(payload: object, options: { from?: Uint8Array; created_at?: number } = {}) {
  const from = options.from ?? ownerKey
  deliver(finalizeEvent({
    kind: 24200,
    created_at: options.created_at ?? Math.floor(Date.now() / 1000),
    tags: [['p', agent], ['agent', agent], ['frame', 'control']],
    content: encrypt(JSON.stringify(payload), getConversationKey(from, agent)),
  }, from))
}

test('a turn streams its new transcript lines as ACP session updates, then completes', async () => {
  assistant('msg_old', { type: 'text', text: 'an earlier turn' })
  activity.busy({ thread: ROOT, channel: CHANNEL, session: SESSION, triggers: [TRIGGER] })
  prompt('what time is it')
  assistant('msg_01', { type: 'thinking', thinking: 'Check the clock.', signature: 'sig' })
  bash('msg_01', 'toolu_01', 'date', 'Tue Oct  6 12:00:00 UTC 2026')
  assistant('msg_02', { type: 'text', text: "It's noon." })
  await until(() => updates().some(update => update.sessionUpdate === 'agent_message_chunk'))
  activity.idle(ROOT)
  await until(() => frames().some(frame => frame.kind === 'turn_completed'))

  const all = frames()
  expect(all.map(frame => frame.kind)).toEqual(['turn_started', 'acp_write', 'acp_read', 'acp_read', 'acp_read', 'acp_read', 'turn_completed'])
  expect(all[0].payload).toEqual({ source: 'channel', triggeringEventIds: [TRIGGER], threadRootEventId: ROOT })
  expect(new Set(all.map(frame => frame.turnId)).size).toBe(1)
  expect(all.every(frame => frame.channelId === CHANNEL && frame.agentIndex === 0 && frame.startedAt === all[0].startedAt)).toBe(true)
  expect(all.slice(1).every(frame => frame.sessionId === SESSION)).toBe(true)
  expect(all.map(frame => frame.seq)).toEqual([...all.map(frame => frame.seq)].sort((a, b) => a - b))

  const read = all.filter(frame => frame.kind === 'acp_read')
  expect(read.every(frame => frame.payload.jsonrpc === '2.0' && frame.payload.method === 'session/update' && frame.payload.params.sessionId === SESSION)).toBe(true)
  const [thought, call, result, message] = read.map(frame => frame.payload.params.update)
  expect(thought).toMatchObject({ sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: 'Check the clock.' }, messageId: 'msg_01' })
  expect(call).toMatchObject({ sessionUpdate: 'tool_call', toolCallId: 'toolu_01', rawInput: { command: 'date' } })
  expect(result).toMatchObject({ sessionUpdate: 'tool_call_update', toolCallId: 'toolu_01', status: 'completed' })
  expect(JSON.stringify(result)).toContain('UTC 2026')
  expect(message).toMatchObject({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: "It's noon." }, messageId: 'msg_02' })
  expect(plaintexts().join()).not.toContain('an earlier turn')
  expect(plaintexts().join()).not.toContain('what time is it')

  for (const { event } of published) {
    expect(event.kind).toBe(24200)
    expect(event.tags).toEqual([['p', owner], ['agent', agent], ['frame', 'telemetry']])
  }
  expect(filters).toEqual([[{ kinds: [24200], '#p': [agent], authors: [owner], since: expect.any(Number) }]])
}, 15000)

test('at most one relay event a second, with what piled up sent as one batch', async () => {
  activity.busy({ thread: ROOT, channel: CHANNEL, session: SESSION, triggers: [] })
  for (let i = 0; i < 20; i++) assistant(`msg_${i}`, { type: 'text', text: `step ${i}` })
  await until(() => published.length)
  for (let i = 0; i < 5; i++) assistant(`msg_late_${i}`, { type: 'text', text: `late ${i}` })
  await until(() => updates().filter(update => update.sessionUpdate === 'agent_message_chunk').length === 25)
  expect(published.length).toBeGreaterThan(1)

  const gaps = published.slice(1).map(({ at }, i) => at - published[i]!.at)
  expect(gaps.every(gap => gap >= 900)).toBe(true)
  const batches = plaintexts().map(text => JSON.parse(text)).filter(frame => frame.kind === 'batch')
  expect(batches.length).toBeGreaterThan(0)
  for (const batch of batches) {
    expect(batch.payload.events.length).toBeGreaterThan(1)
    expect(batch.seq).toBe(batch.payload.events.at(-1).seq)
  }
  const seqs = frames().map(frame => frame.seq)
  expect(seqs).toEqual([...new Set(seqs)].sort((a, b) => a - b))
}, 15000)

test('session/new is sent once per session, with AGENTS.md and what it imports', async () => {
  activity.busy({ thread: ROOT, channel: CHANNEL, session: SESSION, triggers: [] })
  activity.idle(ROOT)
  activity.busy({ thread: 'c'.repeat(64), channel: CHANNEL, session: SESSION, triggers: [] })
  await until(() => frames().filter(frame => frame.kind === 'turn_started').length === 2)

  const news = frames().filter(frame => frame.kind === 'acp_write')
  expect(news).toHaveLength(1)
  expect(news[0].payload).toMatchObject({ jsonrpc: '2.0', method: 'session/new', params: { cwd: hexDir } })
  expect(news[0].payload.params.systemPrompt).toBe(`<workspace>
${hexDir}
</workspace>

<agent-instructions>
── AGENTS.md ──
@.hex/HEX.md
@SOUL.md
@MEMORY.md

# My rules for you

Be brief.

── .hex/HEX.md ──
How hex works.

── SOUL.md ──
You are hex.

── MEMORY.md ──
Bassim likes short answers.
</agent-instructions>`)
}, 15000)

test('a session learned mid-turn picks up the lines written since the turn began', async () => {
  assistant('msg_old', { type: 'text', text: 'an earlier turn' })
  await Bun.sleep(5)
  activity.busy({ thread: ROOT, channel: CHANNEL, triggers: [] })
  assistant('msg_01', { type: 'text', text: 'first' })
  activity.busy({ thread: ROOT, channel: CHANNEL, session: SESSION, triggers: [] })
  assistant('msg_02', { type: 'text', text: 'second' })
  await until(() => updates().length === 2)
  expect(updates().map(update => update.content.text)).toEqual(['first', 'second'])
  expect(frames().filter(frame => frame.kind === 'turn_started')).toHaveLength(1)
}, 15000)

test('a transcript that appears late and arrives in pieces is read whole', async () => {
  activity.busy({ thread: ROOT, channel: CHANNEL, session: SESSION, triggers: [] })
  await Bun.sleep(1100)
  const text = JSON.stringify({ type: 'assistant', uuid: randomUUID(), timestamp: new Date().toISOString(), sessionId: SESSION, message: { id: 'msg_01', role: 'assistant', content: [{ type: 'text', text: 'héllo wörld' }] } }) + '\n'
  const bytes = Buffer.from(text)
  const middle = bytes.indexOf(Buffer.from('ö')) + 1
  appendFileSync(transcript, bytes.subarray(0, middle))
  await Bun.sleep(1100)
  appendFileSync(transcript, bytes.subarray(middle))
  await until(() => updates().length === 1)
  expect(updates()[0].content.text).toBe('héllo wörld')
}, 15000)

test('an oversized tool result is cut down to fit one frame', async () => {
  activity.busy({ thread: ROOT, channel: CHANNEL, session: SESSION, triggers: [] })
  bash('msg_01', 'toolu_01', 'cat big', 'x'.repeat(200_000) + 'THE END')
  await until(() => updates().some(update => update.sessionUpdate === 'tool_call_update'))
  expect(plaintexts().every(text => Buffer.byteLength(text) <= 65_535)).toBe(true)
  const result = JSON.stringify(updates().find(update => update.sessionUpdate === 'tool_call_update'))
  expect(result).toContain('characters cut')
  expect(result).toContain('THE END')
}, 15000)

test('cancel_turn from the owner cancels the open turn and answers with control_result', async () => {
  activity.busy({ thread: ROOT, channel: CHANNEL, session: SESSION, triggers: [] })
  control({ type: 'cancel_turn', channelId: CHANNEL, requestId: 'r1' }, { from: generateSecretKey() })
  control({ type: 'cancel_turn', channelId: CHANNEL, requestId: 'r2' }, { created_at: Math.floor(Date.now() / 1000) - 600 })
  control({ type: 'switch_model', channelId: CHANNEL, modelId: 'x', requestId: 'r3' })
  control({ type: 'cancel_turn', channelId: CHANNEL, requestId: 'r4' })
  await until(() => frames().some(frame => frame.kind === 'control_result'))

  expect(cancels).toEqual([{ channel: CHANNEL, thread: ROOT, session: SESSION }])
  const results = frames().filter(frame => frame.kind === 'control_result')
  expect(results).toHaveLength(1)
  expect(results[0]).toMatchObject({ channelId: CHANNEL, turnId: null, payload: { type: 'cancel_turn', status: 'sent', requestId: 'r4' } })
}, 15000)

test('turn_liveness every 10 s while a turn is open, none after it completes', async () => {
  activity.busy({ thread: ROOT, channel: CHANNEL, session: SESSION, triggers: [] })
  await until(() => published.length)
  setSystemTime(new Date(Date.now() + 10_500))
  await until(() => frames().some(frame => frame.kind === 'turn_liveness'))
  activity.idle(ROOT)
  setSystemTime(new Date(Date.now() + 10_500))
  await until(() => frames().some(frame => frame.kind === 'turn_completed'))
  await Bun.sleep(1100)
  const liveness = frames().filter(frame => frame.kind === 'turn_liveness')
  expect(liveness).toHaveLength(1)
  expect(liveness[0]).toMatchObject({ channelId: CHANNEL, sessionId: SESSION, payload: { threadRootEventId: ROOT } })
}, 15000)

test('log_follow answers with the buffered tail, then streams new lines until the lease lapses', async () => {
  activity.log('buzz hub: one')
  activity.log('buzz hub: two')
  activity.log('buzz hub: three')
  control({ type: 'log_follow', requestId: 'l1', tail: 2 })
  await until(() => frames().some(frame => frame.kind === 'log'))
  activity.log('buzz hub: four')
  activity.log('x'.repeat(10_000))
  await until(() => frames().filter(frame => frame.kind === 'log').length === 2)
  setSystemTime(new Date(Date.now() + 61_000))
  activity.log('buzz hub: unseen')
  await Bun.sleep(1200)

  const logs = frames().filter(frame => frame.kind === 'log')
  expect(logs.map(frame => frame.payload)).toEqual([
    { lines: ['buzz hub: two', 'buzz hub: three'], dropped: 0 },
    { lines: ['buzz hub: four', 'x'.repeat(4096)], dropped: 0 },
  ])
  expect(logs.every(frame => frame.agentIndex === null && frame.channelId === null && frame.sessionId === null && frame.turnId === null)).toBe(true)
}, 15000)

test('log_follow with nothing buffered still answers, so Desktop knows logs work', async () => {
  control({ type: 'log_follow', requestId: 'l1', tail: 200 })
  await until(() => frames().some(frame => frame.kind === 'log'))
  expect(frames()[0].payload).toEqual({ lines: [], dropped: 0 })
}, 15000)
