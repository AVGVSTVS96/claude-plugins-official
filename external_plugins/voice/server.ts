#!/usr/bin/env bun
import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js'
import { createHmac, timingSafeEqual } from 'crypto'
import { readFileSync, rmSync } from 'fs'
import { connect } from 'net'
import { homedir } from 'os'
import { dirname, join } from 'path'
import { findThread, followAgent, followThread, type Step, type Thread } from './activity.ts'
import { Call, transcript, type Mark, type Speaker, type Task } from './call.ts'
import { CallLog, ending, usage, type CallRecord, type Ending, type Source } from './calls.ts'
import { Changes } from './changes.ts'
import { Asks, type Ask } from './asks.ts'
import { relay } from './relay.ts'
import { Tasks, opener, type HexTask } from './tasks.ts'
import page from './page.html' with { type: 'text' }

const STATE_DIR = join(homedir(), '.claude', 'channels', 'voice')
try {
  for (const line of readFileSync(join(STATE_DIR, '.env'), 'utf8').split('\n')) {
    const match = line.match(/^\s*([A-Z_]+)\s*=\s*(.*?)\s*$/)
    if (match && !process.env[match[1]]) process.env[match[1]] = match[2]
  }
} catch {}

const KEY = process.env.OPENAI_API_KEY
const VOICE = process.env.VOICE
const PORT = Number(process.env.VOICE_PORT ?? 8790)
const API = 'https://api.openai.com/v1/live/sessions'
const TWILIO_SID = process.env.TWILIO_ACCOUNT_SID
const TWILIO_TOKEN = process.env.TWILIO_AUTH_TOKEN
const TWILIO_NUMBER = process.env.TWILIO_NUMBER
const CALLER_NUMBER = process.env.CALLER_NUMBER
const PUBLIC_HOST = process.env.VOICE_PUBLIC_URL?.replace(/^\w+:\/\//, '')
const TOKEN = process.env.VOICE_TOKEN
const HUB = process.env.HEX_HUB
const THREAD = process.env.HEX_CHANNEL?.startsWith('plugin:voice@') ? process.env.HEX_THREAD : undefined
const HEX_STATE = HUB && dirname(dirname(HUB))
const SOCKET = process.env.VOICE_SOCKET
const calls = new CallLog(join(STATE_DIR, 'calls'))
const activity = new Changes()
const follows = new Map<string, () => void>()
let board: Tasks | undefined
let yours: Asks | undefined

const IDENTITY = (() => {
  try {
    return readFileSync(process.env.VOICE_INSTRUCTIONS ?? join(STATE_DIR, 'instructions.md'), 'utf8').trim()
  } catch {
    return 'You are the voice of a personal assistant, talking with the person it works for.'
  }
})()

const VOICE_PROMPT = `${IDENTITY}

Speak warmly and naturally, like a sharp friend: plain words, short answers.

Backchannel policy: Use light backchannels. Acknowledge naturally without competing with the main response.

Interruption policy: Stop speaking when the user interrupts. Listen to what they say.

Delegation policy:
Backend tools:
- Assistant: the real assistant, an agent with the user's files, machines, projects, memory, messages, email, calendar and the web. It can look things up, take actions and run long tasks in the background. It does the thinking; you are its voice.

Delegate to the backend when:
- The user asks anything, says anything that needs an answer, or asks for anything to be done. That is almost every turn, including questions about you, about them, and how a task is going.
- A correction or addition changes work already requested.

Do not delegate to the backend when:
- The user only greets you, thanks you, or asks you to repeat what the backend just said.

Delegate before you answer. While the backend works, say a few words like "one sec" and wait for its result; then say what it gave you. Every answer you give comes from the backend, never from your own knowledge.
Backend work keeps running while you talk, and several tasks can run at once. A task board arrives as quiet context whenever a task starts or finishes.`

type Pending = { resolve: () => void; reject: (error: Error) => void }
type Ring = { delegation: string; offset: number }
type Live = {
  id: string
  shown: Map<string, Ask>
  socket: WebSocket
  call: Call
  record: Omit<CallRecord, 'turns' | 'tasks' | 'moments'>
  pending: Map<string, Pending>
  rings: Ring[]
  spoke: number
  warning?: ReturnType<typeof setTimeout>
  speak?: (audio: string) => void
}
type Placed = { to: string; why?: string; started: string; session?: string }
type Dial = { greeting: string; from: Source; token: string; why?: string }
type Phone = Dial & { openai?: WebSocket; stream?: string; started?: true; refused?: true }

let live: Live | undefined
let ended: string | undefined
let hub: ReturnType<typeof connect> | undefined
let seq = 0
const dials = new Map<string, Dial>()
const placed = new Map<string, Placed>()
const briefing: string[] = []
const RETRIES = [250, 1000, 2000, 4000, 8000]
const WARN_BEFORE = 120_000

const mcp = new Server(
  { name: 'voice', version: '0.1.0' },
  {
    capabilities: { tools: {}, experimental: { 'claude/channel': {} } },
    instructions: `This channel is a live voice call. A fast voice model (OpenAI gpt-live-1) talks with the caller in real time and hands work to you; you do the real work with your tools. The caller hears only the voice model, never your transcript output.

When a call starts you get a "call started" message: send the voice, with note, what it should know right away about the caller and what's going on now, in a few short lines.

Each handoff arrives as <channel source="voice" delegation_id="..."> with the transcript since the last handoff, oldest first, timestamped from the start of the call: "you" is the caller, "voice" is the voice model. Speech transcripts can mishear words, and the latest correction wins. A late line can belong before one you already got; its timestamp places it.

Answer every handoff with say(delegation_id, text): the voice says only what you give it, so you are the one talking. It paraphrases aloud, so write one or two plain spoken sentences, no markdown. Use note for facts the voice should know without saying them yet.

Keep each turn quick so the next handoff reaches you fast. Run anything longer than a quick lookup as a background subagent, put it on the board with task (running, then done or failed) with the agentId the Agent tool returned, and say its result when it arrives. The caller sees each step the agent takes. Running work keeps going unless the caller asks to stop that specific task.
${HEX_STATE ? '\nWork that belongs to a hex thread (a Telegram topic, or a Discord, Buzz or T3 Code thread) goes there with send: it puts the work on the board, the caller sees each step the thread takes, and the board shows it done when the thread is.\n' : ''}

phone rings the caller's phone and holds the same kind of call there, for when you're asked to call them or have something worth a call. Give why, the reason you're calling in a plain sentence: the voice opens with it and the call's record keeps it. Notes you send while it rings reach the voice when the call connects. If nobody answers, the line is busy or the call fails, a message tells you.

hang_up ends the live call once the voice finishes speaking: say goodbye with say first. Use it when the caller asks you to hang up, or when a call you placed has done its job and the caller is done.

When a call ends, name it with title: a few plain words for what it was about, shown in the caller's list of past calls. Once the call's work has settled, call title again for that call with summary (what happened and what you sent where, in two or three plain sentences) and waiting (each thing left for the caller to do or decide, a short line each; an empty list when nothing is).

If the voice plugin restarts or its connection drops during a call, it picks the call back up and you get a "call resumed" message with the call so far.

A result too long to speak goes wherever the caller reads, if this session has another channel to reach them; say where you sent it. Voice page: http://localhost:${PORT}.`,
  },
)

mcp.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: 'say',
      description: 'Give the voice model a result to say aloud for a handoff. It paraphrases, so write one or two plain spoken sentences.',
      inputSchema: {
        type: 'object',
        properties: { delegation_id: { type: 'string' }, text: { type: 'string' } },
        required: ['delegation_id', 'text'],
      },
    },
    {
      name: 'note',
      description: 'Give the voice model a fact to know without saying it now. Pass delegation_id when it belongs to a handoff. While a call you placed is ringing, it waits and reaches the voice when the call connects.',
      inputSchema: {
        type: 'object',
        properties: { text: { type: 'string' }, delegation_id: { type: 'string' } },
        required: ['text'],
      },
    },
    {
      name: 'task',
      description:
        "Put a task on the board the voice model reads to answer status questions: running when it starts, then done or failed. After its call ends, pass that call's id to update its record.",
      inputSchema: {
        type: 'object',
        properties: {
          id: { type: 'string', description: 'A short name that stays the same across updates' },
          call: { type: 'string', description: 'The call the task belongs to, once that call has ended; the live call by default' },
          state: { type: 'string', enum: ['running', 'done', 'failed'] },
          text: { type: 'string', description: 'What it is, and the result once it has one' },
          agent: { type: 'string', description: 'The agentId the Agent tool returned for the background subagent doing it, so the caller sees its steps live' },
        },
        required: ['id', 'state', 'text'],
      },
    },
    ...(HEX_STATE
      ? [
          {
            name: 'ask',
            description:
              "Put one of the caller's open asks on their screen as a card in the call's transcript, by its id from the list you were given: they can tap a choice there or say it.",
            inputSchema: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
          },
          {
            name: 'answer',
            description: "Answer one of the caller's asks with the choice they said aloud: it reaches the thread that asked as their own tap would, and its Telegram buttons say it was answered on a call.",
            inputSchema: {
              type: 'object',
              properties: { id: { type: 'string' }, label: { type: 'string', description: "The option's label, or their own words when none fits" } },
              required: ['id', 'label'],
            },
          },
          {
            name: 'send',
            description:
              "Hand work to a hex thread, by its name or id: your message reaches that thread's session from hex voice, the work goes on the board as running, the caller sees each step the thread takes on it, and the board shows it done or failed when the thread's turn ends with none of its agents still out.",
            inputSchema: {
              type: 'object',
              properties: {
                thread: { type: 'string', description: "The thread's name (like voiceapp) or id" },
                about: { type: 'string', description: "A few words for what you sent, shown to the caller, like 'your orb-bounce feedback'" },
                text: { type: 'string', description: "The message, with the caller's own words" },
              },
              required: ['thread', 'about', 'text'],
            },
          },
        ]
      : []),
    {
      name: 'title',
      description:
        "Name a call in the caller's list of past calls, and once its work has settled, wrap it up: summary is what happened and what you sent where, waiting is what's left for the caller. Each field you pass replaces the call's last one.",
      inputSchema: {
        type: 'object',
        properties: {
          call: { type: 'string', description: 'The call id from the call ended message' },
          title: { type: 'string', description: 'A few plain words for what the call was about' },
          summary: { type: 'string', description: 'Two or three plain sentences' },
          waiting: { type: 'array', items: { type: 'string' }, description: 'What the caller still has to do or decide, one short line each' },
        },
        required: ['call'],
      },
    },
    {
      name: 'phone',
      description: "Ring a phone and hold the call there: the caller's own number unless to is given (E.164, like +14155550123).",
      inputSchema: {
        type: 'object',
        properties: {
          to: { type: 'string' },
          why: { type: 'string', description: "Why you're calling, one plain sentence; the voice opens with it" },
        },
      },
    },
    {
      name: 'hang_up',
      description: 'End the live call once the voice finishes speaking. Say goodbye with say first.',
      inputSchema: { type: 'object', properties: {} },
    },
  ],
}))

