#!/usr/bin/env bun
import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { ListToolsRequestSchema, CallToolRequestSchema } from '@modelcontextprotocol/sdk/types.js'
import { connect, type Socket } from 'net'

const SOCKET = process.env.HEX_HUB
const THREAD = process.env.HEX_CHANNEL?.startsWith('plugin:buzz@') ? process.env.HEX_THREAD : undefined

const mcp = new Server(
  { name: 'buzz', version: '1.0.0' },
  {
    capabilities: { tools: {}, experimental: { 'claude/channel': {} } },
    instructions: [
      'The sender reads Buzz, not this session. Anything you want them to see must go through the reply tool — your transcript output never reaches their chat. Nobody watches this terminal either, so once your reply is sent, end the turn instead of summarizing it here.',
      '',
      'This session is one Buzz thread or direct message, the place for deeper work. Buzz renders Markdown, so answers can be longer and structured: headings, lists, and code blocks with a language. Its messages arrive as <channel source="buzz" chat_id="..." message_id="..." user="..." ts="...">, and everything you send with these tools lands back in that same thread. Buzz threads have no title, so if the tag has new_thread="true", name this thread for your own list and for handoffs: 1–2 words with rename_thread. If you were tagged into a thread that was already going, fetch_messages shows what came before. If the tag has attachment_count, the attachments attribute lists name/type/size — call download_attachment(message_id) to fetch them. If the tag has reply_to_message_id, the sender replied to that earlier message: reply_to_text is its text and reply_to_attachments lists its files (download_attachment with that id). edited="true" means the sender edited the message with that message_id and this is its new text. Use reply_to (set to a message_id) only when replying to an earlier message; the latest message doesn\'t need a quote-reply.',
      '',
      'reply accepts file paths (files: ["/abs/path.png"]) for attachments. Use react to add emoji reactions, and edit_message for interim progress updates. Edits don\'t trigger push notifications — when a long task completes, send a new reply so the user\'s device pings.',
      '',
      'new_thread opens another thread with its own fresh session and hands it your prompt. Use it for work the user will want to follow or talk to on its own. handoff moves this whole conversation to another app, such as telegram, when the user asks: you stop here and continue there with your memory.',
      '',
      "fetch_messages pulls real Buzz history, from this thread by default. The tag's channel attribute names the channel this thread is in: fetch_messages(channel) reads that channel's top-level messages, a message with a thread shows its reply count, and fetch_messages(thread: that message's id) reads the thread. When the user refers to earlier work or talk in the channel, read it rather than saying you can't see it. search_messages finds older messages by their words.",
    ].join('\n'),
  },
)

mcp.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: 'reply',
      description: 'Reply in this Buzz thread, or post in another one by name. Optionally pass reply_to (message_id) for threading, and files (absolute paths) to attach images or other files.',
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
            description: 'Absolute file paths to attach: images, MP4 video, PDFs or other files, but not audio. Max 100MB each.',
          },
        },
        required: ['text'],
      },
    },
    {
      name: 'react',
      description: 'Add an emoji reaction to a Buzz message.',
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
      description: 'Fetch recent messages from this thread, or from a channel or another thread. Returns oldest-first with message IDs. In a channel, a message that has a thread shows its reply count and last reply; pass its id as thread to read the thread.',
      inputSchema: {
        type: 'object',
        properties: {
          channel: { type: 'string', description: 'Channel to read instead of this thread, by name ("open-source") or id.' },
          thread: { type: 'string', description: 'Thread to read instead of this thread: the id of the message it hangs off, or its name.' },
          before: { type: 'string', description: 'Message ID: only messages older than it. Pass the oldest ID you have to page back.' },
          limit: { type: 'number', description: 'Max messages (default 20, max 100).' },
        },
      },
    },
    {
      name: 'search_messages',
      description: 'Search the Buzz channels you are in for messages containing words, best matches first. Each row names its channel, and the thread a reply belongs to, for fetch_messages.',
      inputSchema: {
        type: 'object',
        properties: {
          query: { type: 'string' },
          channel: { type: 'string', description: 'Only search this channel, by name or id.' },
          limit: { type: 'number', description: 'Max messages (default 20, max 100).' },
        },
        required: ['query'],
      },
    },
    {
      name: 'list_channels',
      description: 'List the Buzz channels you are in, with their IDs. Direct messages are marked.',
      inputSchema: { type: 'object', properties: {} },
    },
    {
      name: 'rename_thread',
      description: 'Name this thread: 1–2 words, like a chat name ("Desk anchors", "Hub tests"). Buzz shows no thread titles, so the name is for your thread list and handoffs.',
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
      description: 'Close a thread whose work is done and stop its session once it is idle. Defaults to this thread. Tagging the bot in it again starts a fresh session.',
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
          title: { type: 'string', description: 'Thread name: 1–2 words, like a chat name ("OpenAI frontier", "Desk anchors"). It is the thread\'s first message in Buzz.' },
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
          to: { type: 'string', enum: ['telegram', 'discord'] },
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
  if (!THREAD) return Promise.reject(new Error('this session is not bound to a Buzz thread (HEX_THREAD is unset)'))
  if (!hub) return Promise.reject(new Error('the Buzz hub is not running'))
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
        }).catch(err => process.stderr.write(`buzz channel: failed to deliver inbound to Claude: ${err}\n`))
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
    for (const waiter of pending.values()) waiter.reject(new Error('the Buzz hub disconnected'))
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
