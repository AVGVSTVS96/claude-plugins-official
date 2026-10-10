#!/usr/bin/env bun
import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { ListToolsRequestSchema, CallToolRequestSchema } from '@modelcontextprotocol/sdk/types.js'
import { connect, type Socket } from 'net'

const SOCKET = process.env.HEX_HUB
const THREAD = process.env.HEX_CHANNEL?.startsWith('plugin:telegram@') ? process.env.HEX_THREAD : undefined

const mcp = new Server(
  { name: 'telegram', version: '1.0.0' },
  {
    capabilities: { tools: {}, experimental: { 'claude/channel': {} } },
    instructions: [
      'The sender reads Telegram, not this session. Anything you want them to see must go through the reply tool — your transcript output never reaches their chat. Nobody watches this terminal either, so once your reply is sent, end the turn instead of summarizing it here.',
      '',
      'This session is one Telegram thread: a forum topic, a group\'s General, or a direct chat. Its messages arrive as <channel source="telegram" chat_id="..." message_id="..." user="..." ts="...">, and everything you send with these tools lands back in that same thread. If the tag has an image_path attribute, Read that file — it is a photo the sender attached. If the tag has attachment_file_id, call download_attachment with that file_id to fetch the file, then Read the returned path. If the tag has reply_to_message_id, the sender replied to that earlier message: reply_to_text is its text or caption, reply_to_quote the part they highlighted, reply_to_image_path a photo it carried (Read it), and reply_to_attachment_file_id a file it carried (download_attachment). edited="true" means the sender edited the message with that message_id and this is its new text; forwarded_from names who a forwarded message came from. A photo album arrives as one message: image_path and the attachment_* attributes then list one value per file, separated by "; ". A reaction arrives as (reaction: 👍) or (reaction removed: 👍), with reaction, reaction_removed="true" when taken off, and reaction_to_message_id, reaction_to_user and reaction_to_text for the message it was on. A button tap arrives as the button\'s label with button="true" and button_message_id, and a poll vote as (vote: ...) or (vote removed), with vote (the chosen options), vote_removed="true", poll_message_id and poll (its question). Use reply_to (set to a message_id) only when replying to an earlier message; the latest message doesn\'t need a quote-reply.',
      '',
      'For formatted replies use format: "markdown" and write ordinary Markdown (code blocks, diagrams, bold, links, lists, tables), no escaping needed. reply accepts file paths (files: ["/abs/path.png"]) for attachments, silent: true to send without a notification, and buttons: ["Yes", "No"] for tappable choices. Use react to add or remove emoji reactions, edit_message for interim progress updates or to change a file\'s caption or the file itself, and delete_message, pin, forward and poll as their names say. Edits don\'t trigger push notifications — when a long task completes, send a new reply so the user\'s device pings.',
      '',
      'new_thread opens a new forum topic with its own fresh session and hands it your prompt; the topic starts with the user\'s request and your replies since, forwarded. Use it for work the user will want to follow or talk to on its own. It only works in a group with topics, and rename_thread changes a topic\'s name or icon. With app: "discord" or "buzz" it opens a Discord or Buzz thread instead, the place for deep, long-form work. handoff moves this whole conversation to Discord or Buzz when the user asks: you stop here and continue there with your memory (from General, a copy continues there and you stay).',
      '',
      "Telegram's Bot API exposes no history or search — you only see messages as they arrive. If you need earlier context, ask the user to paste it or summarize.",
    ].join('\n'),
  },
)

const titleProperty = { type: 'string', description: 'One word, like a chat name ("Anchors", "Frontier").' }

const formatProperty = {
  type: 'string',
  enum: ['markdown', 'text', 'markdownv2'],
  description: "Rendering mode. 'markdown' takes ordinary Markdown with no escaping: code blocks, inline code, bold, italic, links, strikethrough, lists, tables, headings. 'markdownv2' is Telegram's own syntax, where the caller escapes special chars. Default: 'text' (plain).",
}