mcp.setRequestHandler(CallToolRequestSchema, async request => {
  const args = (request.params.arguments ?? {}) as Record<string, any>
  try {
    if (request.params.name === 'phone') return done(await dial(args.to, args.why))
    if (request.params.name === 'title') return done(name(args.call, args))
    if (request.params.name === 'task') return done(await task(args.id, args.state as Task['state'], args.text, args.call, args.agent))
    if (request.params.name === 'send') return done(await pass(args.thread, args.about, args.text))
    if (request.params.name === 'answer') return done(await answerAsk(args.id, args.label, 'call'))
    if (request.params.name === 'note' && !live && ringing()) {
      briefing.push(args.text)
      return done('the call is still ringing; the voice gets this when it connects')
    }
    if (!live) throw new Error('no call is live')
    switch (request.params.name) {
      case 'say':
        await tell(live, 'say', args.text, args.delegation_id)
        return done('said')
      case 'note':
        await tell(live, 'note', args.text, args.delegation_id)
        return done('noted')
      case 'hang_up':
        return done(await hangUpCall(live))
      case 'ask':
        return done(show(live, args.id))
      default:
        throw new Error(`unknown tool ${request.params.name}`)
    }
  } catch (error) {
    return { content: [{ type: 'text', text: `${request.params.name}: ${error instanceof Error ? error.message : error}` }], isError: true }
  }
})

