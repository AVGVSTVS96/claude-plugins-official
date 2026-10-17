import { createHmac, timingSafeEqual } from 'crypto'
import { readFileSync } from 'fs'
import { dirname, join } from 'path'
import { findThread, followAgent, followThread, type Step, type Thread } from './activity.ts'
import { Call, transcript, type Mark, type Speaker, type Task } from './call.ts'
import { CallLog, ending, usage, type CallRecord, type Ending, type Source } from './calls.ts'
import { Changes } from './changes.ts'
import { PORT, STATE_DIR, env } from './env.ts'
import { Asks, type Ask } from './asks.ts'
import { relay } from './relay.ts'
import { Tasks, opener, type HexTask } from './tasks.ts'
import { begin, title as oneWord, type Held, type VoiceLine } from '../../hub/hub.ts'
import page from './page.html' with { type: 'text' }

const KEY = env.OPENAI_API_KEY
const VOICE = env.VOICE
const API = `${env.OPENAI_BASE_URL ?? 'https://api.openai.com/v1'}/live/sessions`
const TWILIO_SID = env.TWILIO_ACCOUNT_SID
const TWILIO_TOKEN = env.TWILIO_AUTH_TOKEN
const TWILIO_NUMBER = env.TWILIO_NUMBER
const CALLER_NUMBER = env.CALLER_NUMBER
const PUBLIC_HOST = env.VOICE_PUBLIC_URL?.replace(/^\w+:\/\//, '')
const TOKEN = env.VOICE_TOKEN
const calls = new CallLog(join(STATE_DIR, 'calls'))
const activity = new Changes()
const follows = new Map<string, () => void>()
let board: Tasks
let yours: Asks

const IDENTITY = (() => {
  try {
    return readFileSync(env.VOICE_INSTRUCTIONS ?? join(STATE_DIR, 'instructions.md'), 'utf8').trim()
  } catch {
    return 'You are the voice of a personal assistant, on a live call with the person it works for. Speak warmly and naturally, like a sharp friend: plain words, short answers.'
  }
})()

const VOICE_PROMPT = `${IDENTITY}

Backchannel policy: Use light backchannels. Acknowledge naturally without competing with the main response.

Interruption policy: Stop speaking when the caller interrupts. Listen to what they say.

Delegation policy:
Backend tools:
- Assistant: the agent behind your voice, with the caller's files, machines, projects, memory, messages, email, calendar and the web. It looks things up, takes actions and runs long tasks in the background.

Delegate to the backend when:
- The caller asks something or wants something done, including questions about you, about them, and how a task is going.
- A correction or addition changes work already requested.

Do not delegate to the backend when:
- You can answer from the conversation or a still-current result, like repeating what the backend just said.
- The caller only greets or thanks you.
- You need a brief clarification to understand the request.

Delegate before you answer anything that depends on backend work. While it works, tell the caller in a few words of your own that you're on it, then wait for its result without guessing it, and say what it gave you. Facts you give come from the backend or the conversation, never from your own knowledge.
Backend work keeps running while you talk, and several tasks can run at once. Each time a task starts or finishes, its new state arrives as quiet context.`

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
  changes: Changes
  spoke: number
  warning?: ReturnType<typeof setTimeout>
  speak?: (audio: string) => void
}
type Placed = { to: string; why?: string; started: string; session?: string }
type Dial = { greeting: string; from: Source; token: string; why?: string }
type Phone = Dial & { openai?: WebSocket; stream?: string; started?: true; refused?: true }

// What the call engine asks of the voice thread's hub: hand its session a message, hold the session
// for a call (keep) or let it start over for the next (renew), wait for a renew on its way, and
// name the session now serving the thread.
export type Hub = {
  deliver: (content: string, meta: Record<string, string>) => void
  keep: () => void
  renew: () => void
  renewal: () => Promise<void>
  session: () => string | undefined
}

let hub: Hub
let HEX_STATE: string
// Every step to the hub in the order the calls take them; a new call's first step waits out the
// last call's renew, so the new call's words reach the new session.
let lane = Promise.resolve()
let live: Live | undefined
let ended: string | undefined
let seq = 0
const dials = new Map<string, Dial>()
const placed = new Map<string, Placed>()
const briefing: string[] = []
const RETRIES = [250, 1000, 2000, 4000, 8000]
const WARN_BEFORE = 120_000

