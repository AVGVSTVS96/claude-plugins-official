#!/usr/bin/env bun
import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js'
import { createHmac } from 'crypto'
import { readFileSync } from 'fs'
import { connect } from 'net'
import { homedir } from 'os'
import { join } from 'path'
import { Call, transcript, type Speaker, type Task } from './call.ts'
import { CallLog, ending, type CallRecord, type Ending, type Source } from './calls.ts'
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
const HUB = process.env.HEX_HUB
const THREAD = process.env.HEX_CHANNEL?.startsWith('plugin:voice@') ? process.env.HEX_THREAD : undefined
const calls = new CallLog(join(STATE_DIR, 'calls'))

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
  socket: WebSocket
  call: Call
  record: Omit<CallRecord, 'turns' | 'tasks'>
  pending: Map<string, Pending>
  rings: Ring[]
  speak?: (audio: string) => void
}
type Dial = { greeting: string; from: Source }
type Phone = Dial & { openai?: WebSocket; stream?: string; started?: true }

let live: Live | undefined
let ended: string | undefined
let hub: ReturnType<typeof connect> | undefined
let seq = 0
const dials = new Map<string, Dial>()

const mcp = new Server(
  { name: 'voice', version: '0.1.0' },
  {
    capabilities: { tools: {}, experimental: { 'claude/channel': {} } },
    instructions: `This channel is a live voice call. A fast voice model (OpenAI gpt-live-1) talks with the caller in real time and hands work to you; you do the real work with your tools. The caller hears only the voice model, never your transcript output.

When a call starts you get a "call started" message: send the voice, with note, what it should know right away about the caller and what's going on now, in a few short lines.

Each handoff arrives as <channel source="voice" delegation_id="..."> with the transcript since the last handoff, oldest first, timestamped from the start of the call: "you" is the caller, "voice" is the voice model. Speech transcripts can mishear words, and the latest correction wins. A late line can belong before one you already got; its timestamp places it.

Answer every handoff with say(delegation_id, text): the voice says only what you give it, so you are the one talking. It paraphrases aloud, so write one or two plain spoken sentences, no markdown. Use note for facts the voice should know without saying them yet.

Keep each turn quick so the next handoff reaches you fast. Run anything longer than a quick lookup as a background subagent, put it on the board with task (running, then done or failed), and say its result when it arrives. Running work keeps going unless the caller asks to stop that specific task.

phone rings the caller's phone and holds the same kind of call there, for when you're asked to call them.

When a call ends, name it with title: a few plain words for what it was about, shown in the caller's list of past calls.

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
      description: 'Give the voice model a fact to know without saying it now. Pass delegation_id when it belongs to a handoff.',
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
        },
        required: ['id', 'state', 'text'],
      },
    },
    {
      name: 'title',
      description: "Name a call in the caller's list of past calls: a few plain words for what it was about.",
      inputSchema: {
        type: 'object',
        properties: { call: { type: 'string', description: 'The call id from the call ended message' }, title: { type: 'string' } },
        required: ['call', 'title'],
      },
    },
    {
      name: 'phone',
      description: "Ring a phone and hold the call there: the caller's own number unless to is given (E.164, like +14155550123).",
      inputSchema: { type: 'object', properties: { to: { type: 'string' } } },
    },
  ],
}))

mcp.setRequestHandler(CallToolRequestSchema, async request => {
  const args = (request.params.arguments ?? {}) as Record<string, string>
  try {
    if (request.params.name === 'phone') return done(await dial(args.to))
    if (request.params.name === 'title') return done(name(args.call, args.title))
    if (request.params.name === 'task') return done(await task(args.id, args.state as Task['state'], args.text, args.call))
    if (!live) throw new Error('no call is live')
    switch (request.params.name) {
      case 'say':
        await send(live, 'session.commentary.append', args.text, args.delegation_id)
        return done('said')
      case 'note':
        await send(live, 'session.thinking.append', args.text, args.delegation_id)
        return done('noted')
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
  const event_id = `${type.split('.')[1]}_${++seq}`
  call.socket.send(JSON.stringify({ type, event_id, delegation_id: delegation ?? null, content }))
  return new Promise<void>((resolve, reject) => call.pending.set(event_id, { resolve, reject }))
}

function save(call: Live) {
  calls.save({ ...call.record, ...call.call.record() })
}

async function task(id: string, state: Task['state'], text: string, call = live?.id ?? ended) {
  if (!call) throw new Error('no call yet')
  if (live?.id === call) {
    live.call.track({ id, state, text }, Date.now() - Date.parse(live.record.started))
    save(live)
    await send(live, 'session.thinking.append', live.call.board())
    return 'board updated'
  }
  const record = past(call)
  calls.save({ ...record, tasks: [...record.tasks, { id, state, text, at: Date.now() - Date.parse(record.started) }] })
  return 'that call has ended, so only its record changed'
}

function name(call: string, title: string) {
  if (live?.id === call) {
    live.record.title = title
    save(live)
  } else calls.save({ ...past(call), title })
  return 'named'
}

function past(id: string) {
  const record = calls.get(id)
  if (!record) throw new Error(`no call ${id}`)
  return record
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
  hex: 'the voice service ended it',
  dropped: 'the connection dropped',
  expired: 'it reached the time limit',
  'no-connect': 'it never connected',
  'no-answer': 'nobody answered',
  busy: 'the line was busy',
}

function finish(call: Live, reason: string, by?: string) {
  if (live !== call) return
  live = undefined
  ended = call.id
  const end = ending(reason, by)
  for (const pending of call.pending.values()) pending.reject(new Error(`the call ended (${reason})`))
  for (const pending of call.rings) ring(call, pending)
  const rest = call.call.handOff()
  call.record = { ...call.record, ended: new Date().toISOString(), end, reason }
  save(call)
  deliver(
    [`The call ended: ${ENDINGS[end]} (${reason}). Name it with title.`, ...(rest.length ? ['Last words:', transcript(rest)] : [])].join('\n'),
    { call: call.id, ended: end, reason },
  )
  hub?.write(JSON.stringify({ type: 'renew', thread: THREAD }) + '\n')
  call.socket.close()
}

function follow(id: string, socket: WebSocket, from: Source, voice?: string, speak?: Live['speak']) {
  if (live) finish(live, 'replaced by a new call')
  const record = { id, started: new Date().toISOString(), from, voice, claude: process.env.CLAUDE_CODE_SESSION_ID }
  const call: Live = { id, socket, call: new Call(), record, pending: new Map(), rings: [], speak }
  live = call
  save(call)
  deliver('A call started. Send the voice what it should know right away, with note.', { call: id, started: 'true' })
  socket.onmessage = ({ data }) => {
    const event = JSON.parse(String(data))
    switch (event.type) {
      case 'session.input_transcript.delta':
        return hear(call, 'you', event)
      case 'session.output_transcript.delta':
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
        const id = event.client_event_id ?? event.error?.event_id
        const failed = call.pending.get(id)
        call.pending.delete(id)
        if (failed) return failed.reject(new Error(event.error?.message ?? JSON.stringify(event)))
        return process.stderr.write(`voice: ${JSON.stringify(event)}\n`)
      }
      case 'session.output_audio.delta':
        return call.speak?.(event.delta)
      case 'session.closed':
        return finish(call, event.reason ?? 'closed', event.client_event_id)
    }
  }
  socket.onclose = () => finish(call, 'connection closed')
}

function attach(id: string, from: Source, voice?: string) {
  follow(id, new WebSocket(`${API}/${id}/attach`, { headers: { Authorization: `Bearer ${KEY}` } } as any), from, voice)
}

function session(extra: object = {}) {
  return {
    model: 'gpt-live-1',
    instructions: VOICE_PROMPT,
    delegation: { type: 'client' },
    ...extra,
  }
}

async function dial(to = CALLER_NUMBER) {
  if (!KEY || !TWILIO_SID || !TWILIO_TOKEN || !TWILIO_NUMBER || !PUBLIC_HOST)
    throw new Error(`phone calls need TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, TWILIO_NUMBER and VOICE_PUBLIC_URL in ${join(STATE_DIR, '.env')}`)
  if (!to) throw new Error('no number to call: pass to, or set CALLER_NUMBER')
  const token = crypto.randomUUID()
  dials.set(token, { greeting: 'You placed this phone call. Greet them briefly first, then listen.', from: 'phone-out' })
  const response = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${TWILIO_SID}/Calls.json`, {
    method: 'POST',
    headers: { Authorization: `Basic ${btoa(`${TWILIO_SID}:${TWILIO_TOKEN}`)}` },
    body: new URLSearchParams({
      To: to,
      From: TWILIO_NUMBER,
      Url: `https://${PUBLIC_HOST}/twilio/${token}/twiml`,
    }),
  })
  if (!response.ok) {
    dials.delete(token)
    throw new Error(`Twilio: ${await response.text()}`)
  }
  return `ringing ${to}`
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
    if (event.type === 'error' && !twilio.data.started) trace(`OpenAI refused the phone session: ${JSON.stringify(event.error)}`)
    if (event.type !== 'session.started') return
    twilio.data.started = true
    follow(event.session.id, openai, twilio.data.from, VOICE, audio => twilio.send(JSON.stringify({ event: 'media', streamSid: twilio.data.stream, media: { payload: audio } })))
    openai.send(JSON.stringify({ type: 'session.instructions.append', delegation_id: null, content: twilio.data.greeting }))
  })
  openai.addEventListener('close', ({ code, reason }) => {
    trace(`OpenAI closed the phone session (${code} ${reason})`)
    twilio.close()
  })
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

