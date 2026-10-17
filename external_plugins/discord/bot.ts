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
  StringSelectMenuBuilder,
  ApplicationCommandOptionType,
  ApplicationIntegrationType,
  InteractionContextType,
  DiscordjsErrorCodes,
  Routes,
  parseEmoji,
  type Message as DiscordMessage,
  type PartialMessage,
  type MessageReaction,
  type PartialMessageReaction,
  type User,
  type PartialUser,
  type ButtonInteraction,
  type StringSelectMenuInteraction,
  type ChatInputCommandInteraction,
  type ChatInputApplicationCommandData,
  type PollAnswer,
  type PartialPollAnswer,
  type ActionRow,
  type ButtonComponent,
  type StringSelectMenuComponent,
  type RESTGetAPIGuildMessagesSearchResult,
  type Attachment,
  type Collection,
  type Channel,
  type NewsChannel,
  type ForumChannel,
  type TextChannel,
  type ThreadChannel,
  type DMChannel,
} from 'discord.js'
import { readFileSync, writeFileSync, mkdirSync, statSync, realpathSync, chmodSync } from 'fs'
import { homedir } from 'os'
import { basename, join, sep } from 'path'
import { startHub, clients, begin, move, preview, tappable, title, transcribe, MODELS, EFFORTS, type Message, type Permission } from '../../hub/hub.ts'
import { Ledger, type Ask, type MessageId } from '../../hub/ledger.ts'
import { server } from './channel.ts'
import { voiceCalls } from './voice.ts'

const STATE_DIR = process.env.DISCORD_STATE_DIR ?? join(homedir(), '.claude', 'channels', 'hex', 'discord')
const ACCESS_FILE = join(STATE_DIR, 'access.json')
const GUILD_FILE = join(STATE_DIR, 'guild.json')
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
const isForum = (ch: Channel | null | undefined): ch is ForumChannel => ch?.type === ChannelType.GuildForum
const isPostable = (ch: Channel | null | undefined): ch is TextChannel | NewsChannel | ForumChannel => isText(ch) || isForum(ch)

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

// A menu takes any number of picks at once, and stays showing them, disabled, once sent.
function menu(labels: string[], picked?: string[]): ActionRowBuilder<StringSelectMenuBuilder>[] {
  return [new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(new StringSelectMenuBuilder()
    .setCustomId('menu')
    .setPlaceholder(picked ? picked.join(', ').slice(0, 150) : 'Pick any')
    .setMinValues(1)
    .setMaxValues(labels.length)
    .setDisabled(picked !== undefined)
    .addOptions(labels.map((label, i) => ({ label, value: String(i), default: !!picked?.includes(label) }))))]
}

function choices(labels: string[], multiple: boolean) {
  return multiple ? menu(labels) : buttons(labels)
}

// One disabled button saying what became of a question: answered elsewhere, settled, or moot.
function only(text: string): ActionRowBuilder<ButtonBuilder>[] {
  return [new ActionRowBuilder<ButtonBuilder>().addComponents(new ButtonBuilder().setCustomId('done').setLabel(text.slice(0, 80)).setStyle(ButtonStyle.Secondary).setDisabled(true))]
}

const VERDICTS = [['allow', 'Allow', ButtonStyle.Success], ['deny', 'Deny', ButtonStyle.Danger]] as const

function verdicts(request: string, chosen?: string): ActionRowBuilder<ButtonBuilder>[] {
  return [new ActionRowBuilder<ButtonBuilder>().addComponents(VERDICTS.map(([verdict, label, style]) => new ButtonBuilder()
    .setCustomId(`perm:${verdict}:${request}`)
    .setLabel(label)
    .setStyle(chosen && chosen !== verdict ? ButtonStyle.Secondary : style)
    .setDisabled(chosen !== undefined)))]
}

// A fence inside the preview would close the block early, so its backticks are split.
function block(text: string, limit: number): string {
  const body = text.replaceAll('```', '`​``')
  return '```\n' + (body.length > limit ? `${body.slice(0, limit - 1)}…` : body) + '\n```'
}