function done(text: string) {
  return { content: [{ type: 'text', text }] }
}

function send(call: Live, type: string, content: string, delegation?: string) {
  if (call.socket.readyState !== WebSocket.OPEN) return Promise.reject(new Error('the connection to the voice is coming back; try again in a few seconds'))
  const event_id = `${type.split('.')[1]}_${++seq}`
  call.socket.send(JSON.stringify({ type, event_id, delegation_id: delegation ?? null, content }))
  return new Promise<void>((resolve, reject) => call.pending.set(event_id, { resolve, reject }))
}

async function tell(call: Live, kind: 'say' | 'note', text: string, delegation?: string) {
  await send(call, kind === 'say' ? 'session.commentary.append' : 'session.thinking.append', text, delegation)
  remember(call, kind, text)
}

function since(call: Live) {
  return Date.now() - Date.parse(call.record.started)
}

function remember(call: Live, kind: Mark['kind'], text: string, ask?: string) {
  call.call.mark({ at: since(call), kind, text, ...(ask && { ask }) })
  save(call)
}

function save(call: Live) {
  calls.save({ ...call.record, ...call.call.record() })
}

async function task(id: string, state: Task['state'], text: string, call = live?.id ?? ended, agent?: string) {
  if (!call) throw new Error('no call yet')
  if (agent || state !== 'running') stop(call, id)
  const following = live?.id === call && state === 'running' && agent && followAgent(agent, process.env.CLAUDE_CODE_SESSION_ID, step => see(call, id, step))
  if (following) follows.set(`${call} ${id}`, following)
  const result = await mark(call, { ...current(call, id), id, state, text, ...(agent && { agent }) })
  return agent && live?.id === call && !following ? `${result}, but no transcript of agent ${agent} turned up, so the caller won't see its steps` : result
}

async function pass(name: string, about: string, text: string, call = live?.id ?? ended) {
  const thread = findThread(HEX_STATE!, name)
  if (!thread) throw new Error(`no hex thread is named ${name}`)
  const id = call && fresh(call, about)
  if (call && id) {
    await mark(call, { id, state: 'running', text: about, to: thread.name, agent: thread.id })
    watch(call, id, thread, false)
  }
  try {
    await relay(HEX_STATE!, thread.app, { type: 'inbound', thread: thread.id, content: text, meta: { user: 'hex voice', ...(id && { voice_task: `${call}:${id}` }) } })
  } catch (error) {
    if (call && id) see(call, id, { end: 'failed' })
    throw error
  }
  return id ? `sent to ${thread.name}, on the board as ${id}` : `sent to ${thread.name}`
}

// A plugin starts with each call's session, so work a past call sent out is picked back up here,
// read from the start of its thread's session.
function resume() {
  if (!HEX_STATE) return
  const since = Date.now() - 24 * 60 * 60_000
  for (const { id: call, started } of calls.list()) {
    if (Date.parse(started) < since) break
    const latest = new Map(past(call).tasks.map(task => [task.id, task]))
    for (const task of latest.values()) {
      const thread = task.state === 'running' && task.to && task.agent && findThread(HEX_STATE, task.agent)
      if (thread) watch(call, task.id, thread, true)
    }
  }
}

function watch(call: string, id: string, thread: Thread, resumed: boolean) {
  follows.set(`${call} ${id}`, followThread(thread, dirname(HEX_STATE!), `${call}:${id}`, resumed, step => see(call, id, step)))
}

function fresh(call: string, about: string) {
  const base = about.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40) || 'sent'
  let id = base
  for (let n = 2; current(call, id); n++) id = `${base}-${n}`
  return id
}

function current(call: string, id: string): Task | undefined {
  if (live?.id === call) return live.call.task(id)
  const moment = past(call).tasks.findLast(task => task.id === id)
  if (!moment) return
  const { at, ...task } = moment
  return task
}

async function mark(call: string, task: Task) {
  if (live?.id === call) {
    live.call.track(task, Date.now() - Date.parse(live.record.started))
    save(live)
    activity.changed()
    await send(live, 'session.thinking.append', live.call.board())
    return 'board updated'
  }
  const record = past(call)
  calls.save({ ...record, tasks: [...record.tasks, { ...task, at: Date.now() - Date.parse(record.started) }] })
  return 'that call has ended, so only its record changed'
}

function see(call: string, id: string, { line, end }: Step) {
  if (line && live?.id === call && live.call.see(id, line)) activity.changed()
  const task = end && current(call, id)
  if (!task) return
  stop(call, id)
  mark(call, { ...task, state: end }).catch(error => trace(`couldn't mark ${id} ${end}: ${error.message}`))
}

function stop(call: string, id: string) {
  follows.get(`${call} ${id}`)?.()
  follows.delete(`${call} ${id}`)
}

function name(call: string, { title, summary, waiting }: { title?: string; summary?: string; waiting?: string[] }) {
  const change = { ...(title ? { title } : {}), ...(summary ? { summary } : {}), ...(Array.isArray(waiting) ? { waiting } : {}) }
  if (live?.id === call) {
    Object.assign(live.record, change)
    save(live)
  } else calls.save({ ...past(call), ...change })
  if (Array.isArray(waiting)) hexAsks()?.called()
  return 'saved'
}

function past(id: string) {
  const record = calls.get(id)
  if (!record) throw new Error(`no call ${id}`)
  return record
}

async function hangUpCall(call: Live) {
  const asked = Date.now()
  while (live === call && Date.now() - asked < 20_000 && Date.now() - Math.max(asked, call.spoke) < 2000) await Bun.sleep(250)
  if (live !== call) return 'the call had already ended'
  call.socket.send(JSON.stringify({ type: 'session.close', event_id: `close_hex_${++seq}` }))
  return 'hanging up'
}

function deliver(content: string, meta: Record<string, string>) {
  void mcp.notification({ method: 'notifications/claude/channel', params: { content, meta } })
}

function ring(call: Live, { delegation, offset }: Ring) {
  const turns = call.call.handOff()
  deliver(turns.length ? transcript(turns) : '(no new words since the last handoff)', {
    call: call.id,
    delegation_id: delegation,
    at: `${(offset / 1000).toFixed(1)}s`,
  })
  save(call)
}

