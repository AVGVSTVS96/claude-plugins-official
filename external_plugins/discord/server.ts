#!/usr/bin/env bun
import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { ListToolsRequestSchema, CallToolRequestSchema } from '@modelcontextprotocol/sdk/types.js'
import { connect, type Socket } from 'net'

const SOCKET = process.env.HEX_HUB
const THREAD = process.env.HEX_CHANNEL?.startsWith('plugin:discord@') ? process.env.HEX_THREAD : undefined

const mcp = new Server(
  { name: 'discord', version: '1.0.0' },
  {
    capabilities: { tools: {}, experimental: { 'claude/channel': {} } },
    instructions: [
      'The sender reads Discord, not this session. Anything you want them to see must go through the reply tool — your transcript output never reaches their chat. Nobody watches this terminal either, so once your reply is sent, end the turn instead of summarizing it here.',
      '',
      'This session is one Discord thread, the place for deeper work. Discord renders Markdown, so answers can be longer and structured: headings, lists, and code blocks with a language. Its messages arrive as <channel source="discord" chat_id="..." message_id="..." user="..." ts="...">, and everything you send with these tools lands back in that same thread. If the tag has new_thread="true", this thread was just opened from that message and named after its first words: give it a fitting 1–2 word name with rename_thread first. If the tag has attachment_count, the attachments attribute lists name/type/size — call download_attachment(message_id) to fetch them. Use reply_to (set to a message_id) only when replying to an earlier message; the latest message doesn\'t need a quote-reply.',
      '',
      'reply accepts file paths (files: ["/abs/path.png"]) for attachments. Use react to add emoji reactions, and edit_message for interim progress updates. Edits don\'t trigger push notifications — when a long task completes, send a new reply so the user\'s device pings.',
      '',
      'new_thread opens another thread with its own fresh session and hands it your prompt. Use it for work the user will want to follow or talk to on its own. handoff moves this whole conversation to another app, such as telegram, when the user asks: you stop here and continue there with your memory.',
      '',
      "fetch_messages pulls real Discord history, from this thread by default. The tag's channel attribute names the channel this thread is in: fetch_messages(channel) reads that channel's top-level messages, a message with a thread shows its reply count, and fetch_messages(thread: that message's id) reads the thread. When the user refers to earlier work or talk in the channel, read it rather than saying you can't see it. Discord's search API isn't available to bots — if the user asks you to find an old message, page back with before or ask them roughly when it was.",
    ].join('\n'),
  },
)

mcp.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: 'reply',
      description: 'Reply in this Discord thread, or post in another one by name. Optionally pass reply_to (message_id) for threading, and files (absolute paths) to attach images or other files.',
      inputSchema: {
        type: 'object',
        properties: {
          text: { type: 'string' },
          thread: { type: 'string', description: 'Thread name to post in instead of this thread.' },
          reply_to: {
            type: 'string',
            description: 'Message ID to thread under. Use message_id from the inbound <channel> block, or an id from fetch_messages.',
          },
          files: {
            type: 'array',
            items: { type: 'string' },
            description: 'Absolute file paths to attach (images, logs, etc). Max 10 files, 25MB each.',
          },
        },
        required: ['text'],
      },
    },
    {
      name: 'react',
      description: 'Add an emoji reaction to a Discord message. Unicode emoji work directly; custom emoji need the <:name:id> form.',
      inputSchema: {
        type: 'object',
        properties: {
          message_id: { type: 'string' },
          emoji: { type: 'string' },
        },
        required: ['message_id', 'emoji'],
      },
    },
    {
      name: 'edit_message',
      description: 'Edit a message the bot previously sent. Useful for interim progress updates. Edits don\'t trigger push notifications — send a new reply when a long task completes so the user\'s device pings.',
      inputSchema: {
        type: 'object',
        properties: {
          message_id: { type: 'string' },
          text: { type: 'string' },
        },
        required: ['message_id', 'text'],
      },
    },
    {
      name: 'download_attachment',
      description: 'Download attachments from a message in this thread to the local inbox. Use after the inbound meta or fetch_messages shows a message has attachments. Returns file paths ready to Read.',
      inputSchema: {
        type: 'object',
        properties: {
          message_id: { type: 'string' },
        },
        required: ['message_id'],
      },
    },
    {
      name: 'fetch_messages',
      description: "Fetch recent messages from this thread, or from a channel or another thread. Returns oldest-first with message IDs. In a channel, a message that has a thread shows its reply count and last reply; pass its id as thread to read the thread. Discord's search API isn't exposed to bots, so this is the only way to look back.",
      inputSchema: {
        type: 'object',
        properties: {
          channel: { type: 'string', description: 'Channel to read instead of this thread, by name ("open-source") or id.' },
          thread: { type: 'string', description: 'Thread to read instead of this thread: the id of the message it hangs off, or its name.' },
          before: { type: 'string', description: 'Message ID: only messages older than it. Pass the oldest ID you have to page back.' },
          limit: { type: 'number', description: 'Max messages (default 20, Discord caps at 100).' },
        },
      },
    },
    {
      name: 'list_channels',
      description: 'List the Discord channels you can read, with their IDs.',
      inputSchema: { type: 'object', properties: {} },
    },
    {
      name: 'rename_thread',
      description: 'Rename this thread: 1–2 words, like a chat name ("Desk anchors", "Hub tests").',
      inputSchema: {
        type: 'object',
        properties: {
          title: { type: 'string' },
        },
        required: ['title'],
      },
    },
    {
      name: 'close_thread',
      description: 'Archive a thread whose work is done and stop its session once it is idle. Defaults to this thread. A new message in it unarchives it and resumes the session.',
      inputSchema: {
        type: 'object',
        properties: {
          thread: { type: 'string', description: 'Thread name to close instead of this thread.' },
        },
      },
    },
    {
      name: 'new_thread',
      description: 'Open a new thread, start a fresh session for it, and give that session the prompt as its first message.',
      inputSchema: {
        type: 'object',
        properties: {
          title: { type: 'string', description: 'Thread name the user sees in Discord: 1–2 words, like a chat name ("OpenAI frontier", "Desk anchors").' },
          prompt: { type: 'string', description: 'Everything the new session needs to start the work: it shares none of your context.' },
          channel: { type: 'string', description: 'Channel to open it in, by name. Defaults to this thread\'s channel.' },
        },
        required: ['title', 'prompt'],
      },
    },
    {
      name: 'handoff',
      description: 'Move this conversation to another app when the user asks. It opens a thread there, and this session stops here once the turn ends and resumes there with its full memory.',
      inputSchema: {
        type: 'object',
        properties: {
          to: { type: 'string', enum: ['telegram', 'buzz'] },
          title: { type: 'string', description: 'Name there, 1–2 words. Defaults to this thread\'s name.' },
        },
        required: ['to'],
      },
    },
  ],
}))

