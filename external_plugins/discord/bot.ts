#!/usr/bin/env bun
import {
  Client,
  GatewayIntentBits,
  ChannelType,
  type Message as DiscordMessage,
  type Attachment,
  type TextChannel,
  type ThreadChannel,
} from 'discord.js'
import { readFileSync, writeFileSync, mkdirSync, statSync, realpathSync, chmodSync } from 'fs'
import { homedir } from 'os'
import { join, sep } from 'path'
import { startHub, clients, move, type Message } from '../../hub/hub.ts'

const STATE_DIR = process.env.DISCORD_STATE_DIR ?? join(homedir(), '.claude', 'channels', 'hex', 'discord')
const ACCESS_FILE = join(STATE_DIR, 'access.json')
const ENV_FILE = join(STATE_DIR, '.env')
const INBOX_DIR = join(STATE_DIR, 'inbox')

try {
  chmodSync(ENV_FILE, 0o600)
  for (const line of readFileSync(ENV_FILE, 'utf8').split('\n')) {
    const m = line.match(/^(\w+)=(.*)$/)
    if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2]
  }
} catch {}

const TOKEN = process.env.DISCORD_BOT_TOKEN

if (!TOKEN) {
  process.stderr.write(`discord hub: no DISCORD_BOT_TOKEN in ${ENV_FILE}, Discord stays off\n`)
} else {
  process.on('unhandledRejection', err => {
    process.stderr.write(`discord hub: unhandled rejection: ${err}\n`)
  })
  process.on('uncaughtException', err => {
    process.stderr.write(`discord hub: uncaught exception: ${err}\n`)
  })
  serve(TOKEN)
}

type Access = {
  allowFrom: string[]
  /** Emoji to react with on receipt. Empty string disables. Unicode char or custom emoji ID. */
  ackReaction?: string
  /** Which chunks get Discord's reply reference when reply_to is passed. Default: 'first'. 'off' = never thread. */
  replyToMode?: 'off' | 'first' | 'all'
  /** Max chars per outbound message before splitting. Default: 2000 (Discord's hard cap). */
  textChunkLimit?: number
  /** Split on paragraph boundaries instead of hard char count. Default: 'newline'. */
  chunkMode?: 'length' | 'newline'
}

function loadAccess(): Access {
  try {
    return { allowFrom: [], ...JSON.parse(readFileSync(ACCESS_FILE, 'utf8')) }
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') process.stderr.write(`discord hub: ${ACCESS_FILE} is unreadable, so every sender is dropped: ${err}\n`)
    return { allowFrom: [] }
  }
}

const MAX_CHUNK_LIMIT = 2000
const MAX_ATTACHMENT_BYTES = 25 * 1024 * 1024

// reply's files param takes any path, but the server's own state (the token
// in .env) is the one thing Claude has no reason to ever send.
function assertSendable(f: string): void {
  let real, stateReal: string
  try {
    real = realpathSync(f)
    stateReal = realpathSync(STATE_DIR)
  } catch { return }
  const inbox = join(stateReal, 'inbox')
  if (real.startsWith(stateReal + sep) && !real.startsWith(inbox + sep)) {
    throw new Error(`refusing to send channel state: ${f}`)
  }
}

function chunk(text: string, limit: number, mode: 'length' | 'newline'): string[] {
  if (text.length <= limit) return [text]
  const out: string[] = []
  let rest = text
  while (rest.length > limit) {
    let cut = limit
    if (mode === 'newline') {
      const para = rest.lastIndexOf('\n\n', limit)
      const line = rest.lastIndexOf('\n', limit)
      const space = rest.lastIndexOf(' ', limit)
      cut = para > limit / 2 ? para : line > limit / 2 ? line : space > 0 ? space : limit
    }
    out.push(rest.slice(0, cut))
    rest = rest.slice(cut).replace(/^\n+/, '')
  }
  if (rest) out.push(rest)
  return out
}

