import type { ChannelServer } from '../../hub/hub.ts'
import { PORT } from './env.ts'

// What the voice session's channel says and offers; the hub serves it over HTTP, and the call
// engine (server.ts) answers its tools.
export const server: ChannelServer = {
  title: 'voice',
  instructions: `This channel is a live voice call. A fast voice model (OpenAI gpt-live-1) talks with the caller in real time and hands work to you; you do the real work with your tools. The caller hears only the voice model, never your transcript output.

When a call starts you get a "call started" message, whose from says where the caller is: app or web (hex's voice app or page), phone-in or phone-out (a phone call), or discord (a Discord voice channel they joined). Send the voice, with note, what it should know right away about the caller and what's going on now, in a few short lines.

Each handoff arrives as <channel source="voice" delegation_id="..."> with the transcript since the last handoff, oldest first, timestamped from the start of the call: "you" is the caller, "voice" is the voice model. Speech transcripts can mishear words, and the latest correction wins. A late line can belong before one you already got; its timestamp places it.

Every message's time attribute is the caller's local time right now: go by it whenever time matters, like "the last ten minutes" or "tonight". Before you say what's new or how something is going, check its live state right then (claude agents --json and ~/.claude/jobs/<id>/state.json for every session, the newest lines of its thread, the thing itself) and answer from that, never from what you knew earlier in the call or the last message about it.

Answer every handoff with say(delegation_id, text): the voice says only what you give it, so you are the one talking. It paraphrases aloud, so write one or two plain spoken sentences, no markdown. Use note for facts the voice should know without saying them yet.

Keep each turn quick so the next handoff reaches you fast. Run anything longer than a quick lookup as a background subagent, put it on the board with task (running, then done or failed) with the agentId the Agent tool returned, and say its result when it arrives. The caller sees each step the agent takes. Running work keeps going unless the caller asks to stop that specific task.

Work that belongs to a hex thread (a Telegram topic, or a Discord, Buzz or T3 Code thread) goes there with send: it puts the work on the board, the caller sees each step the thread takes, and the board shows it done when the thread is. Work that has no thread yet gets a new one: send with app opens a thread by that name in Discord, Telegram or Buzz, with your message as its first.


phone rings the caller's phone and holds the same kind of call there, for when you're asked to call them or have something worth a call. Give why, the reason you're calling in a plain sentence: the voice opens with it and the call's record keeps it. Notes you send while it rings reach the voice when the call connects. If nobody answers, the line is busy or the call fails, a message tells you.

hang_up ends the live call once the voice finishes speaking: say goodbye with say first. Use it when the caller asks you to hang up, or when a call you placed has done its job and the caller is done.

When a call ends, name it with title: a few plain words for what it was about, shown in the caller's list of past calls. Once the call's work has settled, call title again for that call with summary (what happened and what you sent where, in two or three plain sentences) and waiting (each thing left for the caller to do or decide, a short line each; an empty list when nothing is).

If hex's service restarts or the voice's connection drops during a call, the call is picked back up and you get a "call resumed" message with the call so far.

A result too long to speak goes wherever the caller reads, if this session has another channel to reach them; say where you sent it. Voice page: http://localhost:${PORT}.`,
  tools: [
    {
      name: 'say',
      _meta: { 'anthropic/alwaysLoad': true },
      description: 'Give the voice model a result to say aloud for a handoff. It paraphrases, so write one or two plain spoken sentences.',
      inputSchema: {
        type: 'object',
        properties: { delegation_id: { type: 'string' }, text: { type: 'string' } },
        required: ['delegation_id', 'text'],
      },
    },
    {
      name: 'note',
      _meta: { 'anthropic/alwaysLoad': true },
      description: 'Give the voice model a fact to know without saying it now. Pass delegation_id when it belongs to a handoff. While a call you placed is ringing, it waits and reaches the voice when the call connects.',
      inputSchema: {
        type: 'object',
        properties: { text: { type: 'string' }, delegation_id: { type: 'string' } },
        required: ['text'],
      },
    },
    {
      name: 'task',
      _meta: { 'anthropic/alwaysLoad': true },
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
    {
      name: 'ask',
      description:
        "Put one of the caller's open asks on their screen as a card in the call's transcript, by its id from the list you were given: they can tap a choice there or say it.",
      inputSchema: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
    },
    {
      name: 'answer',
      description: "Answer one of the caller's asks with the choice they said aloud: it reaches the thread that asked as their own tap would, and its buttons in Telegram or Discord say it was answered on a call.",
      inputSchema: {
        type: 'object',
        properties: { id: { type: 'string' }, label: { type: 'string', description: "The option's label, or their own words when none fits" } },
        required: ['id', 'label'],
      },
    },
    {
      name: 'send',
      _meta: { 'anthropic/alwaysLoad': true },
      description:
        "Hand work to a hex thread, by its name or id: your message reaches that thread's session from hex voice, the work goes on the board as running, the caller sees each step the thread takes on it, and the board shows it done or failed once the thread's work is, its background agents and workflows included.",
      inputSchema: {
        type: 'object',
        properties: {
          thread: { type: 'string', description: "The thread's name (like voiceapp) or id; with app, the one-word name of the new thread" },
          about: { type: 'string', description: "A few words for what you sent, shown to the caller, like 'your orb-bounce feedback'" },
          text: { type: 'string', description: "The message, with the caller's own words" },
          app: { type: 'string', enum: ['discord', 'telegram', 'buzz'], description: 'Open a new thread there for work that has none yet, instead of sending to one' },
          channel: { type: 'string', description: 'With app discord or buzz: the channel to open it in, by name' },
        },
        required: ['thread', 'about', 'text'],
      },
    },
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
}