let hub: Socket | undefined
let nextId = 0
const pending = new Map<number, { resolve: (text: string) => void; reject: (error: Error) => void }>()

function request(tool: string, args: Record<string, unknown>): Promise<string> {
  if (!THREAD) return Promise.reject(new Error('this session is not bound to a Discord thread (HEX_THREAD is unset)'))
  if (!hub) return Promise.reject(new Error('the Discord hub is not running'))
  const id = ++nextId
  const socket = hub
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject })
    socket.write(JSON.stringify({ type: 'call', id, tool, args }) + '\n')
  })
}

mcp.setRequestHandler(CallToolRequestSchema, async req => {
  try {
    const text = await request(req.params.name, req.params.arguments ?? {})
    return { content: [{ type: 'text', text }] }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    return { content: [{ type: 'text', text: `${req.params.name} failed: ${msg}` }], isError: true }
  }
})

function connectHub(): void {
  const socket = connect(SOCKET!)
  let buffer = ''
  socket.setEncoding('utf8')
  socket.on('connect', () => {
    hub = socket
    // Claude Code starts listening for channel notifications ~30ms after its last
    // request to this server (tools/list) and never signals it; notifications
    // before that are dropped. Saying hello flushes queued messages, so wait.
    setTimeout(() => socket.write(JSON.stringify({ type: 'hello', thread: THREAD, session: process.env.CLAUDE_CODE_SESSION_ID }) + '\n'), 1000)
  })
  socket.on('data', (chunk: string) => {
    buffer += chunk
    for (let end = buffer.indexOf('\n'); end >= 0; end = buffer.indexOf('\n')) {
      const event = JSON.parse(buffer.slice(0, end))
      buffer = buffer.slice(end + 1)
      if (event.type === 'inbound') {
        mcp.notification({
          method: 'notifications/claude/channel',
          params: { content: event.content, meta: event.meta },
        }).catch(err => process.stderr.write(`discord channel: failed to deliver inbound to Claude: ${err}\n`))
      }
      if (event.type === 'result') {
        const waiter = pending.get(event.id)
        pending.delete(event.id)
        if (event.error) waiter?.reject(new Error(event.error))
        else waiter?.resolve(event.text)
      }
    }
  })
  socket.on('close', () => {
    if (hub === socket) hub = undefined
    for (const waiter of pending.values()) waiter.reject(new Error('the Discord hub disconnected'))
    pending.clear()
    setTimeout(connectHub, 2000)
  })
  socket.on('error', () => {})
}

mcp.oninitialized = () => {
  if (THREAD && SOCKET) connectHub()
}

await mcp.connect(new StdioServerTransport())

process.stdin.on('end', () => process.exit(0))
process.stdin.on('close', () => process.exit(0))
