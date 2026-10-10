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
      'This session is one Discord thread, the place for deeper work. Discord renders Markdown, so answers can be longer and structured: headings, lists, and code blocks with a language. Its messages arrive as <channel source="discord" chat_id="..." message_id="..." user="..." ts="...">, and everything you send with these tools lands back in that same thread. If the tag has new_thread="true", this thread was just opened from that message and named after its first words: give it a fitting 1–2 word name with rename_thread first. If the tag has attachment_count, the attachments attribute lists name/type/size — call download_attachment(message_id) to fetch them. If the tag has reply_to_message_id, the sender replied to that earlier message: reply_to_text is its text and reply_to_attachments lists its files (download_attachment with that id). edited="true" means the sender edited the message with that message_id and this is its new text; forwarded="true" means it is a message they forwarded. stickers lists sent stickers with their image URLs; poll is a poll question, with poll_options and poll_multiple when several answers are allowed. post_title is the title of a new forum post. A reaction arrives as "(reaction: 👍)" with reaction, reaction_to_message_id, reaction_to_user and reaction_to_text, plus reaction_removed="true" when taken off. deleted="true" means the message with that message_id was deleted, with deleted_text when known. button="true" means the sender tapped the button with this label on button_message_id. A vote on your poll arrives as "(vote: Tacos)" with vote, poll and poll_message_id, plus vote_removed="true" when taken back. Use reply_to (set to a message_id) only when replying to an earlier message; the latest message doesn\'t need a quote-reply.',
      '',
      'reply accepts file paths (files: ["/abs/path.png"]) for attachments, silent: true to skip the notification, and buttons: ["Yes", "No"] for tappable choices. Use react to add emoji reactions, and edit_message for interim progress updates or to swap a sent file. Edits don\'t trigger push notifications — when a long task completes, send a new reply so the user\'s device pings.',
      '',
      'new_thread opens another thread with its own fresh session and hands it your prompt. Use it for work the user will want to follow or talk to on its own. handoff moves this whole conversation to another app, such as telegram, when the user asks: you stop here and continue there with your memory.',
      '',
      "fetch_messages pulls real Discord history, from this thread by default. The tag's channel attribute names the channel this thread is in: fetch_messages(channel) reads that channel's top-level messages, a message with a thread shows its reply count, and fetch_messages(thread: that message's id) reads the thread. When the user refers to earlier work or talk in the channel, read it rather than saying you can't see it. To find an old message anywhere in the server, use search_messages.",
    ].join('\n'),
  },
)

mcp.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: 'reply',
      description: 'Reply in this Discord thread, or post in another one by name. Optionally pass reply_to (message_id) for threading, files (absolute paths) to attach images or other files, silent to send without a notification, and buttons for tappable choices.',
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
          silent: { type: 'boolean', description: 'Send without a push notification.' },
          buttons: {
            type: 'array',
            items: { type: 'string' },
            description: 'Button labels shown under the message (max 25, 80 chars each). A tap comes back as a message with button="true", and the buttons then lock showing the choice.',
          },
        },
        required: ['text'],
      },
    },
    {
      name: 'react',
      description: 'Add an emoji reaction to a Discord message, or take the bot\'s own off with remove. Unicode emoji work directly; custom emoji need the <:name:id> form.',
      inputSchema: {
        type: 'object',
        properties: {
          message_id: { type: 'string' },
          emoji: { type: 'string' },
          remove: { type: 'boolean', description: 'Remove the bot\'s reaction instead of adding it.' },
        },
        required: ['message_id', 'emoji'],
      },
    },
    {
      name: 'edit_message',
      description: 'Edit a message the bot previously sent: its text, its files, or both. Useful for interim progress updates. Edits don\'t trigger push notifications — send a new reply when a long task completes so the user\'s device pings.',
      inputSchema: {
        type: 'object',
        properties: {
          message_id: { type: 'string' },
          text: { type: 'string' },
          files: {
            type: 'array',
            items: { type: 'string' },
            description: 'Absolute file paths that replace the message\'s attachments.',
          },
        },
        required: ['message_id'],
      },
    },
    {
      name: 'delete_message',
      description: 'Delete a message the bot sent.',
      inputSchema: {
        type: 'object',
        properties: {
          message_id: { type: 'string' },
        },
        required: ['message_id'],
      },
    },
    {
      name: 'pin',
      description: 'Pin a message in this thread, or unpin it.',
      inputSchema: {
        type: 'object',
        properties: {
          message_id: { type: 'string' },
          unpin: { type: 'boolean' },
        },
        required: ['message_id'],
      },
    },
    {
      name: 'forward',
      description: 'Forward a message from this thread into another thread or a channel, as a Discord forward.',
      inputSchema: {
        type: 'object',
        properties: {
          message_id: { type: 'string' },
          thread: { type: 'string', description: 'Thread to forward into, by name.' },
          channel: { type: 'string', description: 'Channel to forward into instead, by name or id.' },
        },
        required: ['message_id'],
      },
    },
    {
      name: 'poll',
      description: 'Post a Discord poll in this thread. It runs for 24 hours.',
      inputSchema: {
        type: 'object',
        properties: {
          question: { type: 'string', description: 'Max 300 characters.' },
          options: { type: 'array', items: { type: 'string' }, description: '1–10 answers, 55 characters each.' },
          multiple: { type: 'boolean', description: 'Allow picking more than one answer.' },
        },
        required: ['question', 'options'],
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
          limit: { type: 'number', description: 'Max messages (default 20, Discord caps at 100).' },
        },
      },
    },
    {
      name: 'search_messages',
      description: 'Search messages across the Discord server by their text, newest first, with where each one is. Page with offset.',
      inputSchema: {
        type: 'object',
        properties: {
          query: { type: 'string' },
          channel: { type: 'string', description: 'Only search this channel, by name or id.' },
          limit: { type: 'number', description: 'Max results (default and cap 25).' },
          offset: { type: 'number', description: 'Skip this many results, to page on.' },
        },
        required: ['query'],
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
          about: { type: 'string', description: 'One line the user sees first in the new thread, saying what it is for and where it came from.' },
          channel: { type: 'string', description: 'Channel to open it in, by name. Defaults to this thread\'s channel.' },
        },
        required: ['title', 'prompt', 'about'],
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