// The voice session's tools, which the hub hands here.
export async function tool(name: string, args: Record<string, any>): Promise<string> {
  if (name === 'phone') return dial(args.to, args.why)
  if (name === 'title') return title(args.call, args)
  if (name === 'task') return task(args.id, args.state as Task['state'], args.text, args.call, args.agent)
  if (name === 'send') return pass(args.thread, args.about, args.text, args.app, args.channel)
  if (name === 'answer') return answerAsk(args.id, args.label, 'call')
  if (name === 'note' && !live && ringing()) {
    briefing.push(args.text)
    return 'the call is still ringing; the voice gets this when it connects'
  }
  if (!live) throw new Error('no call is live')
  switch (name) {
    case 'say':
      await tell(live, 'say', args.text, args.delegation_id)
      return 'said'
    case 'note':
      await tell(live, 'note', args.text, args.delegation_id)
      return 'noted'
    case 'hang_up':
      return hangUpCall(live)
    case 'ask':
      return show(live, args.id)
    default:
      throw new Error(`unknown tool ${name}`)
  }
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
  calls.save(whole(call))
  call.changes.changed()
}

function whole(call: Live): CallRecord {
  return { ...call.record, ...call.call.record() }
}

async function task(id: string, state: Task['state'], text: string, call = live?.id ?? ended, agent?: string) {
  if (!call) throw new Error('no call yet')
  if (agent || state !== 'running') stop(call, id)
  const following = live?.id === call && state === 'running' && agent && followAgent(agent, hub.session(), step => see(call, id, step))
  if (following) follows.set(`${call} ${id}`, following)
  const result = await mark(call, { ...current(call, id), id, state, text, ...(agent && { agent }) })
  return agent && live?.id === call && !following ? `${result}, but no transcript of agent ${agent} turned up, so the caller won't see its steps` : result
}

// app: no thread has the work yet, so one named name opens there with it.
async function pass(name: string, about: string, text: string, app?: string, where?: string, call = live?.id ?? ended) {
  const known = app ? undefined : findThread(HEX_STATE, name)
  if (!app && !known) throw new Error(`no hex thread is named ${name}; pass app to open one`)
  const id = call && fresh(call, about)
  const meta = { user: 'hex voice', ...(id && { voice_task: `${call}:${id}` }) }
  let thread = known
  if (app) {
    const opened = await begin(app, oneWord(name), { content: text, meta }, { about: `From a call: ${about}`, where })
    thread = { app, id: opened.thread, name, threads: join(HEX_STATE, app, 'threads.json') }
  }
  if (call && id) {
    await mark(call, { id, state: 'running', text: about, to: thread!.name, agent: thread!.id })
    watch(call, id, thread!, !!app)
  }
  if (!app) {
    try {
      await relay(HEX_STATE, thread!.app, { type: 'inbound', thread: thread!.id, content: text, meta })
    } catch (error) {
      if (call && id) see(call, id, { end: 'failed' })
      throw error
    }
  }
  const sent = app ? `opened ${name} in ${app}` : `sent to ${thread!.name}`
  return id ? `${sent}, on the board as ${id}` : sent
}

// Work a past call sent out is picked back up when the engine starts, read from the start of its
// thread's session.
function resume() {
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
  follows.set(`${call} ${id}`, followThread(thread, dirname(HEX_STATE), `${call}:${id}`, resumed, step => (step.end ? settle(call, id, thread, step.end) : see(call, id, step))))
}

// The turn that took the message in has ended, but the thread's work may not have: the board keeps
// a thread working while its background agents, workflows or next turns run, so the task follows
// the board's row until it rests.
function settle(call: string, id: string, thread: Thread, end: NonNullable<Step['end']>) {
  const check = () => {
    const row = board.get(`${thread.app}:${thread.id}`)
    if (row?.state === 'working') see(call, id, { line: newest(row) })
    else see(call, id, { end: row?.state === 'failed' ? 'failed' : end })
  }
  follows.set(`${call} ${id}`, board.listen(check))
  check()
}