mcp.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: 'reply',
      description: 'Reply in this Telegram thread, or post in another one by name. Optionally pass reply_to (message_id) for threading, files (absolute paths) to attach images or documents, and buttons for tappable choices.',
      inputSchema: {
        type: 'object',
        properties: {
          text: { type: 'string' },
          thread: {
            type: 'string',
            description: 'Topic name to post in instead of this thread, e.g. to remind the user in the topic that is waiting on them.',
          },
          reply_to: {
            type: 'string',
            description: 'Message ID to thread under. Use message_id from the inbound <channel> block.',
          },
          files: {
            type: 'array',
            items: { type: 'string' },
            description: 'Absolute file paths to attach. Images up to 10MB send as photos (inline preview); others as documents. Max 50MB each. Short text becomes the first file\'s caption.',
          },
          format: formatProperty,
          silent: { type: 'boolean', description: 'Send without a notification.' },
          buttons: {
            type: 'array',
            items: { type: 'string' },
            description: 'Labels of tappable choices under the message, e.g. ["Yes", "No"]. A tap comes back as a message and leaves only the chosen label on it.',
          },
        },
      },
    },
    {
      name: 'react',
      description: 'Add an emoji reaction to a Telegram message, or take yours off. Telegram only accepts a fixed whitelist (👍 👎 ❤ 🔥 👀 🎉 etc) — non-whitelisted emoji will be rejected.',
      inputSchema: {
        type: 'object',
        properties: {
          message_id: { type: 'string' },
          emoji: { type: 'string' },
          remove: { type: 'boolean', description: 'Take the bot\'s reaction off instead.' },
        },
        required: ['message_id', 'emoji'],
      },
    },
    {
      name: 'download_attachment',
      description: 'Download a file attachment from a Telegram message to the local inbox. Use when the inbound <channel> meta shows attachment_file_id. Returns the local file path ready to Read. Telegram caps bot downloads at 20MB.',
      inputSchema: {
        type: 'object',
        properties: {
          file_id: { type: 'string', description: 'The attachment_file_id from inbound meta' },
        },
        required: ['file_id'],
      },
    },
    {
      name: 'edit_message',
      description: 'Edit a message the bot previously sent: its text, a file\'s caption, or the file itself. Useful for interim progress updates. Edits don\'t trigger push notifications — send a new reply when a long task completes so the user\'s device pings.',
      inputSchema: {
        type: 'object',
        properties: {
          message_id: { type: 'string' },
          text: { type: 'string', description: 'New text, or new caption for a file.' },
          file: { type: 'string', description: 'Absolute path of a file to replace the sent one with.' },
          format: formatProperty,
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
      description: 'Forward a message from this thread into another topic, by name.',
      inputSchema: {
        type: 'object',
        properties: {
          message_id: { type: 'string' },
          thread: { type: 'string', description: 'Topic name to forward it into.' },
        },
        required: ['message_id', 'thread'],
      },
    },
    {
      name: 'poll',
      description: 'Send a poll. Each vote comes back as a message.',
      inputSchema: {
        type: 'object',
        properties: {
          question: { type: 'string' },
          options: { type: 'array', items: { type: 'string' } },
          multiple: { type: 'boolean', description: 'Allow picking more than one option.' },
        },
        required: ['question', 'options'],
      },
    },
    {
      name: 'rename_thread',
      description: 'Rename this topic, change its icon, or both.',
      inputSchema: {
        type: 'object',
        properties: {
          title: titleProperty,
          icon: { type: 'string', description: 'An emoji from Telegram\'s topic icon set, e.g. 🔥.' },
        },
      },
    },
    {
      name: 'close_thread',
      description: 'Close a forum topic whose work is done and stop its session once it is idle. Defaults to this thread. The user can still reopen it in Telegram, and a new message there resumes the session.',
      inputSchema: {
        type: 'object',
        properties: {
          thread: { type: 'string', description: 'Topic name to close instead of this thread.' },
        },
      },
    },
    {
      name: 'new_thread',
      description: 'Open a new forum topic in this group, start a fresh session for it, and give that session the prompt as its first message.',
      inputSchema: {
        type: 'object',
        properties: {
          title: titleProperty,
          prompt: { type: 'string', description: 'Everything the new session needs to start the work: it shares none of your context.' },
          about: { type: 'string', description: 'One line the user sees first in the new thread, saying what it is for and where it came from.' },
          app: { type: 'string', enum: ['telegram', 'discord', 'buzz'], description: 'Where to open it. Default: telegram.' },
          channel: { type: 'string', description: 'Discord or Buzz only: the channel to open it in, by name. Default: the server\'s first channel.' },
        },
        required: ['title', 'prompt', 'about'],
      },
    },
    {
      name: 'handoff',
      description: 'Move this conversation to Discord or Buzz when the user asks. It opens a thread there, and this session stops here once the turn ends and resumes there with its full memory. From General, a copy continues there and you stay. The title defaults to this topic\'s name, and is required from General.',
      inputSchema: {
        type: 'object',
        properties: {
          to: { type: 'string', enum: ['discord', 'buzz'] },
          title: titleProperty,
          channel: { type: 'string', description: 'Channel to open it in, by name. Default: the server\'s first channel.' },
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
  if (!THREAD) return Promise.reject(new Error('this session is not bound to a Telegram thread (HEX_THREAD is unset)'))
  if (!hub) return Promise.reject(new Error('the Telegram hub is not running'))
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
        }).catch(err => process.stderr.write(`telegram channel: failed to deliver inbound to Claude: ${err}\n`))
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
    for (const waiter of pending.values()) waiter.reject(new Error('the Telegram hub disconnected'))
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