const COMMANDS: ChatInputApplicationCommandData[] = [
  {
    name: 'model',
    description: "Switch this thread's model; its next message starts with it",
    options: [{ type: ApplicationCommandOptionType.String as const, name: 'model', description: 'Model', required: true, choices: MODELS.map(({ value, name }) => ({ name, value })) }],
  },
  {
    name: 'effort',
    description: "Set this thread's effort; its next message starts with it",
    options: [{ type: ApplicationCommandOptionType.String as const, name: 'effort', description: 'Effort', required: true, choices: EFFORTS.map(({ value, name }) => ({ name, value })) }],
  },
  { name: 'compact', description: "Compact this thread's conversation to free up context" },
  { name: 'stop', description: "Stop this thread's session; its next message resumes it" },
].map(command => ({ ...command, contexts: [InteractionContextType.Guild, InteractionContextType.BotDM], integrationTypes: [ApplicationIntegrationType.GuildInstall] }))

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

// Transcribed on arrival, so the words are the message itself and land in the conversation's log.
async function hear(att: Attachment | undefined): Promise<string | undefined> {
  if (!att) return
  try {
    return await transcribe(() => downloadAttachment(att))
  } catch (err) {
    process.stderr.write(`discord hub: voice transcription failed: ${err}\n`)
  }
}

// Images are fetched on arrival, as Telegram's photos are, so a screenshot is one Read away.
async function images(attachments: Collection<string, Attachment>): Promise<string[]> {
  const shown = attachments.filter(att => att.contentType?.startsWith('image/') && att.size <= MAX_ATTACHMENT_BYTES)
  const paths = await Promise.all(shown.map(att => downloadAttachment(att).catch(err => void process.stderr.write(`discord hub: image download failed: ${err}\n`))))
  return paths.filter((path): path is string => !!path)
}