async function pickUp(request: Request) {
  const form = await request.formData()
  const params = [...form.keys()].sort().map(key => key + form.get(key)).join('')
  const signature = createHmac('sha1', TWILIO_TOKEN ?? '').update(`https://${PUBLIC_HOST}/twilio/incoming${params}`).digest('base64')
  if (!TWILIO_TOKEN || request.headers.get('x-twilio-signature') !== signature || form.get('From') !== CALLER_NUMBER) return twiml('<Reject />')
  const token = crypto.randomUUID()
  dials.set(token, { greeting: 'They called you. Answer briefly, then listen.', from: 'phone-in' })
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

async function start(request: Request) {
  if (!KEY) return new Response(`Set OPENAI_API_KEY in ${join(STATE_DIR, '.env')}`, { status: 503 })
  const { sdp, voice = VOICE, from } = (await request.json()) as { sdp?: string; voice?: string; from?: string }
  if (!sdp) return new Response('An SDP offer is required', { status: 400 })
  const response = await fetch(API, {
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
  if (!response.ok) return new Response(await response.text(), { status: response.status })
  const result = (await response.json()) as { session: { id: string } }
  attach(result.session.id, from === 'app' ? 'app' : 'web', voice)
  return Response.json(result, { status: 201 })
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
}

await mcp.connect(new StdioServerTransport())
process.stdin.on('end', () => process.exit(0))
process.stdin.on('close', () => process.exit(0))

async function listCalls(url: URL) {
  const after = url.searchParams.get('after')
  if (after) await calls.changes(Number(after), 25_000)
  return Response.json({ version: calls.version, live: live?.id, calls: calls.list() })
}

Bun.serve<Phone>({
  port: PORT,
  idleTimeout: 40,
  hostname: '127.0.0.1',
  fetch(request, server) {
    const { pathname } = new URL(request.url)
    if (pathname === '/twilio/incoming' && request.method === 'POST') return pickUp(request)
    const [, token, twimlPath] = pathname.match(/^\/twilio\/([\w-]+)(\/twiml)?$/) ?? []
    const dialed = dials.get(token)
    if (token) trace(`Twilio ${request.method} ${twimlPath ? 'TwiML' : 'stream'}, ${dialed ? 'known' : 'unknown'} token`)
    if (dialed && twimlPath) return stream(token)
    if (dialed && dials.delete(token)) return server.upgrade(request, { data: { ...dialed } }) ? undefined : new Response('upgrade failed', { status: 400 })
    if (pathname === '/') return new Response(page, { headers: { 'content-type': 'text/html; charset=utf-8' } })
    if (pathname === '/session' && request.method === 'POST') return start(request)
    if (pathname === '/session' && request.method === 'DELETE') {
      live?.socket.send(JSON.stringify({ type: 'session.close', event_id: 'close-you-app' }))
      return new Response(null, { status: 204 })
    }
    if (pathname === '/calls' && request.method === 'GET') return listCalls(new URL(request.url))
    const [, callId] = pathname.match(/^\/calls\/([\w-]+)$/) ?? []
    if (callId && request.method === 'GET') {
      const record = calls.get(callId)
      return record ? Response.json(record) : new Response('404', { status: 404 })
    }
    if (callId && request.method === 'DELETE') {
      if (live?.id === callId) return new Response('That call is still going', { status: 409 })
      return new Response(null, { status: calls.delete(callId) ? 204 : 404 })
    }
    if (pathname === '/phone' && request.method === 'POST')
      return dial().then(text => new Response(text), error => new Response(error.message, { status: 502 }))
    return new Response('404', { status: 404 })
  },
  websocket: {
    open: answer,
    message: hearPhone,
    close: hangUp,
  },
})
