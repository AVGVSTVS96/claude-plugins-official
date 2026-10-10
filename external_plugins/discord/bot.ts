#!/usr/bin/env bun
import {
  Client,
  GatewayIntentBits,
  Partials,
  ChannelType,
  MessageType,
  MessageFlags,
  PermissionFlagsBits,
  SnowflakeUtil,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  Routes,
  parseEmoji,
  type Message as DiscordMessage,
  type PartialMessage,
  type MessageReaction,
  type PartialMessageReaction,
  type User,
  type PartialUser,
  type ButtonInteraction,
  type PollAnswer,
  type PartialPollAnswer,
  type ActionRow,
  type ButtonComponent,
  type RESTGetAPIGuildMessagesSearchResult,
  type Attachment,
  type Collection,
  type Channel,
  type NewsChannel,
  type TextChannel,
  type ThreadChannel,
} from 'discord.js'
import { readFileSync, writeFileSync, mkdirSync, statSync, realpathSync, chmodSync } from 'fs'
import { homedir } from 'os'
import { basename, join, sep } from 'path'
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
const READ = [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.ReadMessageHistory]

// reply's files param takes any path, but channel state and .env files (tokens)
// are the things Claude has no reason to ever send.
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
  if (basename(real) === '.env') throw new Error(`refusing to send secrets: ${f}`)
}

function sendable(files: string[]): string[] {
  for (const f of files) {
    assertSendable(f)
    const st = statSync(f)
    if (st.size > MAX_ATTACHMENT_BYTES) {
      throw new Error(`file too large: ${f} (${(st.size / 1024 / 1024).toFixed(1)}MB, max 25MB)`)
    }
  }
  if (files.length > 10) throw new Error('Discord allows max 10 attachments per message')
  return files
}

const isText = (ch: Channel | null | undefined): ch is TextChannel | NewsChannel =>
  ch?.type === ChannelType.GuildText || ch?.type === ChannelType.GuildAnnouncement

