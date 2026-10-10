#!/usr/bin/env bun
import { Bot, GrammyError, InputFile, type Context } from 'grammy'
import type { Chat, MessageEntity, MessageOrigin, ReactionTypeEmoji } from 'grammy/types'
import { readFileSync, writeFileSync, mkdirSync, statSync, realpathSync, chmodSync } from 'fs'
import { homedir } from 'os'
import { basename, join, extname, sep } from 'path'
import { startHub, clients, move, title, type Message } from '../../hub/hub.ts'

const STATE_DIR = process.env.TELEGRAM_STATE_DIR ?? join(homedir(), '.claude', 'channels', 'hex', 'telegram')
const ACCESS_FILE = join(STATE_DIR, 'access.json')
const ENV_FILE = join(STATE_DIR, '.env')
const INBOX_DIR = join(STATE_DIR, 'inbox')
const MAIN = process.env.HEX_MAIN_THREAD

try {
  chmodSync(ENV_FILE, 0o600)
  for (const line of readFileSync(ENV_FILE, 'utf8').split('\n')) {
    const m = line.match(/^(\w+)=(.*)$/)
    if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2]
  }
} catch {}

const TOKEN = process.env.TELEGRAM_BOT_TOKEN
if (!TOKEN) {
  process.stderr.write(`telegram hub: TELEGRAM_BOT_TOKEN required in ${ENV_FILE}\n`)
  process.exit(1)
}

process.on('unhandledRejection', err => {
  process.stderr.write(`telegram hub: unhandled rejection: ${err}\n`)
})
process.on('uncaughtException', err => {
  process.stderr.write(`telegram hub: uncaught exception: ${err}\n`)
})

const bot = new Bot(TOKEN)

type Access = {
  allowFrom: string[]
  /** Emoji to react with on receipt. Empty string disables. Telegram only accepts its fixed whitelist. */
  ackReaction?: string
  /** Which chunks get Telegram's reply reference when reply_to is passed. Default: 'first'. 'off' = never thread. */
  replyToMode?: 'off' | 'first' | 'all'
  /** Max chars per outbound message before splitting. Default: Telegram's hard cap, 4096 (32768 for format 'markdown'). */
  textChunkLimit?: number
  /** Split on paragraph boundaries instead of hard char count. */
  chunkMode?: 'length' | 'newline'
}

function loadAccess(): Access {
  try {
    return { allowFrom: [], ...JSON.parse(readFileSync(ACCESS_FILE, 'utf8')) }
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') process.stderr.write(`telegram hub: ${ACCESS_FILE} is unreadable, so every sender is dropped: ${err}\n`)
    return { allowFrom: [] }
  }
}

const MAX_CHUNK_LIMIT = 4096
const MAX_RICH_LIMIT = 32768
const MAX_CAPTION = 1024
const MAX_PHOTO_BYTES = 10 * 1024 * 1024
const MAX_ATTACHMENT_BYTES = 50 * 1024 * 1024
const ALBUM_WAIT = 1000

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

// .jpg/.jpeg/.png/.gif/.webp go as photos (Telegram compresses + shows inline);
// everything else, and photos over Telegram's 10MB photo cap, go as documents.
const PHOTO_EXTS = new Set(['.jpg', '.jpeg', '.png', '.gif', '.webp'])

function asPhoto(f: string): boolean {
  assertSendable(f)
  const { size } = statSync(f)
  if (size > MAX_ATTACHMENT_BYTES) throw new Error(`file too large: ${f} (${(size / 1024 / 1024).toFixed(1)}MB, max 50MB)`)
  return PHOTO_EXTS.has(extname(f).toLowerCase()) && size <= MAX_PHOTO_BYTES
}

function threadOf(ctx: Context): string {
  const chat = String(ctx.chat!.id)
  return ctx.msg?.is_topic_message ? `${chat}:${ctx.msg.message_thread_id}` : chat
}

function target(thread: string) {
  const [chat_id, topic] = thread.split(':')
  return { chat_id: chat_id!, extra: topic ? { message_thread_id: Number(topic) } : {} }
}

const topicNames = new Map<string, string>()

// Telegram's reaction updates carry neither the message's text nor its topic,
// so the hub keeps both for every message it sends or receives, per thread,
// until the thread is forgotten.
type Seen = { text?: string; user: string; poll?: { id: string; options: string[] } }
const seen = new Map<string, Map<number, Seen>>()

