#!/usr/bin/env bun
import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js'
import { readFileSync } from 'fs'
import { homedir } from 'os'
import { join } from 'path'
import { Call, transcript, type Speaker, type Task } from './call.ts'
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

const VOICE_PROMPT = `You are the voice of a personal assistant, talking with the person it works for. Speak warmly and naturally, like a sharp friend: plain words, short answers.

Backchannel policy: Use light backchannels. Acknowledge naturally without competing with the main response.

Interruption policy: Stop speaking when the user interrupts. Listen to what they say.

Delegation policy:
Backend tools:
- Assistant: an agent with the user's files, machines, projects, memory, messages, email, calendar and the web. It can look things up, take actions and run long tasks in the background.

Delegate to the backend when:
- The request needs anything from the user's world or the web: their files, projects, messages, accounts, schedule, or current facts.
- The user asks you to do, check, build, send, change or remember something.
- A correction or addition changes work already requested.

Do not delegate to the backend when:
- You can answer from the conversation or a result the backend already gave you.
- The user asks how a task is going: answer from the task board.
- You need a brief clarification to understand the request.

Delegate before giving an answer that depends on backend work. While it works, say briefly that you're on it and keep talking with the user; do not guess the result.
Backend work keeps running while you talk, and several tasks can run at once. A task board arrives as quiet context whenever a task starts or finishes.`

type Pending = { resolve: () => void; reject: (error: Error) => void }
type Ring = { delegation: string; offset: number }
type Live = { id: string; socket: WebSocket; call: Call; pending: Map<string, Pending>; rings: Ring[] }

let live: Live | undefined
let seq = 0

const mcp = new Server(
  { name: 'voice', version: '0.1.0' },
  {
    capabilities: { tools: {}, experimental: { 'claude/channel': {} } },
    instructions: `This channel is a live voice call. A fast voice model (OpenAI gpt-live-1) talks with the caller in real time and hands work to you; you do the real work with your tools. The caller hears only the voice model, never your transcript output.

Each handoff arrives as <channel source="voice" delegation_id="..."> with the transcript since the last handoff, oldest first, timestamped from the start of the call: "you" is the caller, "voice" is the voice model. Speech transcripts can mishear words, and the latest correction wins. A late line can belong before one you already got; its timestamp places it.

Answer a handoff with say(delegation_id, text). The voice model paraphrases it aloud, so write one or two plain spoken sentences, no markdown. Use note for facts the voice should know without saying them yet.

Keep each turn quick so the next handoff reaches you fast. Run anything longer than a quick lookup as a background subagent, put it on the board with task (running, then done or failed), and say its result when it arrives. The voice answers "how's it going?" from the board. Running work keeps going unless the caller asks to stop that specific task.

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
      description: 'Put a task on the board the voice model reads to answer status questions: running when it starts, then done or failed.',
      inputSchema: {
        type: 'object',
        properties: {
          id: { type: 'string', description: 'A short name that stays the same across updates' },
          state: { type: 'string', enum: ['running', 'done', 'failed'] },
          text: { type: 'string', description: 'What it is, and the result once it has one' },
        },
        required: ['id', 'state', 'text'],
      },
    },
  ],
}))

mcp.setRequestHandler(CallToolRequestSchema, async request => {
  const args = (request.params.arguments ?? {}) as Record<string, string>
  try {
    if (!live) throw new Error('no call is live')
    switch (request.params.name) {
      case 'say':
        await send(live, 'session.commentary.append', args.text, args.delegation_id)
        return done('said')
      case 'note':
        await send(live, 'session.thinking.append', args.text, args.delegation_id)
        return done('noted')
      case 'task':
        live.call.track({ id: args.id, state: args.state as Task['state'], text: args.text })
        await send(live, 'session.thinking.append', live.call.board())
        return done('board updated')
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
}

function hear(call: Live, who: Speaker, event: { delta: string; start_ms: number; end_ms: number }) {
  call.call.hear({ who, text: event.delta, start: event.start_ms, end: event.end_ms })
  while (call.rings[0] && call.rings[0].offset <= event.start_ms) ring(call, call.rings.shift()!)
}

function finish(call: Live, reason: string) {
  if (live !== call) return
  live = undefined
  for (const pending of call.pending.values()) pending.reject(new Error(`the call ended (${reason})`))
  for (const pending of call.rings) ring(call, pending)
  const rest = call.call.handOff()
  deliver(['The call ended.', ...(rest.length ? ['Last words:', transcript(rest)] : [])].join('\n'), { call: call.id, ended: reason })
  call.socket.close()
}

function attach(id: string) {
  if (live) finish(live, 'replaced by a new call')
  const socket = new WebSocket(`${API}/${id}/attach`, { headers: { Authorization: `Bearer ${KEY}` } } as any)
  const call: Live = { id, socket, call: new Call(), pending: new Map(), rings: [] }
  live = call
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
      case 'session.closed':
        return finish(call, event.reason ?? 'closed')
    }
  }
  socket.onclose = () => finish(call, 'connection closed')
}

async function start(request: Request) {
  if (!KEY) return new Response(`Set OPENAI_API_KEY in ${join(STATE_DIR, '.env')}`, { status: 503 })
  const { sdp } = (await request.json()) as { sdp?: string }
  if (!sdp) return new Response('An SDP offer is required', { status: 400 })
  const response = await fetch(API, {
    method: 'POST',
    headers: { Authorization: `Bearer ${KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      session: {
        model: 'gpt-live-1',
        instructions: VOICE_PROMPT,
        delegation: { type: 'client' },
        ...(VOICE ? { audio: { output: { voice: VOICE } } } : {}),
      },
      transport: { type: 'webrtc', sdp },
    }),
  })
  if (!response.ok) return new Response(await response.text(), { status: response.status })
  const result = (await response.json()) as { session: { id: string } }
  attach(result.session.id)
  return Response.json(result, { status: 201 })
}

await mcp.connect(new StdioServerTransport())

Bun.serve({
  port: PORT,
  hostname: '127.0.0.1',
  fetch(request) {
    const { pathname } = new URL(request.url)
    if (pathname === '/') return new Response(page, { headers: { 'content-type': 'text/html; charset=utf-8' } })
    if (pathname === '/session' && request.method === 'POST') return start(request)
    return new Response('404', { status: 404 })
  },
})