function hear(call: Live, who: Speaker, event: { delta: string; start_ms: number; end_ms: number }) {
  call.call.hear({ who, text: event.delta, start: event.start_ms, end: event.end_ms })
  while (call.rings[0] && call.rings[0].offset <= event.start_ms) ring(call, call.rings.shift()!)
}

const ENDINGS: Record<Ending, string> = {
  you: 'the caller hung up',
  hex: 'hex ended it',
  dropped: 'the connection dropped',
  expired: 'it hit its time limit',
  'no-connect': 'it never connected',
  'no-answer': 'nobody answered',
  busy: 'the line was busy',
}

function finish(call: Live, reason: string, by?: string) {
  if (live !== call) return
  live = undefined
  ended = call.id
  clearTimeout(call.warning)
  const end = ending(reason, by)
  for (const pending of call.pending.values()) pending.reject(new Error(`the call ended (${reason})`))
  for (const pending of call.rings) ring(call, pending)
  const rest = call.call.handOff()
  call.record = { ...call.record, ended: new Date().toISOString(), end, reason }
  save(call)
  activity.changed()
  deliver(
    [`The call ended: ${ENDINGS[end]} (${reason}). Name it with title.`, ...(rest.length ? ['Last words:', transcript(rest)] : [])].join('\n'),
    { call: call.id, ended: end, reason },
  )
  hub?.write(JSON.stringify({ type: 'renew', thread: THREAD }) + '\n')
  call.socket.onclose = null
  call.socket.close()
}

function failed(record: Pick<CallRecord, 'from' | 'end' | 'reason'> & Partial<CallRecord>, to?: string) {
  const now = new Date().toISOString()
  const id = record.id ?? `failed-${Date.now().toString(36)}`
  calls.save({ id, started: now, turns: [], tasks: [], ...record, ended: now })
  const where = record.from === 'phone-out' ? `Your phone call to ${to ?? 'the caller'}` : `A call from ${record.from === 'phone-in' ? 'the caller\'s phone' : `the ${record.from}`}`
  deliver(
    [`${where} didn't happen: ${ENDINGS[record.end!]} (${record.reason}).`, ...(record.why ? [`You were calling because: ${record.why}`] : [])].join('\n'),
    { call: id, ended: record.end!, reason: record.reason ?? '' },
  )
  trace(`${id} ${record.end}: ${record.reason}`)
}

function ringing() {
  return [...placed.values()].some(call => !call.session)
}

function follow(socket: WebSocket, record: Live['record'], { call = new Call(), speak, hello, about }: { call?: Call; speak?: Live['speak']; hello?: string; about?: Topic } = {}) {
  if (live) {
    live.socket.send(JSON.stringify({ type: 'session.close', event_id: 'close-you-moved' }))
    finish(live, 'moved to a new call', 'close-you-moved')
  }
  const current: Live = { id: record.id, shown: new Map(), socket, call, record, pending: new Map(), rings: [], spoke: 0, speak }
  live = current
  save(current)
  activity.changed()
  hub?.write(JSON.stringify({ type: 'keep', thread: THREAD }) + '\n')
  listen(current, socket)
  warn(current)
  deliver(
    hello ??
      [
        `A call started.${record.why ? ` You placed it because: ${record.why}` : ''}`,
        ...(about ? [about.claude] : []),
        'Send the voice what it should know right away, with note.',
      ].join('\n'),
    { call: record.id, started: 'true', ...(about && { task: about.id }) },
  )
  for (const text of briefing.splice(0)) void tell(current, 'note', text).catch(() => {})
  if (about) whenOpen(socket, () => void send(current, 'session.instructions.append', about.voice).catch(() => {}))
  return current
}

function whenOpen(socket: WebSocket, then: () => void) {
  if (socket.readyState === WebSocket.OPEN) then()
  else socket.addEventListener('open', then, { once: true })
}

// What a call is about when the app starts it on something: what Claude hears, and what the voice
// is told to do first.
type Topic = { id: string; claude: string; voice: string }

function taskTopic(task: HexTask): Topic {
  return {
    id: task.id,
    claude: `The caller started it with Talk it through on a task. ${opener(task)}`,
    voice: `The caller tapped Talk it through on a task, so bring it up now in a sentence or two, then listen. ${opener(task)}`,
  }
}

// Go through them with hex: Claude walks the caller's asks in the app's order, one card at a time.
function walkTopic(asks: Ask[]): Topic {
  const list = asks.map(
    (ask, i) =>
      `${i + 1}. ${ask.id} · ${ask.topic} · ${ask.question}${ask.context ? ` (${ask.context})` : ''} Options: ${ask.options.map(option => `${option.label}${option.pick ? ' (hex’s pick)' : ''}`).join(' / ')}${ask.tag ? ` [${ask.tag}]` : ''}`,
  )
  return {
    id: 'asks',
    claude: [
      `The caller tapped Go through them with hex: walk them through the ${asks.length} things waiting on them, one at a time, in this order. For each, put it on screen with ask, say it in a sentence or two with hex's pick if it has one, and listen. When they say a choice, answer sends it to the thread that asked; when they tap the card instead, a message tells you. Move on when they skip one. Say so when a choice costs money or goes out in their name.`,
      ...list,
    ].join('\n'),
    voice: `The caller wants to go through what's waiting on them, one at a time. Say you'll start with the first one, and hand off to the backend now: it brings each one up.`,
  }
}

function talkAbout(topic: Topic) {
  if (!live) return new Response('No call is live', { status: 409 })
  deliver(`The caller asked for this from the app during the call. ${topic.claude}`, { call: live.id, task: topic.id })
  void send(live, 'session.instructions.append', topic.voice).catch(() => {})
  return new Response(null, { status: 204 })
}

// Puts an ask on the caller's screen as a card in the transcript.
function show(call: Live, id: string) {
  const ask = hexAsks()?.find(id)
  if (!ask) throw new Error(`no open ask ${id}`)
  call.shown.set(id, ask)
  remember(call, 'ask', ask.question, id)
  activity.changed()
  return `showing "${ask.question}" to the caller`
}