function newest(row: HexTask) {
  return row.agents.find(agent => agent.state === 'working' && agent.line)?.line ?? row.line
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
    await send(live, 'session.thinking.append', live.call.change(task.id))
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

function title(call: string, { title, summary, waiting }: { title?: string; summary?: string; waiting?: string[] }) {
  const change = { ...(title ? { title } : {}), ...(summary ? { summary } : {}), ...(Array.isArray(waiting) ? { waiting } : {}) }
  if (live?.id === call) {
    Object.assign(live.record, change)
    save(live)
  } else calls.save({ ...past(call), ...change })
  if (Array.isArray(waiting)) yours.called()
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
  const time = clock()
  toHub(() => hub.deliver(content, { ...meta, time }))
}

function toHub(step: () => void | Promise<void>) {
  lane = lane.then(step).catch(error => trace(`the hub step failed: ${error}`))
}

function clock() {
  return new Date().toLocaleString('en-US', { weekday: 'long', month: 'long', day: 'numeric', hour: 'numeric', minute: '2-digit', timeZoneName: 'short' })
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
  call.changes.changed()
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
  toHub(hub.renew)
  call.socket.onclose = null
  call.socket.close()
}

function failed(record: Pick<CallRecord, 'from' | 'end' | 'reason'> & Partial<CallRecord>, to?: string) {
  const now = new Date().toISOString()
  const id = record.id ?? `failed-${Date.now().toString(36)}`
  calls.save({ id, started: now, turns: [], tasks: [], ...record, ended: now })
  const where = record.from === 'phone-out' ? `Your phone call to ${to ?? 'the caller'}` : `A call from ${record.from === 'phone-in' ? 'the caller\'s phone' : record.from === 'discord' ? 'a Discord voice channel' : `the ${record.from}`}`
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
  const current: Live = { id: record.id, shown: new Map(), socket, call, record, pending: new Map(), rings: [], changes: new Changes(), spoke: 0, speak }
  live = current
  save(current)
  activity.changed()
  toHub(async () => {
    await hub.renewal()
    hub.keep()
    current.record.claude = hub.session()
  })
  listen(current, socket)
  warn(current)
  deliver(
    hello ??
      [
        `A call started.${record.why ? ` You placed it because: ${record.why}` : ''}`,
        ...(about ? [about.claude] : []),
        'Send the voice what it should know right away, with note.',
      ].join('\n'),
    { call: record.id, started: 'true', from: record.from, ...(about && { task: about.id }) },
  )
  for (const text of briefing.splice(0)) void tell(current, 'note', text).catch(() => {})
  return current
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
  const ask = yours.find(id)
  if (!ask) throw new Error(`no open ask ${id}`)
  call.shown.set(id, ask)
  remember(call, 'ask', ask.question, id)
  activity.changed()
  return `showing "${ask.question}" to the caller`
}

// An ask answered on a call, said aloud (via call) or tapped on its card (via app).
async function answerAsk(id: string, label: string, via: string) {
  const ask = yours.find(id) ?? live?.shown.get(id)
  await yours.answer(id, label, via)
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
  return { id, started: new Date().toISOString(), from, ...extra }
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

// A call lost with the engine ends like any other: Claude names it, and the session renews.
function closeOut(record: CallRecord) {
  const heard = Math.max(0, ...record.turns.map(turn => turn.at), ...record.tasks.map(task => task.at), ...(record.moments ?? []).map(mark => mark.at))
  const reason = "hex's service restarted and the call was gone"
  calls.save({ ...record, ended: new Date(Date.parse(record.started) + heard).toISOString(), end: 'dropped', reason })
  trace(`closed out ${record.id}: it never got an end`)
  deliver(`The call ended: ${ENDINGS.dropped} (${reason}). Name it with title.`, { call: record.id, ended: 'dropped', reason })
  if (!live) toHub(hub.renew)
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
        `A call resumed: hex's service restarted during call ${record.id} and picked it back up. The caller is still on it, and the voice kept its own memory of the call.`,
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

// A call whose audio the engine passes through one WebSocket session: a phone call, as μ-law at
// 8 kHz, or a line another client holds, as PCM at 24 kHz. A session that never starts is refused once.
type Passed = {
  name: string
  from: Source
  greeting: string
  why?: string
  format: { type: string; rate: number }
  play: (audio: string) => void
  started: (session: string) => void
  refused: (reason: string) => void
  closed: () => void
}

function passThrough({ name, from, greeting, why, format, play, started, refused, closed }: Passed) {
  const openai = new WebSocket(API, { headers: { Authorization: `Bearer ${KEY}` } } as any)
  let up = false
  let refusing = false
  const refuse = (reason: string) => {
    if (up || refusing) return
    refusing = true
    refused(reason)
  }
  openai.onopen = () =>
    openai.send(JSON.stringify({
      type: 'session.start',
      session: session({ audio: { format, ...(VOICE ? { output: { voice: VOICE } } : {}) } }, greeting),
    }))
  openai.addEventListener('message', ({ data }) => {
    const event = JSON.parse(String(data))
    if (event.type === 'error') refuse(`OpenAI refused the ${name} session: ${event.error?.message ?? JSON.stringify(event.error)}`)
    if (event.type !== 'session.started') return
    up = true
    started(event.session.id)
    follow(openai, base(event.session.id, from, { voice: VOICE, why, expires: expiry(event.session.expires_at) }), { speak: play })
  })
  openai.addEventListener('close', ({ code, reason }) => {
    trace(`OpenAI closed the ${name} session (${code} ${reason})`)
    refuse(`OpenAI closed the ${name} session before it started (${code} ${reason || 'no reason'})`)
    closed()
  })
  return openai
}

function answer(twilio: Bun.ServerWebSocket<Phone>) {
  twilio.data.openai = passThrough({
    name: 'phone',
    from: twilio.data.from,
    greeting: twilio.data.greeting,
    why: twilio.data.why,
    format: { type: 'audio/pcmu', rate: 8000 },
    play: audio => twilio.send(JSON.stringify({ event: 'media', streamSid: twilio.data.stream, media: { payload: audio } })),
    started: session => {
      twilio.data.started = true
      const call = placed.get(twilio.data.token)
      if (call) call.session = session
    },
    refused: reason => refuse(twilio, reason),
    closed: () => twilio.close(),
  })
}

// A call on a line another client holds, like a Discord voice channel: it hands the engine the
// caller's audio and plays the voice's, both base64 PCM at 24 kHz, mono, and the engine holds the
// call as it does a phone call. The line ends when the call does, and a session refused or hung up
// on before it started never becomes a call.
export function take(from: Source, greeting: string, line: VoiceLine): Held {
  if (!KEY) throw new Error(`calls need OPENAI_API_KEY in ${join(STATE_DIR, '.env')}`)
  let up = false
  let gone = false
  const openai: WebSocket = passThrough({
    name: from,
    from,
    greeting,
    format: { type: 'audio/pcm', rate: 24000 },
    play: line.play,
    started: () => (up = true),
    refused: reason => {
      if (!gone) failed({ from, end: 'no-connect', reason })
      gone = true
      openai.close()
      line.end()
    },
    closed: line.end,
  })
  return {
    hear: audio => void (up && openai.send(JSON.stringify({ type: 'session.input_audio.append', audio }))),
    hangUp: () => {
      if (!up) {
        gone = true
        return openai.close()
      }
      if (openai.readyState === WebSocket.OPEN) openai.send(JSON.stringify({ type: 'session.close', event_id: `close-you-${from}` }))
    },
  }
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

function session(extra: object = {}, opening?: string) {
  return {
    model: 'gpt-live-1',
    instructions: `${VOICE_PROMPT}\n\nThe call started ${clock()}, the caller's local time.`,
    delegation: { type: 'client' },
    ...(opening && { input: [{ type: 'message', role: 'developer', content: [{ type: 'input_text', text: opening }] }] }),
    ...extra,
  }
}

async function start(request: Request) {
  if (!KEY) return new Response(`Set OPENAI_API_KEY in ${join(STATE_DIR, '.env')}`, { status: 503 })
  const { sdp, voice = VOICE, from: origin, about } = (await request.json()) as { sdp?: string; voice?: string; from?: string; about?: string }
  if (!sdp) return new Response('An SDP offer is required', { status: 400 })
  const from = origin === 'app' ? 'app' : 'web'
  const topic = topicOf(about)
  let response: Response
  try {
    response = await fetch(API, {
      method: 'POST',
      headers: { Authorization: `Bearer ${KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        session: session({
          ...(voice ? { audio: { output: { voice } } } : {}),
          client: { data_channel: { allowed_client_events: ['session.input_audio.mute', 'session.input_audio.unmute', 'session.close'] } },
        }, topic?.voice),
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
  follow(sideband(result.session.id), base(result.session.id, from, { voice, expires: expiry(result.session.expires_at) }), { about: topic })
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

async function showActivity(url: URL) {
  const after = url.searchParams.get('after')
  if (after) await activity.changes(Number(after), 25_000)
  return Response.json({ version: activity.version, call: live?.id ?? null, tasks: live ? [...live.call.activity(), ...elsewhere(live)] : [], asks: live ? cards(live) : [] })
}

// Everything else hex is working on, from the board: every thread and background session at work
// that the call isn't already following, so a call shows all of it and not only what it sent.
function elsewhere(call: Live): (Task & { line?: string })[] {
  const following = new Set(call.call.activity().flatMap(task => (task.state === 'running' && task.agent ? [task.agent] : [])))
  return board.tasks
    .filter(row => row.state === 'working' && row.app !== 'voice' && !following.has(row.thread))
    .map(row => ({ id: row.id, state: 'running', text: row.name, to: row.name, line: newest(row) }))
}

// The asks put on screen in this call, in order, each with its answer once it has one.
function cards(call: Live) {
  const marks = call.call.record().moments
  return marks
    .filter(mark => mark.kind === 'ask' && call.shown.has(mark.ask!))
    .map(mark => ({ at: mark.at, ask: call.shown.get(mark.ask!)!, answer: marks.findLast(answer => answer.kind === 'answered' && answer.ask === mark.ask)?.text }))
}

function topicOf(about?: string): Topic | undefined {
  if (about === 'asks') return walkTopic(yours.view.asks)
  const task = about ? board.get(about) : undefined
  return task && taskTopic(task)
}


async function showTasks(url: URL, tasks: Tasks) {
  const after = url.searchParams.get('after')
  if (after) await tasks.changes(Number(after), 25_000)
  return Response.json({ version: tasks.version, tasks: tasks.rows() })
}

// The Tasks button's counts: threads that need you and are working, and how many things are yours,
// as many as Tasks lists under Needs you: every ask, everything stuck, and every thread that needs
// you without an ask.
async function showSummary(url: URL, tasks: Tasks, asks: Asks) {
  const version = () => tasks.counts.version + asks.counts.version
  const after = Number(url.searchParams.get('after'))
  if (after === version()) await Promise.race([tasks.counts.changes(tasks.counts.version, 25_000), asks.counts.changes(asks.counts.version, 25_000)])
  const asked = new Set(asks.view.asks.map(ask => ask.task))
  const unasked = tasks.rows().filter(row => row.state === 'needs' && !asked.has(row.id)).length
  return Response.json({ version: version(), ...tasks.summary, yours: asks.view.asks.length + asks.view.stuck.length + unasked })
}

async function showAsks(url: URL, asks: Asks) {
  const after = url.searchParams.get('after')
  if (after) await asks.changes(Number(after), 25_000)
  return Response.json({ version: asks.version, ...asks.view })
}

// What the app's tap on an ask, a stuck item or a new result does. Each answers once the hub has it;
// the change itself comes back through the list.
async function askRoutes(request: Request, url: URL) {
  const asks = yours
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
  const tasks = board
  if (url.pathname === '/tasks' && request.method === 'GET') return showTasks(url, tasks)
  if (url.pathname === '/tasks/summary' && request.method === 'GET') return showSummary(url, tasks, yours)
  const [, id, talking] = url.pathname.match(/^\/tasks\/([^/]+)(\/talk)?$/) ?? []
  const task = id && tasks.get(decodeURIComponent(id))
  if (!task) return new Response('404', { status: 404 })
  if (talking && request.method === 'POST') return talkAbout(taskTopic(task))
  if (!talking && request.method === 'GET') return Response.json({ ...task, ...yours.of(task.id) })
}

// A live call's record is read from the call itself, so it has every word heard so far, and a
// request with after waits until the next word or change; an ended call's comes from disk.
async function showCall(id: string, url: URL) {
  const after = url.searchParams.get('after')
  if (after && live?.id === id) await live.changes.changes(Number(after), 25_000)
  if (live?.id === id) return Response.json({ ...whole(live), version: live.changes.version })
  const record = calls.get(id)
  return record ? Response.json(record) : new Response('404', { status: 404 })
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
  if (callId && !moments && request.method === 'GET') return showCall(callId, new URL(request.url))
  if (callId && !moments && request.method === 'DELETE') {
    if (live?.id === callId) return new Response('That call is still going', { status: 409 })
    return new Response(null, { status: calls.delete(callId) ? 204 : 404 })
  }
  if (pathname === '/phone' && request.method === 'POST')
    return dial().then(text => new Response(text), error => new Response(error.message, { status: 502 }))
}

// The call engine: it holds the voice page, the app's routes and the phone line on the voice port,
// for as long as hex's service runs, and hands what the caller asks to the voice session.
export function serve(voiceHub: Hub, state: string) {
  hub = voiceHub
  HEX_STATE = state
  board = new Tasks(state, dirname(state))
  board.listen(() => activity.changed())
  yours = new Asks(state)
  recover()
  resume()
  return Bun.serve<Phone>({
    port: PORT,
    hostname: '127.0.0.1',
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
}