function remember(thread: string, id: number, entry: Seen): void {
  if (!seen.has(thread)) seen.set(thread, new Map())
  seen.get(thread)!.set(id, entry)
}

function recall(chat: string, id: number): [string, Seen] | undefined {
  for (const [thread, messages] of seen) {
    if (target(thread).chat_id === chat && messages.has(id)) return [thread, messages.get(id)!]
  }
}

function me(): string {
  return bot.botInfo.username
}

function retire(thread: string): Promise<string> {
  return hub.retire(thread).then(session => {
    seen.delete(thread)
    return session
  })
}

function nameOf(ctx: Context, thread: string): string {
  const created = ctx.msg?.reply_to_message?.forum_topic_created
  if (created) topicNames.set(thread, created.name)
  return topicNames.get(thread) ?? (thread.includes(':') ? `topic ${thread.split(':')[1]}` : ctx.chat?.type === 'private' ? 'DM' : 'main')
}

async function download(file_id: string, uniqueId: string): Promise<string> {
  const file = await bot.api.getFile(file_id)
  if (!file.file_path) throw new Error('Telegram returned no file_path — file may have expired')
  const res = await fetch(`https://api.telegram.org/file/bot${TOKEN}/${file.file_path}`)
  if (!res.ok) throw new Error(`download failed: HTTP ${res.status}`)
  const rawExt = file.file_path.includes('.') ? file.file_path.split('.').pop()! : 'bin'
  const ext = rawExt.replace(/[^a-zA-Z0-9]/g, '') || 'bin'
  const id = uniqueId.replace(/[^a-zA-Z0-9_-]/g, '') || 'dl'
  const path = join(INBOX_DIR, `${Date.now()}-${id}.${ext}`)
  mkdirSync(INBOX_DIR, { recursive: true })
  writeFileSync(path, Buffer.from(await res.arrayBuffer()))
  return path
}

const typing = new Map<string, ReturnType<typeof setInterval>>()
const forums = new Map<string, Promise<boolean>>()

// In a forum, General is topic 1: chat actions need that id to show inside it,
// while messages sent with it fail ("message thread not found").
async function typingTarget(thread: string) {
  const { chat_id, extra } = target(thread)
  if (thread.includes(':')) return { chat_id, extra }
  if (!forums.has(chat_id)) forums.set(chat_id, bot.api.getChat(chat_id).then(chat => 'is_forum' in chat && !!chat.is_forum, () => false))
  return { chat_id, extra: (await forums.get(chat_id)) ? { message_thread_id: 1 } : {} }
}

function sendTyping(thread: string): void {
  void typingTarget(thread).then(({ chat_id, extra }) => bot.api.sendChatAction(chat_id, 'typing', extra)).catch(() => {})
}

// Telegram shows "typing…" for about 5 seconds per chat action, so it is
// re-sent for as long as the thread's session is busy.
function showTyping(thread: string, busy: boolean): void {
  process.stderr.write(`telegram hub: ${thread} ${busy ? 'busy' : 'idle'}\n`)
  clearInterval(typing.get(thread))
  typing.delete(thread)
  if (!busy) return
  sendTyping(thread)
  typing.set(thread, setInterval(() => sendTyping(thread), 4000))
}

async function icons() {
  const stickers = await bot.api.getForumTopicIconStickers()
  return stickers.filter(sticker => sticker.custom_emoji_id && sticker.emoji)
}

async function iconOf(emoji: string): Promise<string> {
  const all = await icons()
  const plain = (e: string) => e.replace(/\uFE0F/g, '')
  const icon = all.find(sticker => plain(sticker.emoji!) === plain(emoji.trim()))
  if (!icon) throw new Error(`Telegram has no topic icon ${emoji}; pick one of ${all.map(sticker => sticker.emoji).join(' ')}`)
  return icon.custom_emoji_id!
}

async function place(name: string) {
  if (!MAIN) throw new Error('topics need HEX_MAIN_THREAD, the group they open in')
  const { chat_id } = target(MAIN)
  const icon = await icons().then(all => all[Math.floor(Math.random() * all.length)]?.custom_emoji_id, () => undefined)
  const topic = await bot.api.createForumTopic(chat_id, name, icon ? { icon_custom_emoji_id: icon } : {})
  const thread = `${chat_id}:${topic.message_thread_id}`
  topicNames.set(thread, name)
  return { thread, link: `https://t.me/c/${chat_id.replace(/^-100/, '')}/${topic.message_thread_id}` }
}