// An ask answered on a call, said aloud (via call) or tapped on its card (via app).
async function answerAsk(id: string, label: string, via: string) {
  const asks = hexAsks()
  if (!asks) throw new Error('asks are hex threads, and this voice plugin runs outside hex')
  const ask = asks.find(id) ?? live?.shown.get(id)
  await asks.answer(id, label, via)
  if (live && ask) {
    live.shown.set(id, ask)
    remember(live, 'answered', label, id)
    activity.changed()
  }
  return `sent "${label}" to ${ask?.topic ?? 'its thread'}`
}

function listen(call: Live, socket: WebSocket, attempt = 0) {
  const opened = Date.now()
  socket.onmessage = ({ data }) => {
    const event = JSON.parse(String(data))
    switch (event.type) {
      case 'session.input_transcript.delta':
        return hear(call, 'you', event)
      case 'session.output_transcript.delta':
        call.spoke = Date.now()
        return hear(call, 'voice', event)
      case 'session.delegation.created':
        if (event.delegation?.target === 'client') call.rings.push({ delegation: event.delegation.id, offset: event.offset_ms })
        return
      case 'session.commentary.appended':
      case 'session.thinking.appended':
      case 'session.instructions.appended':
        call.pending.get(event.client_event_id)?.resolve()
        return call.pending.delete(event.client_event_id)
      case 'error': {
        const id = event.client_event_id ?? event.error?.client_event_id ?? event.error?.event_id
        const failed = call.pending.get(id)
        call.pending.delete(id)
        if (failed) return failed.reject(new Error(event.error?.message ?? JSON.stringify(event)))
        return trace(JSON.stringify(event))
      }
      case 'session.output_audio.delta':
        call.spoke = Date.now()
        return call.speak?.(event.delta)
      case 'session.usage.updated':
        call.record.usage = usage(event.usage.seconds, event.context_window?.usage_ratio ?? call.record.usage?.context)
        return
      case 'session.closed':
        if (event.usage) call.record.usage = usage(event.usage.seconds, call.record.usage?.context)
        return finish(call, event.reason ?? 'closed', event.client_event_id)
    }
  }
  socket.onclose = () => reconnect(call, Date.now() - opened < 5000 ? attempt + 1 : 0)
}

function reconnect(call: Live, attempt: number) {
  if (live !== call) return
  for (const pending of call.pending.values()) pending.reject(new Error('the connection to the voice dropped and is coming back; try again in a few seconds'))
  call.pending.clear()
  if (call.speak || attempt >= RETRIES.length) return finish(call, 'connection_lost')
  trace(`lost the connection to ${call.id}, reattaching (try ${attempt + 1})`)
  setTimeout(() => {
    if (live !== call) return
    const socket = sideband(call.id)
    socket.onopen = () => {
      if (live !== call) return socket.close()
      trace(`reattached to ${call.id}`)
      call.socket = socket
      listen(call, socket, attempt)
    }
    socket.onclose = () => reconnect(call, attempt + 1)
  }, RETRIES[attempt])
}

function warn(call: Live) {
  const left = call.record.expires ? Date.parse(call.record.expires) - Date.now() : NaN
  if (!(left > WARN_BEFORE)) return
  call.warning = setTimeout(() => {
    if (live !== call) return
    const at = new Date(Date.parse(call.record.expires!)).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })
    remember(call, 'warned', `Two minutes left: the call ends at ${at}`)
    void send(call, 'session.instructions.append', 'This call hits its time limit in about two minutes. Tell the caller now, in a sentence, so they can wrap up or call back.').catch(() => {})
    deliver(`This call hits its time limit at ${at}, about two minutes from now. Wrap up anything the caller needs before it ends.`, { call: call.id, expires: call.record.expires! })
  }, left - WARN_BEFORE)
}

function sideband(id: string) {
  return new WebSocket(`${API}/${id}/attach`, { headers: { Authorization: `Bearer ${KEY}` } } as any)
}

function expiry(seconds?: number) {
  return seconds ? new Date(seconds * 1000).toISOString() : undefined
}

function base(id: string, from: Source, extra: Partial<CallRecord> = {}): Live['record'] {
  return { id, started: new Date().toISOString(), from, claude: process.env.CLAUDE_CODE_SESSION_ID, ...extra }
}

function recover() {
  const open = calls.list().filter(call => !call.ended)
  for (const [i, { id }] of open.entries()) {
    const record = calls.get(id)
    if (!record) continue
    const latest = i === 0 && KEY && (record.from === 'app' || record.from === 'web') && !(record.expires && Date.parse(record.expires) < Date.now())
    if (latest) reattach(record)
    else closeOut(record)
  }
}

function closeOut(record: CallRecord) {
  const heard = Math.max(0, ...record.turns.map(turn => turn.at), ...record.tasks.map(task => task.at), ...(record.moments ?? []).map(mark => mark.at))
  calls.save({ ...record, ended: new Date(Date.parse(record.started) + heard).toISOString(), end: 'dropped', reason: 'the voice plugin restarted and the call was gone' })
  trace(`closed out ${record.id}: it never got an end`)
}

function reattach(record: CallRecord) {
  const socket = sideband(record.id)
  socket.onopen = () => {
    const { turns, tasks, moments, ...rest } = record
    const so = turns.slice(-40).map(({ who, at, text }) => ({ who, text, start: at }))
    trace(`picked ${record.id} back up after a restart`)
    follow(socket, rest, {
      call: Call.resume(record),
      hello: [
        `A call resumed: the voice plugin restarted during call ${record.id} and picked it back up. The caller is still on it, and the voice kept its own memory of the call.`,
        ...(record.why ? [`You placed it because: ${record.why}`] : []),
        ...(so.length ? ['The call so far:', transcript(so)] : []),
        ...(tasks.length ? [Call.resume(record).board()] : []),
      ].join('\n'),
    })
  }
  socket.onclose = () => {
    if (live?.id !== record.id) closeOut(record)
  }
}