// A tapped set stays on its message, disabled, with the choice highlighted.
function buttons(labels: string[], chosen?: number): ActionRowBuilder<ButtonBuilder>[] {
  const rows: ActionRowBuilder<ButtonBuilder>[] = []
  labels.forEach((label, i) => {
    if (i % 5 === 0) rows.push(new ActionRowBuilder<ButtonBuilder>())
    rows.at(-1)!.addComponents(new ButtonBuilder()
      .setCustomId(String(i))
      .setLabel(label)
      .setStyle(i === chosen ? ButtonStyle.Primary : ButtonStyle.Secondary)
      .setDisabled(chosen !== undefined))
  })
  return rows
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

function listed(attachments: Collection<string, Attachment>): string[] {
  return attachments.map(att => `${safeAttName(att)} (${att.contentType ?? 'unknown'}, ${(att.size / 1024).toFixed(0)}KB)`)
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
    intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.GuildMessageReactions, GatewayIntentBits.GuildMessagePolls, GatewayIntentBits.MessageContent],
    partials: [Partials.Message, Partials.Reaction, Partials.User, Partials.Poll, Partials.PollAnswer],
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

  async function textChannel(name?: string): Promise<TextChannel | NewsChannel> {
    const g = guild()
    const wanted = name?.replace(/^#/, '').toLowerCase()
    const found = wanted
      ? (await g.channels.fetch()).find(ch => isText(ch) && (ch.id === wanted || ch.name.toLowerCase() === wanted))
      : g.systemChannel
    if (!isText(found)) throw new Error(wanted ? `no text channel named #${wanted}` : 'name a channel to open the thread in')
    return found
  }

  async function readable(id: string): Promise<TextChannel | NewsChannel | ThreadChannel> {
    const ch = await client.channels.fetch(id).catch(() => null)
    const text = isText(ch) || ch?.isThread() ? ch : undefined
    if (!text || text.guildId !== guild().id || !text.permissionsFor(client.user!)?.has(READ)) {
      throw new Error(`the bot can't read ${id}; list_channels shows the channels it can`)
    }
    return text
  }

  // Results are newline-joined, so multi-line content would forge adjacent rows.
  function row(at: Date, author: { id: string; username: string }, content: string, details: string): string {
    const who = author.id === client.user?.id ? 'me' : author.username
    return `[${at.toISOString()}] ${who}: ${content.replace(/[\r\n]+/g, ' ⏎ ')}  (${details})`
  }

  async function history(caller: string, args: Record<string, unknown>): Promise<string> {
    const limit = Math.min((args.limit as number) ?? 20, 100)
    const named = args.thread as string | undefined
    const id = named ? (/^\d+$/.test(named) ? named : hub.find(named)) : args.channel ? (await textChannel(args.channel as string)).id : caller
    const ch = id === caller ? await threadChannel(caller) : await readable(id)
    const msgs = await ch.messages.fetch({ limit, ...(args.before ? { before: args.before as string } : {}) })
    const arr = [...msgs.values()].reverse()
    if (arr.length === 0) return '(no messages)'
    return arr
      .map(m => {
        const atts = m.attachments.size > 0 ? ` +${m.attachments.size}att` : ''
        const last = m.thread?.lastMessageId ? `, last reply ${new Date(SnowflakeUtil.timestampFrom(m.thread.lastMessageId)).toISOString()}` : ''
        const thread = m.thread ? `, ${m.thread.messageCount ?? 0} replies${last}` : ''
        return row(m.createdAt, m.author, m.content, `id: ${m.id}${atts}${thread}`)
      })
      .join('\n')
  }

  async function search(args: Record<string, unknown>): Promise<string> {
    const query = new URLSearchParams({ content: args.query as string, limit: String(Math.min((args.limit as number) ?? 25, 25)) })
    if (args.channel) query.set('channel_id', (await textChannel(args.channel as string)).id)
    if (args.offset) query.set('offset', String(args.offset))
    const found = await client.rest.get(Routes.guildMessagesSearch(guild().id), { query }) as RESTGetAPIGuildMessagesSearchResult
    if (!('messages' in found)) return `Discord is still indexing this server's messages; search again ${found.retry_after ? `in ${found.retry_after}s` : 'shortly'}`
    const threads = new Map(found.threads?.map(t => [t.id, t.name]))
    const rows = found.messages.flat().map(m => {
      const where = threads.has(m.channel_id) ? `thread ${m.channel_id} "${threads.get(m.channel_id)}"` : `#${guild().channels.cache.get(m.channel_id)?.name ?? m.channel_id}`
      const atts = m.attachments.length > 0 ? ` +${m.attachments.length}att` : ''
      return row(new Date(m.timestamp), m.author, m.content, `id: ${m.id}, in ${where}${atts}`)
    })
    return [`${found.total_results} found, newest first`, ...rows].join('\n')
  }

  async function listChannels(): Promise<string> {
    const found = (await guild().channels.fetch()).filter(ch => isText(ch) && !!ch.permissionsFor(client.user!)?.has(READ))
    return found.map(ch => `#${ch!.name}  (id: ${ch!.id})`).join('\n') || '(none)'
  }

  const link = (thread: string) => `https://discord.com/channels/${guild().id}/${thread}`

  async function place(name: string, where?: string) {
    const thread = await (await textChannel(where)).threads.create({ name })
    return { thread: thread.id, link: link(thread.id) }
  }

  // A thread's starter message lives in the channel it hangs off, under the thread's own id.
  async function message(ch: ThreadChannel, id: string): Promise<DiscordMessage> {
    const msg = id === ch.id ? await ch.fetchStarterMessage() : await ch.messages.fetch(id)
    if (!msg) throw new Error(`no message ${id} in this thread`)
    return msg
  }

  const deleting = new Set<string>()

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
    if (tool === 'fetch_messages') return history(caller, args)
    if (tool === 'list_channels') return listChannels()
    if (tool === 'search_messages') return search(args)
    if (tool === 'forward') {
      if (!args.thread && !args.channel) throw new Error('name a thread or channel to forward to')
      const to = args.channel ? await textChannel(args.channel as string) : await threadChannel(hub.find(args.thread as string))
      const sent = await (await message(await threadChannel(caller), args.message_id as string)).forward(to.id)
      return `forwarded (id: ${sent.id})`
    }
    const thread = args.thread ? hub.find(args.thread as string) : caller
    const ch = await threadChannel(thread)
    const access = loadAccess()
    switch (tool) {
      case 'reply': {
        const text = args.text as string
        const reply_to = args.reply_to as string | undefined
        const files = sendable((args.files as string[] | undefined) ?? [])
        const labels = args.buttons as string[] | undefined
        const components = labels?.length ? buttons(labels) : undefined

        const limit = Math.max(100, Math.min(access.textChunkLimit ?? MAX_CHUNK_LIMIT, MAX_CHUNK_LIMIT))
        const replyMode = access.replyToMode ?? 'first'
        const chunks = fenced(text, limit, access.chunkMode ?? 'newline')
        const sentIds: string[] = []

        try {
          for (let i = 0; i < chunks.length; i++) {
            const shouldReplyTo = reply_to != null && replyMode !== 'off' && (replyMode === 'all' || i === 0)
            const sent = await ch.send({
              content: chunks[i],
              ...(args.silent ? { flags: MessageFlags.SuppressNotifications } : {}),
              ...(i === 0 && files.length > 0 ? { files } : {}),
              ...(i === chunks.length - 1 && components ? { components } : {}),
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
      case 'react': {
        const msg = await message(ch, args.message_id as string)
        if (!args.remove) {
          await msg.react(args.emoji as string)
          return 'reacted'
        }
        const { id, name } = parseEmoji(args.emoji as string) ?? {}
        const mine = msg.reactions.cache.get((id || name)!)
        if (!mine?.me) throw new Error(`the bot hasn't reacted ${args.emoji} to that message`)
        await mine.users.remove()
        return 'reaction removed'
      }
      case 'edit_message': {
        const msg = await message(ch, args.message_id as string)
        const files = args.files ? sendable(args.files as string[]) : undefined
        const edited = await msg.edit({
          ...(args.text !== undefined ? { content: args.text as string } : {}),
          ...(files ? { files, attachments: [] } : {}),
        })
        return `edited (id: ${edited.id})`
      }
      case 'delete_message': {
        const msg = await message(ch, args.message_id as string)
        if (msg.author.id !== client.user!.id) throw new Error('the bot can only delete its own messages')
        deleting.add(msg.id)
        await msg.delete().catch(err => {
          deleting.delete(msg.id)
          throw err
        })
        return 'deleted'
      }
      case 'pin': {
        const msg = await message(ch, args.message_id as string)
        await (args.unpin ? msg.unpin() : msg.pin())
        return args.unpin ? 'unpinned' : 'pinned'
      }
      case 'poll': {
        const sent = await ch.send({
          poll: {
            question: { text: args.question as string },
            answers: (args.options as string[]).map(text => ({ text })),
            allowMultiselect: !!args.multiple,
            duration: 24,
          },
        })
        return `sent poll (id: ${sent.id})`
      }
      case 'download_attachment': {
        const msg = await message(ch, args.message_id as string)
        const attachments = msg.messageSnapshots.first()?.attachments ?? msg.attachments
        if (attachments.size === 0) return 'message has no attachments'
        const lines: string[] = []
        for (const att of attachments.values()) {
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
    launcher: process.env.HEX_LAUNCHER,
  })

  clients.set('discord', { hub, place })

  // A tag in a channel starts a thread on that message, Claude-tag style;
  // inside a thread every message reaches its session without one.
  async function threadOf(msg: DiscordMessage): Promise<ThreadChannel | undefined> {
    if (msg.channel.isThread()) return msg.channel
    if (!isText(msg.channel) || !client.user || !msg.mentions.has(client.user)) return
    if (msg.thread) return msg.thread
    const words = msg.content.replace(/<@[!&]?\d+>/g, '').trim().split(/\s+/).filter(Boolean)
    return msg.startThread({ name: words.slice(0, 2).join(' ') || 'New thread' })
  }

  async function replyMeta(msg: DiscordMessage): Promise<Record<string, string>> {
    if (msg.type !== MessageType.Reply || !msg.reference?.messageId) return {}
    const replied = await msg.fetchReference().catch(() => undefined)
    if (!replied) return { reply_to_message_id: msg.reference.messageId }
    const atts = listed(replied.attachments)
    return {
      reply_to_message_id: replied.id,
      reply_to_user: replied.author.username,
      ...(replied.content ? { reply_to_text: replied.content } : {}),
      ...(atts.length > 0 ? { reply_to_attachments: atts.join('; ') } : {}),
    }
  }

  async function handleInbound(msg: DiscordMessage, edited = false): Promise<void> {
    const access = loadAccess()
    if (!access.allowFrom.includes(msg.author.id)) return

    const ch = await threadOf(msg)
    if (!ch) return
    const opened = !edited && ch.id === msg.id
    const forum = !!ch.parent?.isThreadOnly()
    if (ch.archived) await ch.setArchived(false).catch(() => {})

    void ch.sendTyping().catch(() => {})
    if (access.ackReaction) void msg.react(access.ackReaction).catch(() => {})

    // Attachments are listed (name/type/size) but not downloaded: the model
    // calls download_attachment when it wants them. The listing goes in meta
    // only, since an in-content annotation is forgeable by the sender.
    const forwarded = msg.messageSnapshots.first()
    const source = forwarded ?? msg
    const atts = listed(source.attachments)
    const stickers = source.stickers.map(s => `${s.name} (${s.url})`)
    const poll = msg.poll

    const message: Message = {
      content: source.content.replace(/<@[!&]?\d+>/g, '').trim() || (atts.length > 0 ? '(attachment)' : stickers.length > 0 ? '(sticker)' : poll ? '(poll)' : ''),
      meta: {
        chat_id: ch.id,
        message_id: msg.id,
        user: msg.author.username,
        user_id: msg.author.id,
        ts: msg.createdAt.toISOString(),
        ...(ch.parent ? { channel: ch.parent.name } : {}),
        ...(opened && !forum ? { new_thread: 'true' } : {}),
        ...(opened && forum ? { post_title: ch.name } : {}),
        ...(atts.length > 0 ? { attachment_count: String(atts.length), attachments: atts.join('; ') } : {}),
        ...(stickers.length > 0 ? { stickers: stickers.join('; ') } : {}),
        ...(poll ? { poll: poll.question.text!, poll_options: poll.answers.map(a => a.text).join('; '), ...(poll.allowMultiselect ? { poll_multiple: 'true' } : {}) } : {}),
        ...(await replyMeta(msg)),
        ...(edited ? { edited: 'true' } : {}),
        ...(forwarded ? { forwarded: 'true' } : {}),
      },
    }
    hub.deliver(ch.id, ch.name, message)
  }

  // Reactions and deletes reach only a thread the hub already serves: in it,
  // or on the message it hangs off, which shares the thread's id.
  async function servedThread(msg: DiscordMessage | PartialMessage): Promise<ThreadChannel | undefined> {
    const id = msg.channel.isThread() ? msg.channelId : msg.id
    return hub.name(id) ? threadChannel(id) : undefined
  }

  async function handleReaction(reaction: MessageReaction | PartialMessageReaction, user: User | PartialUser, removed: boolean): Promise<void> {
    if (!loadAccess().allowFrom.includes(user.id)) return
    const ch = await servedThread(reaction.message)
    if (!ch) return
    const target = reaction.message.partial ? await reaction.message.fetch().catch(() => undefined) : reaction.message
    const who = user.partial ? await user.fetch() : user
    const emoji = reaction.emoji.toString()
    hub.deliver(ch.id, ch.name, {
      content: `(${removed ? 'reaction removed' : 'reaction'}: ${emoji})`,
      meta: {
        chat_id: ch.id,
        user: who.username,
        user_id: who.id,
        ts: new Date().toISOString(),
        reaction: emoji,
        ...(removed ? { reaction_removed: 'true' } : {}),
        reaction_to_message_id: reaction.message.id,
        ...(target ? { reaction_to_user: target.author.username } : {}),
        ...(target?.content ? { reaction_to_text: target.content } : {}),
      },
    })
  }

  // Discord doesn't say who deleted a message, so every delete in a served
  // thread is reported except the bot's own delete_message calls.
  async function handleDelete(msg: DiscordMessage | PartialMessage): Promise<void> {
    if (deleting.delete(msg.id)) return
    const ch = await servedThread(msg)
    if (!ch) return
    hub.deliver(ch.id, ch.name, {
      content: '(deleted a message)',
      meta: {
        chat_id: ch.id,
        message_id: msg.id,
        ts: new Date().toISOString(),
        deleted: 'true',
        ...(msg.content ? { deleted_text: msg.content } : {}),
      },
    })
  }

  async function handleVote(answer: PollAnswer | PartialPollAnswer, userId: string, removed: boolean): Promise<void> {
    if (!loadAccess().allowFrom.includes(userId)) return
    const ch = await servedThread(answer.poll.message)
    if (!ch) return
    const msg = answer.poll.message.partial ? await answer.poll.message.fetch() : answer.poll.message
    if (msg.author.id !== client.user!.id || !msg.poll) return
    const vote = msg.poll.answers.get(answer.id)?.text ?? ''
    const who = await client.users.fetch(userId)
    hub.deliver(ch.id, ch.name, {
      content: `(${removed ? 'vote removed' : 'vote'}: ${vote})`,
      meta: {
        chat_id: ch.id,
        user: who.username,
        user_id: who.id,
        ts: new Date().toISOString(),
        vote,
        ...(removed ? { vote_removed: 'true' } : {}),
        poll_message_id: msg.id,
        poll: msg.poll.question.text ?? '',
      },
    })
  }

  async function handleTap(tap: ButtonInteraction): Promise<void> {
    if (!loadAccess().allowFrom.includes(tap.user.id)) return void (await tap.deferUpdate())
    const labels = (tap.message.components as ActionRow<ButtonComponent>[]).flatMap(row => row.components.map(button => button.label!))
    const chosen = Number(tap.customId)
    await tap.update({ components: buttons(labels, chosen) })
    const ch = await threadChannel(tap.channelId)
    hub.deliver(ch.id, ch.name, {
      content: labels[chosen]!,
      meta: {
        chat_id: ch.id,
        user: tap.user.username,
        user_id: tap.user.id,
        ts: tap.createdAt.toISOString(),
        button: 'true',
        button_message_id: tap.message.id,
      },
    })
  }

  const failure = (what: string) => (e: unknown) => process.stderr.write(`discord hub: ${what} failed: ${e}\n`)

  client.on('messageReactionAdd', (reaction, user) => {
    handleReaction(reaction, user, false).catch(failure('handleReaction'))
  })

  client.on('messageReactionRemove', (reaction, user) => {
    handleReaction(reaction, user, true).catch(failure('handleReaction'))
  })

  client.on('messagePollVoteAdd', (answer, userId) => {
    handleVote(answer, userId, false).catch(failure('handleVote'))
  })

  client.on('messagePollVoteRemove', (answer, userId) => {
    handleVote(answer, userId, true).catch(failure('handleVote'))
  })

  client.on('messageDelete', msg => {
    handleDelete(msg).catch(failure('handleDelete'))
  })

  client.on('messageDeleteBulk', msgs => {
    for (const msg of msgs.values()) handleDelete(msg).catch(failure('handleDelete'))
  })

  client.on('interactionCreate', interaction => {
    if (interaction.isButton()) handleTap(interaction).catch(failure('handleTap'))
  })

  client.on('messageCreate', msg => {
    if (msg.author.bot || !msg.inGuild()) return
    handleInbound(msg).catch(failure('handleInbound'))
  })

  client.on('messageUpdate', (before, after) => {
    if (before.partial || before.content === after.content || after.author.bot || !after.inGuild()) return
    handleInbound(after, true).catch(failure('handleInbound'))
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