// A new topic opens with the request that asked for it and what the session
// said since, when a message from the user started the caller's current turn.
async function origin(from: string, to: string): Promise<void> {
  if (!typing.has(from)) return
  const messages = [...(seen.get(from) ?? [])]
  const asked = messages.findLastIndex(([, message]) => message.user !== me())
  if (asked < 0) return
  const picked = messages.slice(asked).filter(([, message], i) => i === 0 || message.user === me())
  const { chat_id, extra } = target(to)
  const copies = await bot.api.forwardMessages(chat_id, target(from).chat_id, picked.map(([id]) => id), extra)
  copies.forEach((copy, i) => remember(to, copy.message_id, { text: picked[i]![1].text, user: me() }))
}

async function call(caller: string, tool: string, args: Record<string, unknown>): Promise<string> {
  const thread = args.thread ? hub.find(args.thread as string) : caller
  const { chat_id, extra } = target(thread)
  const access = loadAccess()
  switch (tool) {
    case 'reply': {
      const text = (args.text as string | undefined) ?? ''
      const reply_to = args.reply_to != null ? Number(args.reply_to) : undefined
      const files = (args.files as string[] | undefined) ?? []
      const buttons = (args.buttons as string[] | undefined) ?? []
      const markdown = args.format === 'markdown'
      const parseMode = args.format === 'markdownv2' ? { parse_mode: 'MarkdownV2' as const } : {}
      if (!text && !files.length) throw new Error('reply needs text or files')
      if (buttons.length && !text) throw new Error('buttons need text to go with them')

      const photos = files.map(asPhoto)
      const caption = files.length && !markdown && text.length <= MAX_CAPTION ? text : ''
      const cap = markdown ? MAX_RICH_LIMIT : MAX_CHUNK_LIMIT
      const limit = Math.max(1, Math.min(access.textChunkLimit ?? cap, cap))
      const replyMode = access.replyToMode ?? 'first'
      const chunks = !text || caption ? [] : markdown ? fenced(text, limit, access.chunkMode ?? 'length') : chunk(text, limit, access.chunkMode ?? 'length')
      const silent = args.silent ? { disable_notification: true } : {}
      const keyboard = buttons.length ? { reply_markup: { inline_keyboard: [buttons.map((label, i) => ({ text: label, callback_data: String(i) }))] } } : {}
      const sentIds: number[] = []

      try {
        for (let i = 0; i < chunks.length; i++) {
          const shouldReplyTo = reply_to != null && replyMode !== 'off' && (replyMode === 'all' || i === 0)
          const opts = {
            ...extra,
            ...(shouldReplyTo ? { reply_parameters: { message_id: reply_to } } : {}),
            ...silent,
            ...(i === chunks.length - 1 ? keyboard : {}),
          }
          const sent = markdown
            ? await bot.api.sendRichMessage(chat_id, { markdown: chunks[i]! }, opts)
            : await bot.api.sendMessage(chat_id, chunks[i]!, { ...opts, ...parseMode })
          remember(thread, sent.message_id, { text: chunks[i], user: me() })
          sentIds.push(sent.message_id)
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        throw new Error(`reply failed after ${sentIds.length} of ${chunks.length} chunk(s) sent: ${msg}`)
      }

      for (let i = 0; i < files.length; i++) {
        const input = new InputFile(files[i]!)
        const captioned = i === 0 && caption
        const opts = {
          ...extra,
          ...(reply_to != null && replyMode !== 'off' ? { reply_parameters: { message_id: reply_to } } : {}),
          ...silent,
          ...(captioned ? { caption, ...parseMode, ...keyboard } : {}),
        }
        const sent = photos[i]
          ? await bot.api.sendPhoto(chat_id, input, opts)
          : await bot.api.sendDocument(chat_id, input, opts)
        remember(thread, sent.message_id, { text: captioned ? caption : undefined, user: me() })
        sentIds.push(sent.message_id)
      }

      return sentIds.length === 1 ? `sent (id: ${sentIds[0]})` : `sent ${sentIds.length} parts (ids: ${sentIds.join(', ')})`
    }
    case 'react': {
      await bot.api.setMessageReaction(chat_id, Number(args.message_id), args.remove ? [] : [
        { type: 'emoji', emoji: args.emoji as ReactionTypeEmoji['emoji'] },
      ])
      return args.remove ? 'reaction removed' : 'reacted'
    }
    case 'edit_message': {
      const id = Number(args.message_id)
      const text = args.text as string | undefined
      const file = args.file as string | undefined
      const parseMode = args.format === 'markdownv2' ? { parse_mode: 'MarkdownV2' as const } : {}
      if (file) {
        const caption = text != null ? { caption: text, ...parseMode } : {}
        await bot.api.editMessageMedia(chat_id, id, { type: asPhoto(file) ? 'photo' : 'document', media: new InputFile(file), ...caption })
      } else {
        if (text == null) throw new Error('edit_message needs text or a file')
        const edit = args.format === 'markdown'
          ? bot.api.editMessageText(chat_id, id, { markdown: text })
          : bot.api.editMessageText(chat_id, id, text, parseMode)
        await edit.catch(err => {
          if (!/no text in the message/.test(String(err))) throw err
          if (args.format === 'markdown') throw new Error("a file's caption can't take format 'markdown'; use 'text' or 'markdownv2'")
          return bot.api.editMessageCaption(chat_id, id, { caption: text, ...parseMode })
        })
      }
      if (text != null) remember(thread, id, { text, user: me() })
      return `edited (id: ${id})`
    }
    case 'delete_message': {
      const id = Number(args.message_id)
      await bot.api.deleteMessage(chat_id, id)
      seen.get(thread)?.delete(id)
      return `deleted (id: ${id})`
    }
    case 'pin': {
      const id = Number(args.message_id)
      if (args.unpin) await bot.api.unpinChatMessage(chat_id, id)
      else await bot.api.pinChatMessage(chat_id, id)
      return `${args.unpin ? 'unpinned' : 'pinned'} (id: ${id})`
    }
    case 'forward': {
      const id = Number(args.message_id)
      const from = target(caller).chat_id
      const sent = await bot.api.forwardMessage(chat_id, from, id, extra)
      remember(thread, sent.message_id, { text: recall(from, id)?.[1].text, user: me() })
      return `forwarded to "${topicNames.get(thread) ?? hub.name(thread) ?? thread}" (id: ${sent.message_id})`
    }
    case 'poll': {
      const question = args.question as string
      const options = args.options as string[]
      const sent = await bot.api.sendPoll(chat_id, question, options, {
        ...extra,
        is_anonymous: false,
        allows_multiple_answers: !!args.multiple,
      })
      remember(thread, sent.message_id, { text: question, user: me(), poll: { id: sent.poll.id, options } })
      return `sent poll (id: ${sent.message_id})`
    }
    case 'rename_thread': {
      if (!extra.message_thread_id) throw new Error('only topics can be renamed')
      const name = args.title != null ? title(args.title as string) : undefined
      const icon = args.icon != null ? await iconOf(args.icon as string) : undefined
      if (!name && !icon) throw new Error('rename_thread needs a title or an icon')
      await bot.api.editForumTopic(chat_id, extra.message_thread_id, {
        ...(name ? { name } : {}),
        ...(icon ? { icon_custom_emoji_id: icon } : {}),
      })
      if (name) {
        topicNames.set(thread, name)
        hub.rename(thread, name)
      }
      return [name && `renamed to "${name}"`, icon && `icon set to ${args.icon}`].filter(Boolean).join(', ')
    }
    case 'download_attachment': {
      return download(args.file_id as string, args.file_id as string)
    }
    case 'close_thread': {
      if (!extra.message_thread_id) throw new Error('only topics can be closed')
      void retire(thread)
      await bot.api.closeForumTopic(chat_id, extra.message_thread_id).catch(err => {
        if (!gone(err)) throw err
      })
      return `closed "${topicNames.get(thread) ?? thread}"; its session stops once it's idle`
    }
    case 'new_thread': {
      const name = title(args.title as string)
      const app = (args.app as string | undefined) ?? 'telegram'
      const there = app === 'telegram' ? { hub, place } : clients.get(app)
      if (!there) throw new Error(`${app} isn't connected`)
      const opened = await there.place(name, args.channel as string | undefined)
      if (app === 'telegram') await origin(caller, opened.thread).catch(err => process.stderr.write(`telegram hub: couldn't forward where "${name}" came from: ${err}\n`))
      there.hub.open(opened.thread, name, args.prompt as string)
      return `started thread "${name}" in ${app}: ${opened.link}`
    }
    case 'handoff': {
      const to = args.to as string
      const name = args.title != null ? title(args.title as string) : topicNames.get(thread) ?? title('')
      const link = await move(hub, thread, to, name, args.channel as string | undefined)
      if (thread === MAIN) {
        await bot.api.sendMessage(chat_id, `Continued in ${to}: ${link}`, extra)
        return `a copy of this conversation continues in ${to}: ${link}. You stay here.`
      }
      seen.delete(thread)
      await bot.api.sendMessage(chat_id, `Moved to ${to}: ${link}`, extra)
      await bot.api.closeForumTopic(chat_id, extra.message_thread_id!)
      return `moving to ${to}: ${link}. Your session stops here once this turn ends and resumes there.`
    }
    default:
      throw new Error(`unknown tool: ${tool}`)
  }
}

function gone(err: unknown): boolean {
  return /message thread not found|TOPIC_ID_INVALID/.test(String(err))
}

// The Bot API has no event for a deleted topic; the first send into one is how it shows.
async function callOrForget(caller: string, tool: string, args: Record<string, unknown>): Promise<string> {
  try {
    return await call(caller, tool, args)
  } catch (err) {
    const thread = args.thread ? hub.find(args.thread as string) : caller
    if (thread === MAIN || !thread.includes(':') || !gone(err)) throw err
    process.stderr.write(`telegram hub: topic ${thread} was deleted, forgetting it\n`)
    void retire(thread)
    throw new Error(`this topic was deleted in Telegram, so it's gone from the thread list now`)
  }
}

const hub = startHub({
  stateDir: STATE_DIR,
  channel: 'plugin:telegram@hex',
  main: MAIN,
  hexDir: process.env.HEX_DIR,
  launcher: process.env.HEX_LAUNCHER,
  mainName: process.env.HEX_NAME,
  call: callOrForget,
  state: showTyping,
  failed: (thread, reason) => {
    const { chat_id, extra } = target(thread)
    void bot.api.sendMessage(chat_id, `Couldn't start this topic's session: ${reason}`, extra).catch(() => {})
  },
})

clients.set('telegram', { hub, place })

bot.on(['message:forum_topic_created', 'message:forum_topic_edited'], ctx => {
  const name = ctx.message.forum_topic_created?.name ?? ctx.message.forum_topic_edited?.name
  if (!name) return
  topicNames.set(threadOf(ctx), name)
  hub.rename(threadOf(ctx), name)
})

bot.on('message:text', async ctx => {
  await handleInbound(ctx, ctx.message.text, undefined)
})

bot.on('edited_message', async ctx => {
  const text = ctx.editedMessage.text ?? ctx.editedMessage.caption
  if (text) await handleInbound(ctx, text, undefined)
})

bot.on('message:location', async ctx => {
  const { location, venue } = ctx.message
  const at = `${location.latitude}, ${location.longitude}`
  await handleInbound(ctx, venue ? `(venue: ${venue.title}, ${venue.address}, at ${at})` : `(location: ${at})`, undefined)
})

bot.on('message:contact', async ctx => {
  const { first_name, last_name, phone_number } = ctx.message.contact
  await handleInbound(ctx, `(contact: ${[first_name, last_name].filter(Boolean).join(' ')}, ${phone_number})`, undefined)
})

bot.on('message:photo', async ctx => {
  const caption = ctx.message.caption ?? '(photo)'
  // Defer download until after the gate approves — any user can send photos,
  // and we don't want to burn API quota or fill the inbox for dropped messages.
  await handleInbound(ctx, caption, async () => {
    // Largest size is last in the array.
    const best = ctx.message.photo[ctx.message.photo.length - 1]!
    try {
      return await download(best.file_id, best.file_unique_id)
    } catch (err) {
      process.stderr.write(`telegram hub: photo download failed: ${err}\n`)
      return undefined
    }
  })
})

bot.on('message:document', async ctx => {
  const doc = ctx.message.document
  const name = safeName(doc.file_name)
  const text = ctx.message.caption ?? `(document: ${name ?? 'file'})`
  await handleInbound(ctx, text, undefined, {
    kind: 'document',
    file_id: doc.file_id,
    size: doc.file_size,
    mime: doc.mime_type,
    name,
  })
})

bot.on('message:voice', async ctx => {
  const voice = ctx.message.voice
  const text = ctx.message.caption ?? '(voice message)'
  await handleInbound(ctx, text, undefined, {
    kind: 'voice',
    file_id: voice.file_id,
    size: voice.file_size,
    mime: voice.mime_type,
  })
})

bot.on('message:audio', async ctx => {
  const audio = ctx.message.audio
  const name = safeName(audio.file_name)
  const text = ctx.message.caption ?? `(audio: ${safeName(audio.title) ?? name ?? 'audio'})`
  await handleInbound(ctx, text, undefined, {
    kind: 'audio',
    file_id: audio.file_id,
    size: audio.file_size,
    mime: audio.mime_type,
    name,
  })
})

bot.on('message:video', async ctx => {
  const video = ctx.message.video
  const text = ctx.message.caption ?? '(video)'
  await handleInbound(ctx, text, undefined, {
    kind: 'video',
    file_id: video.file_id,
    size: video.file_size,
    mime: video.mime_type,
    name: safeName(video.file_name),
  })
})

bot.on('message:video_note', async ctx => {
  const vn = ctx.message.video_note
  await handleInbound(ctx, '(video note)', undefined, {
    kind: 'video_note',
    file_id: vn.file_id,
    size: vn.file_size,
  })
})

bot.on('message:poll', async ctx => {
  const { question, options } = ctx.message.poll
  await handleInbound(ctx, `(poll: ${question} [${options.map(option => option.text).join(' / ')}])`, undefined)
})

bot.on('message:dice', async ctx => {
  const { emoji, value } = ctx.message.dice
  await handleInbound(ctx, `(dice ${emoji}: ${value})`, undefined)
})

bot.on('message:game', async ctx => {
  await handleInbound(ctx, `(game: ${ctx.message.game.title})`, undefined)
})

bot.on('message:sticker', async ctx => {
  const sticker = ctx.message.sticker
  const emoji = sticker.emoji ? ` ${sticker.emoji}` : ''
  await handleInbound(ctx, `(sticker${emoji})`, undefined, {
    kind: 'sticker',
    file_id: sticker.file_id,
    size: sticker.file_size,
  })
})

// Telegram only reports reactions to bots that are admins, and the update
// names neither the topic nor the text, so both come from what the hub has seen.
bot.on('message_reaction', ctx => {
  const { chat, message_id, user, date } = ctx.messageReaction
  if (!allowed(user)) return
  const known = recall(String(chat.id), message_id)
  const thread = known?.[0] ?? plainThread(chat)
  if (!thread) return
  const { emojiAdded, emojiRemoved } = ctx.reactions()
  const meta = {
    chat_id: String(chat.id),
    user: user.username ?? String(user.id),
    user_id: String(user.id),
    ts: new Date(date * 1000).toISOString(),
    reaction_to_message_id: String(message_id),
    ...(known ? { reaction_to_user: known[1].user } : {}),
    ...(known?.[1].text ? { reaction_to_text: known[1].text } : {}),
  }
  for (const emoji of emojiAdded) hub.deliver(thread, nameOf(ctx, thread), { content: `(reaction: ${emoji})`, meta: { ...meta, reaction: emoji } })
  for (const emoji of emojiRemoved) hub.deliver(thread, nameOf(ctx, thread), { content: `(reaction removed: ${emoji})`, meta: { ...meta, reaction: emoji, reaction_removed: 'true' } })
})

// Outside a forum a chat, a DM included, is one thread; a forum's topic is only
// known from messages the hub has seen.
function plainThread(chat: Chat): string | undefined {
  if (!('is_forum' in chat && chat.is_forum)) return String(chat.id)
}

bot.on('callback_query:data', async ctx => {
  await ctx.answerCallbackQuery().catch(() => {})
  const message = ctx.callbackQuery.message
  const label = message && 'reply_markup' in message ? message.reply_markup?.inline_keyboard.flat()[Number(ctx.callbackQuery.data)]?.text : undefined
  if (!message || !label || !allowed(ctx.from)) return
  await bot.api.editMessageReplyMarkup(message.chat.id, message.message_id, {
    reply_markup: { inline_keyboard: [[{ text: `✓ ${label}`, disabled: {} }]] },
  }).catch(err => process.stderr.write(`telegram hub: couldn't mark the tapped button: ${err}\n`))
  const thread = threadOf(ctx)
  hub.deliver(thread, nameOf(ctx, thread), {
    content: label,
    meta: {
      chat_id: String(message.chat.id),
      user: ctx.from.username ?? String(ctx.from.id),
      user_id: String(ctx.from.id),
      ts: new Date().toISOString(),
      button: 'true',
      button_message_id: String(message.message_id),
    },
  })
})

bot.on('poll_answer', ctx => {
  const { poll_id, user, option_ids } = ctx.pollAnswer
  if (!allowed(user)) return
  for (const [thread, messages] of seen) {
    for (const [id, message] of messages) {
      if (message.poll?.id !== poll_id) continue
      const vote = option_ids.map(i => message.poll!.options[i]).join('; ')
      hub.deliver(thread, nameOf(ctx, thread), {
        content: vote ? `(vote: ${vote})` : '(vote removed)',
        meta: {
          chat_id: target(thread).chat_id,
          user: user.username ?? String(user.id),
          user_id: String(user.id),
          ts: new Date().toISOString(),
          ...(vote ? { vote } : { vote_removed: 'true' }),
          poll_message_id: String(id),
          poll: message.text!,
        },
      })
    }
  }
})

function allowed<U extends { id: number }>(user: U | undefined): user is U {
  return !!user && loadAccess().allowFrom.includes(String(user.id))
}

type AttachmentMeta = {
  kind: string
  file_id: string
  size?: number
  mime?: string
  name?: string
}

// Filenames and titles are uploader-controlled. They land inside the <channel>
// notification — delimiter chars would let the uploader break out of the tag
// or forge a second meta entry.
function safeName(s: string | undefined): string | undefined {
  return s?.replace(/[<>\[\]\r\n;]/g, '_')
}

// A link's address lives in the message's entities, not in its text.
function linked(text: string, entities: MessageEntity[] = []): string {
  return entities.reduceRight((out, entity) => entity.type !== 'text_link' ? out
    : `${out.slice(0, entity.offset)}[${out.slice(entity.offset, entity.offset + entity.length)}](${entity.url})${out.slice(entity.offset + entity.length)}`, text)
}

function senderOf(origin: MessageOrigin): string {
  switch (origin.type) {
    case 'user': return origin.sender_user.username ?? [origin.sender_user.first_name, origin.sender_user.last_name].filter(Boolean).join(' ')
    case 'hidden_user': return origin.sender_user_name
    case 'chat': return origin.sender_chat.title ?? String(origin.sender_chat.id)
    case 'channel': return origin.chat.title
  }
}

const REPLY_FILE_KINDS = ['animation', 'document', 'video', 'audio', 'voice', 'video_note', 'sticker'] as const

// Inside a topic, every message that isn't a reply points at the topic's
// first message, the one that says the topic was created. A reply to a
// message in another topic or chat comes as external_reply instead, with no text.
async function replyMeta(msg: Context['msg']): Promise<Record<string, string>> {
  const external = msg?.external_reply
  const replied = external ? undefined : msg?.reply_to_message
  const source = external ?? replied
  if (!msg || !source || replied?.forum_topic_created) return {}
  const id = replied?.message_id ?? external?.message_id
  const known = id != null ? recall(String(external?.chat?.id ?? msg.chat.id), id)?.[1] : undefined
  const text = replied?.text ?? replied?.caption
  const user = replied?.from ? replied.from.username ?? String(replied.from.id) : external ? senderOf(external.origin) : undefined
  const photo = source.photo?.at(-1)
  const imagePath = photo && await download(photo.file_id, photo.file_unique_id).catch(err => {
    process.stderr.write(`telegram hub: replied-to photo download failed: ${err}\n`)
    return undefined
  })
  const kind = REPLY_FILE_KINDS.find(k => source[k])
  return {
    ...(id != null ? { reply_to_message_id: String(id) } : {}),
    ...(user ? { reply_to_user: user } : {}),
    ...(text ? { reply_to_text: linked(text, replied?.entities ?? replied?.caption_entities) } : known?.text ? { reply_to_text: known.text } : {}),
    ...(msg.quote ? { reply_to_quote: msg.quote.text } : {}),
    ...(imagePath ? { reply_to_image_path: imagePath } : {}),
    ...(kind ? { reply_to_attachment_kind: kind, reply_to_attachment_file_id: source[kind]!.file_id } : {}),
  }
}

type Part = {
  ctx: Context
  text: string
  downloadImage?: () => Promise<string | undefined>
  attachment?: AttachmentMeta
}

const albums = new Map<string, { parts: Part[]; timer?: ReturnType<typeof setTimeout> }>()

async function handleInbound(
  ctx: Context,
  text: string,
  downloadImage: (() => Promise<string | undefined>) | undefined,
  attachment?: AttachmentMeta,
): Promise<void> {
  if (!allowed(ctx.from)) return
  const part = { ctx, text, downloadImage, attachment }
  const group = ctx.message?.media_group_id
  if (!group) return deliverInbound([part])
  const album = albums.get(group) ?? { parts: [] }
  albums.set(group, album)
  album.parts.push(part)
  clearTimeout(album.timer)
  // Telegram sends an album as one message per item, with no event once the last has arrived.
  album.timer = setTimeout(() => {
    albums.delete(group)
    void deliverInbound(album.parts)
  }, ALBUM_WAIT)
}

// One field per attachment, in order: '; ' never appears in an id, a kind, or a safeName.
function listed(name: string, values: (string | number | undefined)[]): Record<string, string> {
  return values.some(value => value != null) ? { [name]: values.map(value => value ?? '').join('; ') } : {}
}

async function deliverInbound(parts: Part[]): Promise<void> {
  const access = loadAccess()
  const { ctx } = parts[0]!
  const from = ctx.from!
  const thread = threadOf(ctx)
  const msgId = ctx.msg?.message_id
  const { chat_id } = target(thread)

  sendTyping(thread)

  // Telegram only accepts a fixed emoji whitelist — if the user configures
  // something outside that set the API rejects it and we swallow.
  if (access.ackReaction && msgId != null) {
    void bot.api
      .setMessageReaction(chat_id, msgId, [
        { type: 'emoji', emoji: access.ackReaction as ReactionTypeEmoji['emoji'] },
      ])
      .catch(() => {})
  }

  const imagePaths = (await Promise.all(parts.map(part => part.downloadImage?.()))).filter(Boolean) as string[]
  const attachments = parts.flatMap(part => part.attachment ?? [])
  const captioned = parts.find(part => part.ctx.msg?.caption) ?? parts[0]!
  const content = parts.length > 1 && captioned.ctx.msg?.caption == null
    ? `(album of ${parts.length})`
    : linked(captioned.text, captioned.ctx.msg?.entities ?? captioned.ctx.msg?.caption_entities)
  const user = from.username ?? String(from.id)
  for (const part of parts) if (part.ctx.msg) remember(thread, part.ctx.msg.message_id, { text: part.ctx.msg.text ?? part.ctx.msg.caption, user })

  // image_path goes in meta only — an in-content "[image attached — read: PATH]"
  // annotation is forgeable by any allowlisted sender typing that string.
  const message: Message = {
    content,
    meta: {
      chat_id,
      ...(msgId != null ? { message_id: String(msgId) } : {}),
      user,
      user_id: String(from.id),
      ts: new Date((ctx.msg?.date ?? 0) * 1000).toISOString(),
      ...(imagePaths.length ? { image_path: imagePaths.join('; ') } : {}),
      ...listed('attachment_kind', attachments.map(a => a.kind)),
      ...listed('attachment_file_id', attachments.map(a => a.file_id)),
      ...listed('attachment_size', attachments.map(a => a.size)),
      ...listed('attachment_mime', attachments.map(a => a.mime)),
      ...listed('attachment_name', attachments.map(a => a.name)),
      ...(await replyMeta(ctx.msg)),
      ...(ctx.editedMessage ? { edited: 'true' } : {}),
      ...(ctx.msg?.forward_origin ? { forwarded_from: senderOf(ctx.msg.forward_origin) } : {}),
    },
  }
  hub.deliver(thread, nameOf(ctx, thread), message)
}

// Without this, any throw in a message handler stops polling permanently
// (grammy's default error handler calls bot.stop() and rethrows).
bot.catch(err => {
  process.stderr.write(`telegram hub: handler error (polling continues): ${err.error}\n`)
})

// Retry polling with backoff on any error: a single ETIMEDOUT/ECONNRESET/DNS
// failure rejects bot.start(), and without the loop the bot goes deaf.
for (let attempt = 1; ; attempt++) {
  try {
    await bot.start({
      allowed_updates: ['message', 'edited_message', 'message_reaction', 'callback_query', 'poll_answer'],
      onStart: info => {
        attempt = 0
        process.stderr.write(`telegram hub: polling as @${info.username}\n`)
      },
    })
    break
  } catch (err) {
    const is409 = err instanceof GrammyError && err.error_code === 409
    const delay = Math.min(1000 * attempt, 15000)
    process.stderr.write(`telegram hub: ${is409 ? '409 Conflict, another poller holds this token' : `polling error: ${err}`}, retrying in ${delay / 1000}s\n`)
    await new Promise(r => setTimeout(r, delay))
  }
}