function serve(token: string) {
  const client = new Client({
    intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.GuildMessageReactions, GatewayIntentBits.GuildMessagePolls, GatewayIntentBits.GuildVoiceStates, GatewayIntentBits.MessageContent, GatewayIntentBits.DirectMessages, GatewayIntentBits.DirectMessageReactions, GatewayIntentBits.DirectMessagePolls],
    partials: [Partials.Channel, Partials.Message, Partials.Reaction, Partials.User, Partials.Poll, Partials.PollAnswer],
  })
  const ledger = new Ledger(join(STATE_DIR, 'ledger.json'))

  // A session talks in a thread, or in a DM, which is one conversation.
  async function threadChannel(thread: string): Promise<ThreadChannel | DMChannel> {
    const ch = await client.channels.fetch(thread)
    if (!ch?.isThread() && !ch?.isDMBased()) throw new Error(`${thread} is not a Discord thread or DM`)
    return ch as ThreadChannel | DMChannel
  }

  const nameOf = (ch: ThreadChannel | DMChannel) => ch.isThread() ? ch.name : 'DM'

  function inThread(ch: ThreadChannel | DMChannel): ThreadChannel {
    if (!ch.isThread()) throw new Error('a DM is not a thread')
    return ch
  }

  function guild() {
    const guild = client.guilds.cache.first()
    if (!guild) throw new Error('the bot is in no Discord server')
    return guild
  }

  async function textChannel(name?: string): Promise<TextChannel | NewsChannel>
  async function textChannel(name: string | undefined, forums: true): Promise<TextChannel | NewsChannel | ForumChannel>
  async function textChannel(name?: string, forums = false): Promise<TextChannel | NewsChannel | ForumChannel> {
    const fits = forums ? isPostable : isText
    const g = guild()
    const wanted = name?.replace(/^#/, '').toLowerCase()
    const found = wanted
      ? (await g.channels.fetch()).find(ch => fits(ch) && (ch.id === wanted || ch.name.toLowerCase() === wanted))
      : g.systemChannel
    if (!fits(found)) throw new Error(wanted ? `no ${forums ? 'text or forum' : 'text'} channel named #${wanted}` : 'name a channel to open the thread in')
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
    const channel = !named && args.channel ? await textChannel(args.channel as string, true) : undefined
    if (isForum(channel)) return posts(channel, limit)
    const id = named ? (/^\d+$/.test(named) ? named : hub.find(named)) : channel ? channel.id : caller
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

  // A forum's posts are its threads: each one's title, newest activity last, read by its id.
  async function posts(forum: ForumChannel, limit: number): Promise<string> {
    if (!forum.permissionsFor(client.user!)?.has(READ)) throw new Error(`the bot can't read ${forum.id}; list_channels shows the channels it can`)
    const [active, archived] = await Promise.all([forum.threads.fetchActive(), forum.threads.fetchArchived({ limit })])
    const all = [...active.threads.values(), ...archived.threads.values()].filter(post => post.parentId === forum.id)
    const latest = (post: ThreadChannel) => SnowflakeUtil.timestampFrom(post.lastMessageId ?? post.id)
    const rows = all.sort((a, b) => latest(a) - latest(b)).slice(-limit).map(post =>
      `[${new Date(latest(post)).toISOString()}] ${post.name.replace(/[\r\n]+/g, ' ')}  (post ${post.id}, ${post.messageCount ?? 0} replies${post.archived ? ', archived' : ''})`)
    return rows.join('\n') || '(no posts)'
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
    const found = (await guild().channels.fetch()).filter(ch => isPostable(ch) && !!ch.permissionsFor(client.user!)?.has(READ))
    return found.map(ch => `#${ch!.name}  (id: ${ch!.id}${isForum(ch) ? ', forum' : ''})`).join('\n') || '(none)'
  }

  const link = (thread: string) => `https://discord.com/channels/${guild().id}/${thread}`

  // A forum takes a thread only as a post, which opens with a message: the about line, or its title.
  async function place(name: string, where?: string, about?: string, tags: string[] = []) {
    const parent = await textChannel(where, true)
    if (!isForum(parent)) {
      const thread = await parent.threads.create({ name })
      if (about) await thread.send(about)
      return { thread: thread.id, link: link(thread.id) }
    }
    const wanted = tags.map(tag => tag.toLowerCase())
    const applied = parent.availableTags.filter(tag => wanted.includes(tag.name.toLowerCase()))
    if (applied.length < wanted.length) throw new Error(`#${parent.name} has the tags ${parent.availableTags.map(tag => tag.name).join(', ') || '(none)'}`)
    const post = await parent.threads.create({ name, message: { content: about ?? name }, appliedTags: applied.map(tag => tag.id) })
    return { thread: post.id, link: link(post.id) }
  }

  // A new thread opens with the request that asked for it and what the session said since, when a
  // message from the user started the caller's current turn. A thread's first message is its starter.
  async function origin(from: string, to: string) {
    if (!typing.has(from)) return
    const ch = await threadChannel(from)
    const recent = [...(await ch.messages.fetch({ limit: 50 })).values()].reverse()
    const asked = recent.findLastIndex(m => !m.author.bot)
    if (asked < 0) return
    const picked = recent.slice(asked).filter((m, i) => i === 0 || m.author.id === client.user!.id)
    if (picked[0]!.type === MessageType.ThreadStarterMessage && ch.isThread()) picked[0] = (await ch.fetchStarterMessage())!
    for (const m of picked) await m.forward(to)
  }

  // A thread's starter message lives in the channel it hangs off, under the thread's own id.
  async function message(ch: ThreadChannel | DMChannel, id: string): Promise<DiscordMessage> {
    const msg = ch.isThread() && id === ch.id ? await ch.fetchStarterMessage() : await ch.messages.fetch(id)
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

  // Claude Code sends no event when a prompt is answered in the session itself, but a
  // turn can't end while one is open, so whatever is still asking by then is moot.
  const asking = new Map<string, Set<string>>()

  async function ask(thread: string, request: Permission): Promise<void> {
    const ch = await threadChannel(thread)
    const shown = preview(request)
    const sent = await ch.send({
      content: `🔐 **${request.tool_name}**: ${request.description.slice(0, 300)}${shown ? `\n${block(shown, 1500)}` : ''}`,
      components: verdicts(request.request_id),
    })
    asking.set(thread, (asking.get(thread) ?? new Set()).add(sent.id))
  }

  function settle(thread: string, busy: boolean): void {
    showTyping(thread, busy)
    if (busy) return
    for (const id of asking.get(thread) ?? []) void threadChannel(thread).then(ch => ch.messages.edit(id, { components: only('No longer waiting') })).catch(() => {})
    asking.delete(thread)
  }

  // A question answered somewhere else (hex's voice app, a call) reaches the thread as the owner's
  // own tap would, and its buttons say where it was answered. A poll can't take a vote from the bot,
  // so one answered elsewhere ends instead.
  const ANSWERED_IN: Record<string, string> = { app: 'in the app', call: 'on a call' }

  async function closeAsk(thread: string, ask: Ask, text: string) {
    const ch = await threadChannel(thread)
    const msg = await ch.messages.fetch(String(ask.message))
    await (ask.poll ? msg.poll!.end() : msg.edit({ components: only(text) }))
  }

  async function answerAsk(thread: string, message: MessageId, label: string, via: string) {
    const ask = ledger.find(thread, message)
    if (!ask || ask.answer) return
    await closeAsk(thread, ask, `✓ Answered ${ANSWERED_IN[via] ?? via}: ${label}`).catch(err => process.stderr.write(`discord hub: couldn't close the buttons on ${thread} ${message}: ${err}\n`))
    ledger.answered(thread, message, label, via)
    hub.deliver(thread, hub.name(thread) ?? thread, {
      content: ask.poll ? `(vote: ${label})` : label,
      meta: {
        chat_id: thread,
        user: `hex ${via}`,
        ts: new Date().toISOString(),
        ...(ask.poll ? { vote: label, poll_message_id: String(message), poll: ask.text } : { button: 'true', button_message_id: String(message) }),
        answered_in: ANSWERED_IN[via] ?? via,
      },
    })
  }

  async function settleAsk(thread: string, message: MessageId, note: string) {
    const ask = ledger.find(thread, message)
    if (!ask || ask.answer || ask.settled) return
    await closeAsk(thread, ask, note).catch(err => process.stderr.write(`discord hub: couldn't close the buttons on ${thread} ${message}: ${err}\n`))
    ledger.settled(thread, message, note)
  }

  // Takes back an answer given elsewhere, or a settle: the buttons come back, and the thread hears
  // that the answer it got no longer stands. An ended poll stays ended.
  async function reopenAsk(thread: string, message: MessageId, via: string) {
    const ask = ledger.find(thread, message)
    if (!ask || !(ask.answer || ask.settled)) return
    if (!ask.poll) await threadChannel(thread).then(ch => ch.messages.edit(String(message), { components: choices(ask.options, !!ask.multiple) })).catch(err => process.stderr.write(`discord hub: couldn't put the buttons back on ${thread} ${message}: ${err}\n`))
    const taken = ask.answer?.label
    ledger.reopened(thread, message)
    if (!taken) return
    hub.deliver(thread, hub.name(thread) ?? thread, {
      content: `(took back: ${taken})`,
      meta: { chat_id: thread, user: `hex ${via}`, ts: new Date().toISOString(), took_back: taken, [ask.poll ? 'poll_message_id' : 'button_message_id']: String(message) },
    })
  }

  async function call(caller: string, tool: string, args: Record<string, unknown>): Promise<string> {
    if (tool === 'new_thread') {
      const name = title(args.title as string)
      const app = (args.app as string | undefined) ?? 'discord'
      const about = args.about as string | undefined
      const where = args.channel as string | undefined
      if (app !== 'discord') return `started thread "${name}" in ${app}: ${(await begin(app, name, args.prompt as string, { about, where })).link}`
      const here = await threadChannel(caller)
      const parent = where ?? (here.isThread() ? here.parent?.name : undefined)
      const { thread, link } = await place(name, parent, about, args.tags as string[] | undefined)
      await origin(caller, thread).catch(err => process.stderr.write(`discord hub: couldn't forward where "${name}" came from: ${err}\n`))
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
        const text = tappable(args.text as string)
        const reply_to = args.reply_to as string | undefined
        const files = sendable((args.files as string[] | undefined) ?? [])
        const labels = args.buttons as string[] | undefined
        const multiple = !!args.multiple
        const components = labels?.length ? choices(labels, multiple) : undefined

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
        if (labels?.length) ledger.ask(thread, sentIds.at(-1)!, text, labels, undefined, multiple)

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
          ...(args.text !== undefined ? { content: tappable(args.text as string) } : {}),
          ...(files ? { files, attachments: [] } : {}),
        })
        if (args.text !== undefined) ledger.edited(thread, edited.id, args.text as string)
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
        ledger.deleted(thread, msg.id)
        return 'deleted'
      }
      case 'pin': {
        const msg = await message(ch, args.message_id as string)
        await (args.unpin ? msg.unpin() : msg.pin())
        if (args.unpin) ledger.unpinned(thread, msg.id)
        else ledger.pinned(thread, msg.id, msg.content)
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
        ledger.ask(thread, sent.id, args.question as string, args.options as string[], sent.id)
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
        await inThread(ch).setName(name)
        hub.rename(thread, name)
        return `renamed to "${name}"`
      }
      case 'close_thread': {
        const closing = inThread(ch)
        hub.retire(thread)
        await closing.setArchived(true)
        return `archived "${closing.name}"; its session stops once it's idle`
      }
      case 'handoff': {
        const to = args.to as string
        const name = args.title ? title(args.title as string) : nameOf(ch)
        const target = await move(hub, thread, to, name, args.channel as string | undefined)
        await ch.send(`Moved to ${to}: ${target}`)
        if (ch.isThread()) await ch.setArchived(true)
        return `moving to ${to}: ${target}. Your session stops here once this turn ends and resumes there.`
      }
      default:
        throw new Error(`unknown tool: ${tool}`)
    }
  }

  const dms = new Set<string>()
  const hub = startHub({
    stateDir: STATE_DIR,
    channel: 'plugin:discord@hex',
    server,
    call,
    state: settle,
    fresh: thread => dms.has(thread),
    failed: (thread, reason) => {
      void threadChannel(thread).then(ch => ch.send(`Couldn't start this thread's session: ${reason}`)).catch(() => {})
    },
    permission: (thread, request) => void ask(thread, request).catch(err => process.stderr.write(`discord hub: couldn't relay a permission prompt to ${thread}: ${err}\n`)),
    asks: {
      answer: (thread, message, label, via) => void answerAsk(thread, message, label, via),
      settle: (thread, message, note) => void settleAsk(thread, message, note),
      reopen: (thread, message, via) => void reopenAsk(thread, message, via),
    },
    hexDir: process.env.HEX_DIR,
    launcher: process.env.HEX_LAUNCHER,
  })

  clients.set('discord', { hub, place: (name, where, about) => place(name, where, about) })

  const allowed = (user: string) => loadAccess().allowFrom.includes(user)
  voiceCalls(client, allowed)

  // A tag in a channel starts a thread on that message, Claude-tag style;
  // inside a thread every message reaches its session without one.
  async function threadOf(msg: DiscordMessage): Promise<ThreadChannel | DMChannel | undefined> {
    if (msg.channel.isDMBased()) dms.add(msg.channelId)
    if (msg.channel.isThread() || msg.channel.isDMBased()) return msg.channel as ThreadChannel | DMChannel
    if (!isText(msg.channel) || !client.user || !msg.mentions.has(client.user)) return
    if (msg.thread) return msg.thread
    const words = msg.content.replace(/<@[!&]?\d+>/g, '').trim().split(/\s+/).filter(Boolean)
    return msg.startThread({ name: words[0] ?? 'Thread' })
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
    const forum = ch.isThread() && !!ch.parent?.isThreadOnly()
    if (ch.isThread() && ch.archived) await ch.setArchived(false).catch(() => {})

    void ch.sendTyping().catch(() => {})
    if (access.ackReaction) void msg.react(access.ackReaction).catch(() => {})

    // Attachments are listed (name/type/size) and only images are downloaded: the model
    // calls download_attachment for the rest. The listing goes in meta only, since an
    // in-content annotation is forgeable by the sender.
    const forwarded = msg.messageSnapshots.first()
    const source = forwarded ?? msg
    const atts = listed(source.attachments)
    const stickers = source.stickers.map(s => `${s.name} (${s.url})`)
    const poll = msg.poll
    const voiced = source.flags.has(MessageFlags.IsVoiceMessage)
    const heard = voiced ? await hear(source.attachments.first()) : undefined
    const shots = edited || voiced ? [] : await images(source.attachments)

    const message: Message = {
      content: heard ? `(voice message) ${heard}` : source.content.replace(/<@[!&]?\d+>/g, '').trim() || (atts.length > 0 ? '(attachment)' : stickers.length > 0 ? '(sticker)' : poll ? '(poll)' : ''),
      meta: {
        chat_id: ch.id,
        message_id: msg.id,
        user: msg.author.username,
        user_id: msg.author.id,
        ts: msg.createdAt.toISOString(),
        ...(ch.isThread() && ch.parent ? { channel: ch.parent.name } : {}),
        ...(opened && !forum ? { new_thread: 'true' } : {}),
        ...(opened && forum ? { post_title: nameOf(ch) } : {}),
        ...(shots.length > 0 ? { image_path: shots.join('; ') } : {}),
        ...(atts.length > 0 ? { attachment_count: String(atts.length), attachments: atts.join('; ') } : {}),
        ...(stickers.length > 0 ? { stickers: stickers.join('; ') } : {}),
        ...(poll ? { poll: poll.question.text!, poll_options: poll.answers.map(a => a.text).join('; '), ...(poll.allowMultiselect ? { poll_multiple: 'true' } : {}) } : {}),
        ...(await replyMeta(msg)),
        ...(edited ? { edited: 'true' } : {}),
        ...(forwarded ? { forwarded: 'true' } : {}),
      },
    }
    hub.deliver(ch.id, nameOf(ch), message)
  }

  // Reactions and deletes reach only a thread the hub already serves: in it,
  // or on the message it hangs off, which shares the thread's id.
  async function servedThread(msg: DiscordMessage | PartialMessage): Promise<ThreadChannel | DMChannel | undefined> {
    const id = msg.channel.isThread() || msg.channel.isDMBased() ? msg.channelId : msg.id
    return hub.name(id) ? threadChannel(id) : undefined
  }

  async function handleReaction(reaction: MessageReaction | PartialMessageReaction, user: User | PartialUser, removed: boolean): Promise<void> {
    if (!allowed(user.id)) return
    const ch = await servedThread(reaction.message)
    if (!ch) return
    const target = reaction.message.partial ? await reaction.message.fetch().catch(() => undefined) : reaction.message
    const who = user.partial ? await user.fetch() : user
    const emoji = reaction.emoji.toString()
    hub.deliver(ch.id, nameOf(ch), {
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
    ledger.deleted(ch.id, msg.id)
    hub.deliver(ch.id, nameOf(ch), {
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
    if (!allowed(userId)) return
    const ch = await servedThread(answer.poll.message)
    if (!ch) return
    const msg = answer.poll.message.partial ? await answer.poll.message.fetch() : answer.poll.message
    if (msg.author.id !== client.user!.id || !msg.poll) return
    const vote = msg.poll.answers.get(answer.id)?.text ?? ''
    const who = await client.users.fetch(userId)
    if (!removed) ledger.answered(ch.id, msg.id, vote, 'discord')
    else if (ledger.find(ch.id, msg.id)?.answer?.label === vote) ledger.reopened(ch.id, msg.id)
    hub.deliver(ch.id, nameOf(ch), {
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

  function picked(ch: ThreadChannel | DMChannel, label: string, at: Date, user: { id: string; username: string }, message: string) {
    ledger.answered(ch.id, message, label, 'discord')
    hub.deliver(ch.id, nameOf(ch), {
      content: label,
      meta: {
        chat_id: ch.id,
        user: user.username,
        user_id: user.id,
        ts: at.toISOString(),
        button: 'true',
        button_message_id: message,
      },
    })
  }

  async function handleTap(tap: ButtonInteraction): Promise<void> {
    if (!allowed(tap.user.id)) return void (await tap.deferUpdate())
    const ch = await threadChannel(tap.channelId)
    const verdict = tap.customId.match(/^perm:(allow|deny):(\w+)$/)
    if (verdict) {
      await tap.update({ components: verdicts(verdict[2]!, verdict[1]) })
      asking.get(ch.id)?.delete(tap.message.id)
      return hub.answer(ch.id, verdict[2]!, verdict[1] as 'allow' | 'deny')
    }
    const labels = (tap.message.components as ActionRow<ButtonComponent>[]).flatMap(row => row.components.map(button => button.label!))
    const chosen = Number(tap.customId)
    await tap.update({ components: buttons(labels, chosen) })
    picked(ch, labels[chosen]!, tap.createdAt, tap.user, tap.message.id)
  }

  async function handleMenu(pick: StringSelectMenuInteraction): Promise<void> {
    if (!allowed(pick.user.id)) return void (await pick.deferUpdate())
    const labels = (pick.component as StringSelectMenuComponent).options.map(option => option.label)
    const chosen = pick.values.map(value => labels[Number(value)]!)
    await pick.update({ components: menu(labels, chosen) })
    picked(await threadChannel(pick.channelId), chosen.join('; '), pick.createdAt, pick.user, pick.message.id)
  }

  // A thread's own controls, outside its conversation: its session never sees them.
  async function handleCommand(command: ChatInputCommandInteraction): Promise<void> {
    const answer = (content: string) => command.reply({ content, flags: MessageFlags.Ephemeral })
    if (!allowed(command.user.id)) return void (await answer('hex only answers its owner.'))
    const thread = command.channelId
    if (!hub.name(thread)) return void (await answer('This channel has no session: use it in one of hex\'s threads or the DM.'))
    switch (command.commandName) {
      case 'model':
      case 'effort': {
        const value = command.options.getString(command.commandName, true)
        hub.configure(thread, { [command.commandName]: value })
        const name = [...MODELS, ...EFFORTS].find(choice => choice.value === value)?.name ?? value
        return void (await answer(`${command.commandName === 'model' ? 'Model' : 'Effort'}: ${name}, from this thread's next message.`))
      }
      case 'compact':
        if (!hub.session(thread)) return void (await answer('This thread has nothing to compact yet.'))
        void hub.command(thread, '/compact')
        return void (await answer('Compacting this thread.'))
      case 'stop':
        hub.stop(thread)
        return void (await answer('Stopped. The next message resumes it.'))
    }
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
    else if (interaction.isStringSelectMenu()) handleMenu(interaction).catch(failure('handleMenu'))
    else if (interaction.isChatInputCommand()) handleCommand(interaction).catch(failure('handleCommand'))
  })

  client.on('messageCreate', msg => {
    if (msg.author.bot) return
    handleInbound(msg).catch(failure('handleInbound'))
  })

  client.on('messageUpdate', (before, after) => {
    if (before.partial || before.content === after.content || after.author.bot) return
    handleInbound(after, true).catch(failure('handleInbound'))
  })

  client.on('threadUpdate', (before, after) => {
    if (before.name !== after.name) hub.rename(after.id, after.name)
  })

  client.on('threadDelete', thread => {
    process.stderr.write(`discord hub: thread ${thread.id} was deleted, forgetting it\n`)
    ledger.forget(thread.id)
    void hub.retire(thread.id)
  })

  client.on('error', err => {
    process.stderr.write(`discord hub: client error: ${err}\n`)
  })

  client.once('clientReady', c => {
    process.stderr.write(`discord hub: gateway connected as ${c.user.tag}\n`)
    const id = client.guilds.cache.first()?.id
    if (id) writeFileSync(GUILD_FILE, JSON.stringify({ id }) + '\n')
    void c.application?.commands.set(COMMANDS).catch(failure('registering slash commands'))
  })

  // discord.js reconnects a session it has, but not a first login that fails, as when the
  // network isn't up yet at boot. Only a bad token is final.
  async function login(attempt = 1): Promise<void> {
    try {
      await client.login(token)
    } catch (err) {
      if ((err as { code?: string }).code === DiscordjsErrorCodes.TokenInvalid) return void process.stderr.write(`discord hub: login failed: ${err}\n`)
      const delay = Math.min(1000 * 2 ** (attempt - 1), 60_000)
      process.stderr.write(`discord hub: login failed: ${err}, retrying in ${delay / 1000}s\n`)
      setTimeout(login, delay, attempt + 1)
    }
  }
  void login()
}