async function dial(to = CALLER_NUMBER, why?: string) {
  if (!KEY || !TWILIO_SID || !TWILIO_TOKEN || !TWILIO_NUMBER || !PUBLIC_HOST)
    throw new Error(`phone calls need TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, TWILIO_NUMBER and VOICE_PUBLIC_URL in ${join(STATE_DIR, '.env')}`)
  if (!to) throw new Error('no number to call: pass to, or set CALLER_NUMBER')
  const token = crypto.randomUUID()
  const greeting = why
    ? `You placed this phone call because: ${why}. Greet them briefly and tell them why you're calling, then listen.`
    : 'You placed this phone call. Greet them briefly first, then listen.'
  dials.set(token, { greeting, from: 'phone-out', token, why })
  placed.set(token, { to, why, started: new Date().toISOString() })
  setTimeout(() => placed.get(token)?.session || placed.delete(token), 300_000)
  const response = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${TWILIO_SID}/Calls.json`, {
    method: 'POST',
    headers: { Authorization: `Basic ${btoa(`${TWILIO_SID}:${TWILIO_TOKEN}`)}` },
    body: new URLSearchParams({
      To: to,
      From: TWILIO_NUMBER,
      Url: `https://${PUBLIC_HOST}/twilio/${token}/twiml`,
      StatusCallback: `https://${PUBLIC_HOST}/twilio/status/${token}`,
    }),
  })
  if (!response.ok) {
    dials.delete(token)
    placed.delete(token)
    const reason = `Twilio refused the call: ${problem(await response.text())}`
    failed({ from: 'phone-out', end: 'no-connect', reason, why }, to)
    throw new Error(reason)
  }
  return `ringing ${to}; if nobody answers or it fails, a message tells you`
}

async function phoneStatus(request: Request, token: string) {
  const form = await signed(request)
  if (!form) return new Response('forbidden', { status: 403 })
  const call = placed.get(token)
  const state = String(form.get('CallStatus'))
  trace(`Twilio call ${state}${call?.session ? ` (${call.session})` : ''}`)
  if (!call || !['completed', 'busy', 'no-answer', 'failed', 'canceled'].includes(state)) return new Response(null, { status: 204 })
  placed.delete(token)
  dials.delete(token)
  if (call.session) return new Response(null, { status: 204 })
  if (!ringing()) briefing.length = 0
  const error = form.get('ErrorCode') ? `, Twilio error ${form.get('ErrorCode')}` : ''
  failed(
    {
      id: String(form.get('CallSid') ?? '') || undefined,
      from: 'phone-out',
      started: call.started,
      why: call.why,
      end: state === 'busy' ? 'busy' : state === 'no-answer' ? 'no-answer' : 'no-connect',
      reason: state === 'completed' ? `the phone picked up for ${form.get('CallDuration') ?? 0}s but the voice never joined${error}` : `Twilio: ${state}${error}`,
    },
    call.to,
  )
  return new Response(null, { status: 204 })
}

function answer(twilio: Bun.ServerWebSocket<Phone>) {
  const openai = new WebSocket(API, { headers: { Authorization: `Bearer ${KEY}` } } as any)
  twilio.data.openai = openai
  openai.onopen = () =>
    openai.send(JSON.stringify({
      type: 'session.start',
      session: session({ audio: { format: { type: 'audio/pcmu', rate: 8000 }, ...(VOICE ? { output: { voice: VOICE } } : {}) } }),
    }))
  openai.addEventListener('message', ({ data }) => {
    const event = JSON.parse(String(data))
    if (event.type === 'error' && !twilio.data.started) refuse(twilio, `OpenAI refused the phone session: ${event.error?.message ?? JSON.stringify(event.error)}`)
    if (event.type !== 'session.started') return
    twilio.data.started = true
    const call = placed.get(twilio.data.token)
    if (call) call.session = event.session.id
    const record = base(event.session.id, twilio.data.from, { voice: VOICE, why: twilio.data.why, expires: expiry(event.session.expires_at) })
    follow(openai, record, { speak: audio => twilio.send(JSON.stringify({ event: 'media', streamSid: twilio.data.stream, media: { payload: audio } })) })
    openai.send(JSON.stringify({ type: 'session.instructions.append', delegation_id: null, content: twilio.data.greeting }))
  })
  openai.addEventListener('close', ({ code, reason }) => {
    trace(`OpenAI closed the phone session (${code} ${reason})`)
    if (!twilio.data.started) refuse(twilio, `OpenAI closed the phone session before it started (${code} ${reason || 'no reason'})`)
    twilio.close()
  })
}

function refuse(twilio: Bun.ServerWebSocket<Phone>, reason: string) {
  if (twilio.data.refused) return
  twilio.data.refused = true
  const call = placed.get(twilio.data.token)
  placed.delete(twilio.data.token)
  failed({ from: twilio.data.from, end: 'no-connect', reason, why: twilio.data.why, ...(call ? { started: call.started } : {}) }, call?.to)
  twilio.close()
}

function problem(text: string) {
  try {
    const { error, message } = JSON.parse(text)
    return String(error?.message ?? message ?? text).slice(0, 300)
  } catch {
    return text.slice(0, 300)
  }
}

function trace(line: string) {
  process.stderr.write(`voice: ${line}\n`)
}

function twiml(body: string) {
  return new Response(`<Response>${body}</Response>`, { headers: { 'content-type': 'text/xml' } })
}

function stream(token: string) {
  return twiml(`<Connect><Stream url="wss://${PUBLIC_HOST}/twilio/${token}" /></Connect>`)
}

async function signed(request: Request) {
  const form = await request.formData()
  const params = [...form.keys()].sort().map(key => key + form.get(key)).join('')
  const signature = createHmac('sha1', TWILIO_TOKEN ?? '').update(`https://${PUBLIC_HOST}${new URL(request.url).pathname}${params}`).digest('base64')
  return TWILIO_TOKEN && same(request.headers.get('x-twilio-signature') ?? '', signature) ? form : undefined
}

async function pickUp(request: Request) {
  const form = await signed(request)
  if (!form || form.get('From') !== CALLER_NUMBER) return twiml('<Reject />')
  const token = crypto.randomUUID()
  dials.set(token, { greeting: 'They called you. Answer briefly, then listen.', from: 'phone-in', token })
  return stream(token)
}

function hearPhone(twilio: Bun.ServerWebSocket<Phone>, raw: string | Buffer) {
  const message = JSON.parse(String(raw))
  if (message.event === 'start') twilio.data.stream = message.start.streamSid
  if (message.event === 'start' || message.event === 'stop') trace(`Twilio stream ${message.event}`)
  if (message.event === 'media' && twilio.data.started)
    twilio.data.openai?.send(JSON.stringify({ type: 'session.input_audio.append', audio: message.media.payload }))
  if (message.event === 'stop') hangUp(twilio)
}