// A code block cut across two messages renders as broken text in both, so
// each chunk closes the fence it opened and the next one reopens it.
function fenced(text: string, limit: number, mode: 'length' | 'newline'): string[] {
  const out: string[] = []
  let open = ''
  for (const part of chunk(text, limit - 16, mode)) {
    let body = open ? `${open}\n${part}` : part
    for (const line of part.split('\n')) {
      const fence = line.match(/^\s*```(\S*)/)
      if (fence) open = open ? '' : '```' + fence[1]
    }
    if (open) body += '\n```'
    out.push(body)
  }
  return out
}

// att.name is uploader-controlled. It lands inside the <channel> notification,
// where delimiter chars would let the uploader break out of the tag.
function safeAttName(att: Attachment): string {
  return (att.name ?? att.id).replace(/[<>\[\]\r\n;]/g, '_')
}

async function downloadAttachment(att: Attachment): Promise<string> {
  if (att.size > MAX_ATTACHMENT_BYTES) {
    throw new Error(`attachment too large: ${(att.size / 1024 / 1024).toFixed(1)}MB, max ${MAX_ATTACHMENT_BYTES / 1024 / 1024}MB`)
  }
  const res = await fetch(att.url)
  const buf = Buffer.from(await res.arrayBuffer())
  const name = att.name ?? `${att.id}`
  const rawExt = name.includes('.') ? name.slice(name.lastIndexOf('.') + 1) : 'bin'
  const ext = rawExt.replace(/[^a-zA-Z0-9]/g, '') || 'bin'
  const path = join(INBOX_DIR, `${Date.now()}-${att.id}.${ext}`)
  mkdirSync(INBOX_DIR, { recursive: true })
  writeFileSync(path, buf)
  return path
}

function title(text: string): string {
  const title = text.trim()
  if (!title || title.split(/\s+/).length > 2) throw new Error(`title must be 1–2 words, got "${title}"`)
  return title
}

function serve(token: string) {
  const client = new Client({
    intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent],
  })

  async function threadChannel(thread: string): Promise<ThreadChannel> {
    const ch = await client.channels.fetch(thread)
    if (!ch?.isThread()) throw new Error(`${thread} is not a Discord thread`)
    return ch
  }

  function guild() {
    const guild = client.guilds.cache.first()
    if (!guild) throw new Error('the bot is in no Discord server')
    return guild
  }

  async function textChannel(name?: string): Promise<TextChannel> {
    const g = guild()
    const wanted = name?.replace(/^#/, '').toLowerCase()
    const found = wanted
      ? (await g.channels.fetch()).find(ch => ch?.type === ChannelType.GuildText && ch.name.toLowerCase() === wanted)
      : g.systemChannel
    if (found?.type !== ChannelType.GuildText) throw new Error(wanted ? `no text channel named #${wanted}` : 'name a channel to open the thread in')
    return found
  }

  const link = (thread: string) => `https://discord.com/channels/${guild().id}/${thread}`

  async function place(name: string, where?: string) {
    const thread = await (await textChannel(where)).threads.create({ name })
    return { thread: thread.id, link: link(thread.id) }
  }

  const typing = new Map<string, ReturnType<typeof setInterval>>()

  function sendTyping(thread: string): void {
    void threadChannel(thread).then(ch => ch.sendTyping()).catch(() => {})
  }

  // Discord shows "typing…" for about 10 seconds per call, so it is re-sent
  // for as long as the thread's session is busy.
  function showTyping(thread: string, busy: boolean): void {
    process.stderr.write(`discord hub: ${thread} ${busy ? 'busy' : 'idle'}\n`)
    clearInterval(typing.get(thread))
    typing.delete(thread)
    if (!busy) return
    sendTyping(thread)
    typing.set(thread, setInterval(() => sendTyping(thread), 8000))
  }

  async function call(caller: string, tool: string, args: Record<string, unknown>): Promise<string> {
    if (tool === 'new_thread') {
      const name = title(args.title as string)
      const parent = (args.channel as string | undefined) ?? (await threadChannel(caller)).parent?.name
      const { thread, link } = await place(name, parent)
      hub.open(thread, name, args.prompt as string)
      return `started thread "${name}": ${link}`
    }
    const thread = args.thread ? hub.find(args.thread as string) : caller
    const ch = await threadChannel(thread)
    const access = loadAccess()
    switch (tool) {
      case 'reply': {
        const text = args.text as string
        const reply_to = args.reply_to as string | undefined
        const files = (args.files as string[] | undefined) ?? []

        for (const f of files) {
          assertSendable(f)
          const st = statSync(f)
          if (st.size > MAX_ATTACHMENT_BYTES) {
            throw new Error(`file too large: ${f} (${(st.size / 1024 / 1024).toFixed(1)}MB, max 25MB)`)
          }
        }
        if (files.length > 10) throw new Error('Discord allows max 10 attachments per message')

        const limit = Math.max(100, Math.min(access.textChunkLimit ?? MAX_CHUNK_LIMIT, MAX_CHUNK_LIMIT))
        const replyMode = access.replyToMode ?? 'first'
        const chunks = fenced(text, limit, access.chunkMode ?? 'newline')
        const sentIds: string[] = []

        try {
          for (let i = 0; i < chunks.length; i++) {
            const shouldReplyTo = reply_to != null && replyMode !== 'off' && (replyMode === 'all' || i === 0)
            const sent = await ch.send({
              content: chunks[i],
              ...(i === 0 && files.length > 0 ? { files } : {}),
              ...(shouldReplyTo ? { reply: { messageReference: reply_to, failIfNotExists: false } } : {}),
            })
            sentIds.push(sent.id)
          }
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err)
          throw new Error(`reply failed after ${sentIds.length} of ${chunks.length} chunk(s) sent: ${msg}`)
        }

        return sentIds.length === 1 ? `sent (id: ${sentIds[0]})` : `sent ${sentIds.length} parts (ids: ${sentIds.join(', ')})`
      }
      case 'fetch_messages': {
        const limit = Math.min((args.limit as number) ?? 20, 100)
        const msgs = await ch.messages.fetch({ limit })
        const me = client.user?.id
        const arr = [...msgs.values()].reverse()
        if (arr.length === 0) return '(no messages)'
        // The result is newline-joined, so multi-line content would forge adjacent rows.
        return arr
          .map(m => {
            const who = m.author.id === me ? 'me' : m.author.username
            const atts = m.attachments.size > 0 ? ` +${m.attachments.size}att` : ''
            const text = m.content.replace(/[\r\n]+/g, ' ⏎ ')
            return `[${m.createdAt.toISOString()}] ${who}: ${text}  (id: ${m.id}${atts})`
          })
          .join('\n')
      }
      case 'react': {
        const msg = await ch.messages.fetch(args.message_id as string)
        await msg.react(args.emoji as string)
        return 'reacted'
      }
      case 'edit_message': {
        const msg = await ch.messages.fetch(args.message_id as string)
        const edited = await msg.edit(args.text as string)
        return `edited (id: ${edited.id})`
      }
      case 'download_attachment': {
        const msg = await ch.messages.fetch(args.message_id as string)
        if (msg.attachments.size === 0) return 'message has no attachments'
        const lines: string[] = []
        for (const att of msg.attachments.values()) {
          const path = await downloadAttachment(att)
          const kb = (att.size / 1024).toFixed(0)
          lines.push(`  ${path}  (${safeAttName(att)}, ${att.contentType ?? 'unknown'}, ${kb}KB)`)
        }
        return `downloaded ${lines.length} attachment(s):\n${lines.join('\n')}`
      }
      case 'rename_thread': {
        const name = title(args.title as string)
        await ch.setName(name)
        hub.rename(thread, name)
        return `renamed to "${name}"`
      }
      case 'close_thread': {
        hub.retire(thread)
        await ch.setArchived(true)
        return `archived "${ch.name}"; its session stops once it's idle`
      }
      case 'handoff': {
        const to = args.to as string
        const name = args.title ? title(args.title as string) : ch.name
        const target = await move(hub, thread, to, name)
        await ch.send(`Moved to ${to}: ${target}`)
        await ch.setArchived(true)
        return `moving to ${to}: ${target}. Your session stops here once this turn ends and resumes there.`
      }
      default:
        throw new Error(`unknown tool: ${tool}`)
    }
  }

  const hub = startHub({
    stateDir: STATE_DIR,
    channel: 'plugin:discord@hex',
    call,
    state: showTyping,
    failed: (thread, reason) => {
      void threadChannel(thread).then(ch => ch.send(`Couldn't start this thread's session: ${reason}`)).catch(() => {})
    },
    hexDir: process.env.HEX_DIR,
  })

  clients.set('discord', { hub, place })

  // A tag in a channel starts a thread on that message, Claude-tag style;
  // inside a thread every message reaches its session without one.
  async function threadOf(msg: DiscordMessage): Promise<ThreadChannel | undefined> {
    if (msg.channel.isThread()) return msg.channel
    if (msg.channel.type !== ChannelType.GuildText || !client.user || !msg.mentions.has(client.user)) return
    const words = msg.content.replace(/<@!?\d+>/g, '').trim().split(/\s+/).filter(Boolean)
    return msg.startThread({ name: words.slice(0, 2).join(' ') || 'New thread' })
  }

  async function handleInbound(msg: DiscordMessage): Promise<void> {
    const access = loadAccess()
    if (!access.allowFrom.includes(msg.author.id)) return

    const ch = await threadOf(msg)
    if (!ch) return
    const fresh = ch.id === msg.id
    if (ch.archived) await ch.setArchived(false).catch(() => {})

    void ch.sendTyping().catch(() => {})
    if (access.ackReaction) void msg.react(access.ackReaction).catch(() => {})

    // Attachments are listed (name/type/size) but not downloaded: the model
    // calls download_attachment when it wants them. The listing goes in meta
    // only, since an in-content annotation is forgeable by the sender.
    const atts: string[] = []
    for (const att of msg.attachments.values()) {
      const kb = (att.size / 1024).toFixed(0)
      atts.push(`${safeAttName(att)} (${att.contentType ?? 'unknown'}, ${kb}KB)`)
    }

    const message: Message = {
      content: msg.content.replace(/<@!?\d+>/g, '').trim() || (atts.length > 0 ? '(attachment)' : ''),
      meta: {
        chat_id: ch.id,
        message_id: msg.id,
        user: msg.author.username,
        user_id: msg.author.id,
        ts: msg.createdAt.toISOString(),
        ...(fresh ? { new_thread: 'true' } : {}),
        ...(atts.length > 0 ? { attachment_count: String(atts.length), attachments: atts.join('; ') } : {}),
      },
    }
    hub.deliver(ch.id, ch.name, message)
  }

  client.on('messageCreate', msg => {
    if (msg.author.bot || !msg.inGuild()) return
    handleInbound(msg).catch(e => process.stderr.write(`discord hub: handleInbound failed: ${e}\n`))
  })

  client.on('threadUpdate', (before, after) => {
    if (before.name !== after.name) hub.rename(after.id, after.name)
  })

  client.on('threadDelete', thread => {
    process.stderr.write(`discord hub: thread ${thread.id} was deleted, forgetting it\n`)
    void hub.retire(thread.id)
  })

  client.on('error', err => {
    process.stderr.write(`discord hub: client error: ${err}\n`)
  })

  client.once('clientReady', c => {
    process.stderr.write(`discord hub: gateway connected as ${c.user.tag}\n`)
  })

  client.login(token).catch(err => {
    process.stderr.write(`discord hub: login failed: ${err}\n`)
  })
}