function hangUp(twilio: Bun.ServerWebSocket<Phone>) {
  const openai = twilio.data.openai
  if (openai?.readyState === WebSocket.OPEN) openai.send(JSON.stringify({ type: 'session.close', event_id: 'close-you-phone' }))
}

function session(extra: object = {}) {
  return {
    model: 'gpt-live-1',
    instructions: VOICE_PROMPT,
    delegation: { type: 'client' },
    ...extra,
  }
}

async function start(request: Request) {
  if (!KEY) return new Response(`Set OPENAI_API_KEY in ${join(STATE_DIR, '.env')}`, { status: 503 })
  const { sdp, voice = VOICE, from: origin, about } = (await request.json()) as { sdp?: string; voice?: string; from?: string; about?: string }
  if (!sdp) return new Response('An SDP offer is required', { status: 400 })
  const from = origin === 'app' ? 'app' : 'web'
  let response: Response
  try {
    response = await fetch(API, {
      method: 'POST',
      headers: { Authorization: `Bearer ${KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        session: session({
          ...(voice ? { audio: { output: { voice } } } : {}),
          client: { data_channel: { allowed_client_events: ['session.input_audio.mute', 'session.input_audio.unmute', 'session.close'] } },
        }),
        transport: { type: 'webrtc', sdp },
      }),
    })
  } catch (error) {
    const reason = `couldn't reach OpenAI: ${error instanceof Error ? error.message : error}`
    failed({ from, end: 'no-connect', reason, voice })
    return new Response(reason, { status: 502 })
  }
  if (!response.ok) {
    const text = await response.text()
    failed({ from, end: 'no-connect', reason: `OpenAI refused the call (${response.status}): ${problem(text)}`, voice })
    return new Response(text, { status: response.status })
  }
  const result = (await response.json()) as { session: { id: string; expires_at?: number } }
  follow(sideband(result.session.id), base(result.session.id, from, { voice, expires: expiry(result.session.expires_at) }), { about: topicOf(about) })
  return Response.json(result, { status: 201 })
}

const PAUSED = "The caller's phone took over their audio, a phone call or Siri: they can't hear you or talk. Stay quiet until they're back."
const RESUMED = "The caller is back. If you were in the middle of something, pick it back up in a sentence."

async function interruption(request: Request, id: string) {
  const { kind, text } = (await request.json().catch(() => ({}))) as { kind?: string; text?: string }
  if (kind !== 'paused' && kind !== 'resumed') return new Response('kind is paused or resumed', { status: 400 })
  if (live?.id !== id) return new Response('That call is not live', { status: 409 })
  remember(live, kind, text || (kind === 'paused' ? 'Your phone took over the audio' : 'Back on the call'))
  void send(live, 'session.instructions.append', kind === 'paused' ? PAUSED : RESUMED).catch(() => {})
  return new Response(null, { status: 204 })
}

function same(a: string, b: string) {
  const left = Buffer.from(a)
  const right = Buffer.from(b)
  return left.length === right.length && timingSafeEqual(left, right)
}

function allowed(request: Request) {
  return !TOKEN || same(request.headers.get('authorization') ?? '', `Bearer ${TOKEN}`)
}

function home(request: Request) {
  const local = !request.headers.get('x-forwarded-for')
  return new Response(String(page).replace('__VOICE_TOKEN__', local && TOKEN ? TOKEN : ''), { headers: { 'content-type': 'text/html; charset=utf-8' } })
}

function joinHub() {
  const socket = (hub = connect(HUB!))
  let buffer = ''
  socket.setEncoding('utf8')
  socket.on('connect', () => {
    setTimeout(() => socket.write(JSON.stringify({ type: 'hello', thread: THREAD, session: process.env.CLAUDE_CODE_SESSION_ID }) + '\n'), 1000)
  })
  socket.on('data', (chunk: string) => {
    buffer += chunk
    for (let end = buffer.indexOf('\n'); end >= 0; end = buffer.indexOf('\n')) {
      const event = JSON.parse(buffer.slice(0, end))
      buffer = buffer.slice(end + 1)
      if (event.type === 'inbound') deliver(event.content, event.meta ?? {})
    }
  })
  socket.on('close', () => setTimeout(joinHub, 2000))
  socket.on('error', () => {})
}

mcp.oninitialized = () => {
  if (HUB && THREAD) joinHub()
  recover()
}

await mcp.connect(new StdioServerTransport())
resume()
process.stdin.on('end', () => process.exit(0))
process.stdin.on('close', () => process.exit(0))

async function showActivity(url: URL) {
  const after = url.searchParams.get('after')
  if (after) await activity.changes(Number(after), 25_000)
  return Response.json({ version: activity.version, call: live?.id ?? null, tasks: live?.call.activity() ?? [], asks: live ? cards(live) : [] })
}

// The asks put on screen in this call, in order, each with its answer once it has one.
function cards(call: Live) {
  const marks = call.call.record().moments
  return marks
    .filter(mark => mark.kind === 'ask' && call.shown.has(mark.ask!))
    .map(mark => ({ at: mark.at, ask: call.shown.get(mark.ask!)!, answer: marks.findLast(answer => answer.kind === 'answered' && answer.ask === mark.ask)?.text }))
}

function topicOf(about?: string): Topic | undefined {
  if (about === 'asks') return hexAsks() && walkTopic(hexAsks()!.view.asks)
  const task = about ? hexTasks()?.get(about) : undefined
  return task && taskTopic(task)
}

function hexTasks() {
  return HEX_STATE ? (board ??= new Tasks(HEX_STATE, dirname(HEX_STATE))) : undefined
}

function hexAsks() {
  return HEX_STATE ? (yours ??= new Asks(HEX_STATE)) : undefined
}

async function showTasks(url: URL, tasks: Tasks) {
  const after = url.searchParams.get('after')
  if (after) await tasks.changes(Number(after), 25_000)
  return Response.json({ version: tasks.version, tasks: tasks.rows() })
}

// The Tasks button's counts: threads that need you and are working, and how many things are yours.
async function showSummary(url: URL, tasks: Tasks, asks: Asks) {
  const version = () => tasks.counts.version + asks.counts.version
  const after = Number(url.searchParams.get('after'))
  if (after === version()) await Promise.race([tasks.counts.changes(tasks.counts.version, 25_000), asks.counts.changes(asks.counts.version, 25_000)])
  return Response.json({ version: version(), ...tasks.summary, yours: asks.view.asks.length })
}

async function showAsks(url: URL, asks: Asks) {
  const after = url.searchParams.get('after')
  if (after) await asks.changes(Number(after), 25_000)
  return Response.json({ version: asks.version, ...asks.view })
}

// What the app's tap on an ask, a stuck item or a new result does. Each answers once the hub has it;
// the change itself comes back through the list.
async function askRoutes(request: Request, url: URL) {
  const asks = hexAsks()
  if (!asks) return new Response('Asks are hex threads, and this voice plugin runs outside hex', { status: 404 })
  if (url.pathname === '/asks' && request.method === 'GET') {
    if (!url.searchParams.get('after')) asks.opened()
    return showAsks(url, asks)
  }
  if (url.pathname === '/asks/check' && request.method === 'GET') return asks.lastCheck ? Response.json(asks.lastCheck) : new Response('No check yet', { status: 404 })
  if (url.pathname === '/asks/talk' && request.method === 'POST') return talkAbout(walkTopic(asks.view.asks))
  const [, kind, id, verb] = url.pathname.match(/^\/(asks|stuck|fresh)\/([^/]+)\/(answer|undo|act|read)$/) ?? []
  if (!kind || request.method !== 'POST') return new Response('404', { status: 404 })
  const key = decodeURIComponent(id!)
  try {
    if (kind === 'asks' && verb === 'answer') {
      const { label } = (await request.json()) as { label?: string }
      if (!label) return new Response('An answer needs its label', { status: 400 })
      const shown = live?.shown.has(key)
      await answerAsk(key, label, 'app')
      if (shown) deliver(`The caller tapped "${label}" on the card for ${key}; it's sent to its thread.`, { call: live!.id })
    } else if (kind === 'asks' && verb === 'undo') await asks.undo(key, 'app')
    else if (kind === 'stuck' && verb === 'act') await asks.act(key)
    else if (kind === 'fresh' && verb === 'read') asks.read(key)
    else return new Response('404', { status: 404 })
  } catch (error) {
    return new Response(error instanceof Error ? error.message : String(error), { status: 409 })
  }
  return new Response(null, { status: 204 })
}

function taskRoutes(request: Request, url: URL) {
  const tasks = hexTasks()
  if (!tasks) return new Response('Tasks are hex threads, and this voice plugin runs outside hex', { status: 404 })
  if (url.pathname === '/tasks' && request.method === 'GET') return showTasks(url, tasks)
  if (url.pathname === '/tasks/summary' && request.method === 'GET') return showSummary(url, tasks, hexAsks()!)
  const [, id, talking] = url.pathname.match(/^\/tasks\/([^/]+)(\/talk)?$/) ?? []
  const task = id && tasks.get(decodeURIComponent(id))
  if (!task) return new Response('404', { status: 404 })
  if (talking && request.method === 'POST') return talkAbout(taskTopic(task))
  if (!talking && request.method === 'GET') return Response.json({ ...task, ...hexAsks()!.of(task.id) })
}

async function listCalls(url: URL) {
  const after = url.searchParams.get('after')
  if (after) await calls.changes(Number(after), 25_000)
  return Response.json({ version: calls.version, live: live?.id, calls: calls.list() })
}

function routes(request: Request) {
  const { pathname } = new URL(request.url)
  if (pathname === '/session' && request.method === 'POST') return start(request)
  if (pathname === '/session' && request.method === 'DELETE') {
    live?.socket.send(JSON.stringify({ type: 'session.close', event_id: 'close-you-app' }))
    return new Response(null, { status: 204 })
  }
  if (pathname === '/calls' && request.method === 'GET') return listCalls(new URL(request.url))
  if (pathname === '/activity' && request.method === 'GET') return showActivity(new URL(request.url))
  if (pathname === '/tasks' || pathname.startsWith('/tasks/')) return taskRoutes(request, new URL(request.url))
  if (/^\/(asks|stuck|fresh)(\/|$)/.test(pathname)) return askRoutes(request, new URL(request.url))
  const [, callId, moments] = pathname.match(/^\/calls\/([\w-]+)(\/moments)?$/) ?? []
  if (callId && moments && request.method === 'POST') return interruption(request, callId)
  if (callId && !moments && request.method === 'GET') {
    const record = calls.get(callId)
    return record ? Response.json(record) : new Response('404', { status: 404 })
  }
  if (callId && !moments && request.method === 'DELETE') {
    if (live?.id === callId) return new Response('That call is still going', { status: 409 })
    return new Response(null, { status: calls.delete(callId) ? 204 : 404 })
  }
  if (pathname === '/phone' && request.method === 'POST')
    return dial().then(text => new Response(text), error => new Response(error.message, { status: 502 }))
}

if (SOCKET) rmSync(SOCKET, { force: true })
Bun.serve<Phone>({
  ...(SOCKET ? { unix: SOCKET } : { port: PORT, hostname: '127.0.0.1' }),
  idleTimeout: 40,
  fetch(request, server) {
    const { pathname } = new URL(request.url)
    if (pathname === '/twilio/incoming' && request.method === 'POST') return pickUp(request)
    const [, statusToken] = pathname.match(/^\/twilio\/status\/([\w-]+)$/) ?? []
    if (statusToken && request.method === 'POST') return phoneStatus(request, statusToken)
    const [, token, twimlPath] = pathname.match(/^\/twilio\/([\w-]+)(\/twiml)?$/) ?? []
    const dialed = dials.get(token)
    if (token) trace(`Twilio ${request.method} ${twimlPath ? 'TwiML' : 'stream'}, ${dialed ? 'known' : 'unknown'} token`)
    if (dialed && twimlPath) return stream(token)
    if (dialed && dials.delete(token)) return server.upgrade(request, { data: { ...dialed } }) ? undefined : new Response('upgrade failed', { status: 400 })
    if (pathname === '/') return home(request)
    if (!allowed(request)) return new Response('Unauthorized', { status: 401, headers: { 'www-authenticate': 'Bearer' } })
    return routes(request) ?? new Response('404', { status: 404 })
  },
  websocket: {
    open: answer,
    message: hearPhone,
    close: hangUp,
  },
})
