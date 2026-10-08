#!/usr/bin/env bun
import { Bot, GrammyError, InputFile, type Context } from 'grammy'
import type { ReactionTypeEmoji } from 'grammy/types'
import { readFileSync, writeFileSync, mkdirSync, statSync, realpathSync, chmodSync } from 'fs'
import { homedir } from 'os'
import { basename, join, extname, sep } from 'path'
import { startHub, clients, move, type Message } from '../../hub/hub.ts'

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
  /** Max chars per outbound message before splitting. Default: 4096 (Telegram's hard cap). */
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
const MAX_ATTACHMENT_BYTES = 50 * 1024 * 1024

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

// .jpg/.jpeg/.png/.gif/.webp go as photos (Telegram compresses + shows inline);
// everything else goes as documents (raw file, no compression).
const PHOTO_EXTS = new Set(['.jpg', '.jpeg', '.png', '.gif', '.webp'])

function threadOf(ctx: Context): string {
  const chat = String(ctx.chat!.id)
  return ctx.message?.is_topic_message ? `${chat}:${ctx.message.message_thread_id}` : chat
}

function target(thread: string) {
  const [chat_id, topic] = thread.split(':')
  return { chat_id: chat_id!, extra: topic ? { message_thread_id: Number(topic) } : {} }
}

const topicNames = new Map<string, string>()

function nameOf(ctx: Context, thread: string): string {
  const created = ctx.message?.reply_to_message?.forum_topic_created
  if (created) topicNames.set(thread, created.name)
  return topicNames.get(thread) ?? (thread.includes(':') ? `topic ${thread.split(':')[1]}` : 'main')
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

function title(text: string): string {
  const title = text.trim()
  if (!title || title.split(/\s+/).length > 2) throw new Error(`title must be 1–2 words, got "${title}"`)
  return title
}

async function place(name: string) {
  if (!MAIN) throw new Error('topics need HEX_MAIN_THREAD, the group they open in')
  const { chat_id } = target(MAIN)
  const topic = await bot.api.createForumTopic(chat_id, name)
  const thread = `${chat_id}:${topic.message_thread_id}`
  topicNames.set(thread, name)
  return { thread, link: `https://t.me/c/${chat_id.replace(/^-100/, '')}/${topic.message_thread_id}` }
}

async function call(caller: string, tool: string, args: Record<string, unknown>): Promise<string> {
  const thread = args.thread ? hub.find(args.thread as string) : caller
  const { chat_id, extra } = target(thread)
  const access = loadAccess()
  switch (tool) {
    case 'reply': {
      const text = args.text as string
      const reply_to = args.reply_to != null ? Number(args.reply_to) : undefined
      const files = (args.files as string[] | undefined) ?? []
      const parseMode = args.format === 'markdownv2' ? 'MarkdownV2' as const : undefined

      for (const f of files) {
        assertSendable(f)
        const st = statSync(f)
        if (st.size > MAX_ATTACHMENT_BYTES) {
          throw new Error(`file too large: ${f} (${(st.size / 1024 / 1024).toFixed(1)}MB, max 50MB)`)
        }
      }

      const limit = Math.max(1, Math.min(access.textChunkLimit ?? MAX_CHUNK_LIMIT, MAX_CHUNK_LIMIT))
      const replyMode = access.replyToMode ?? 'first'
      const chunks = chunk(text, limit, access.chunkMode ?? 'length')
      const sentIds: number[] = []

      try {
        for (let i = 0; i < chunks.length; i++) {
          const shouldReplyTo = reply_to != null && replyMode !== 'off' && (replyMode === 'all' || i === 0)
          const sent = await bot.api.sendMessage(chat_id, chunks[i]!, {
            ...extra,
            ...(shouldReplyTo ? { reply_parameters: { message_id: reply_to } } : {}),
            ...(parseMode ? { parse_mode: parseMode } : {}),
          })
          sentIds.push(sent.message_id)
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        throw new Error(`reply failed after ${sentIds.length} of ${chunks.length} chunk(s) sent: ${msg}`)
      }

      for (const f of files) {
        const input = new InputFile(f)
        const opts = {
          ...extra,
          ...(reply_to != null && replyMode !== 'off' ? { reply_parameters: { message_id: reply_to } } : {}),
        }
        const sent = PHOTO_EXTS.has(extname(f).toLowerCase())
          ? await bot.api.sendPhoto(chat_id, input, opts)
          : await bot.api.sendDocument(chat_id, input, opts)
        sentIds.push(sent.message_id)
      }

      return sentIds.length === 1 ? `sent (id: ${sentIds[0]})` : `sent ${sentIds.length} parts (ids: ${sentIds.join(', ')})`
    }
    case 'react': {
      await bot.api.setMessageReaction(chat_id, Number(args.message_id), [
        { type: 'emoji', emoji: args.emoji as ReactionTypeEmoji['emoji'] },
      ])
      return 'reacted'
    }
    case 'edit_message': {
      const parseMode = args.format === 'markdownv2' ? 'MarkdownV2' as const : undefined
      const edited = await bot.api.editMessageText(
        chat_id,
        Number(args.message_id),
        args.text as string,
        ...(parseMode ? [{ parse_mode: parseMode }] : []),
      )
      return `edited (id: ${typeof edited === 'object' ? edited.message_id : args.message_id})`
    }
    case 'download_attachment': {
      return download(args.file_id as string, args.file_id as string)
    }
    case 'close_thread': {
      if (!extra.message_thread_id) throw new Error('only topics can be closed')
      void hub.retire(thread)
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
      there.hub.open(opened.thread, name, args.prompt as string)
      return `started thread "${name}" in ${app}: ${opened.link}`
    }
    case 'handoff': {
      const to = args.to as string
      const name = title((args.title as string | undefined) ?? topicNames.get(thread) ?? '')
      const link = await move(hub, thread, to, name, args.channel as string | undefined)
      if (thread === MAIN) {
        await bot.api.sendMessage(chat_id, `Continued in ${to}: ${link}`, extra)
        return `a copy of this conversation continues in ${to}: ${link}. You stay here.`
      }
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
    void hub.retire(thread)
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

bot.on('message:sticker', async ctx => {
  const sticker = ctx.message.sticker
  const emoji = sticker.emoji ? ` ${sticker.emoji}` : ''
  await handleInbound(ctx, `(sticker${emoji})`, undefined, {
    kind: 'sticker',
    file_id: sticker.file_id,
    size: sticker.file_size,
  })
})

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

async function placeOf(ctx: Context): Promise<{ thread: string; msgId?: number }> {
  const msgId = ctx.message?.message_id
  if (ctx.chat?.type !== 'private' || !MAIN || msgId == null) return { thread: threadOf(ctx), msgId }
  const { chat_id, extra } = target(MAIN)
  const forwarded = await bot.api.forwardMessage(chat_id, ctx.chat.id, msgId, extra)
  return { thread: MAIN, msgId: forwarded.message_id }
}

const REPLY_FILE_KINDS = ['animation', 'document', 'video', 'audio', 'voice', 'video_note', 'sticker'] as const

// Inside a topic, every message that isn't a reply points at the topic's
// first message, the one that says the topic was created.
async function replyMeta(msg: Context['message']): Promise<Record<string, string>> {
  const replied = msg?.reply_to_message
  if (!replied || replied.forum_topic_created) return {}
  const text = replied.text ?? replied.caption
  const photo = replied.photo?.at(-1)
  const imagePath = photo && await download(photo.file_id, photo.file_unique_id).catch(err => {
    process.stderr.write(`telegram hub: replied-to photo download failed: ${err}\n`)
    return undefined
  })
  const kind = REPLY_FILE_KINDS.find(k => replied[k])
  return {
    reply_to_message_id: String(replied.message_id),
    ...(replied.from ? { reply_to_user: replied.from.username ?? String(replied.from.id) } : {}),
    ...(text ? { reply_to_text: text } : {}),
    ...(msg.quote ? { reply_to_quote: msg.quote.text } : {}),
    ...(imagePath ? { reply_to_image_path: imagePath } : {}),
    ...(kind ? { reply_to_attachment_kind: kind, reply_to_attachment_file_id: replied[kind]!.file_id } : {}),
  }
}

async function handleInbound(
  ctx: Context,
  text: string,
  downloadImage: (() => Promise<string | undefined>) | undefined,
  attachment?: AttachmentMeta,
): Promise<void> {
  const access = loadAccess()
  const from = ctx.from
  if (!from || !access.allowFrom.includes(String(from.id))) return

  const { thread, msgId } = await placeOf(ctx)
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

  const imagePath = downloadImage ? await downloadImage() : undefined

  // image_path goes in meta only — an in-content "[image attached — read: PATH]"
  // annotation is forgeable by any allowlisted sender typing that string.
  const message: Message = {
    content: text,
    meta: {
      chat_id,
      ...(msgId != null ? { message_id: String(msgId) } : {}),
      user: from.username ?? String(from.id),
      user_id: String(from.id),
      ts: new Date((ctx.message?.date ?? 0) * 1000).toISOString(),
      ...(imagePath ? { image_path: imagePath } : {}),
      ...(attachment ? {
        attachment_kind: attachment.kind,
        attachment_file_id: attachment.file_id,
        ...(attachment.size != null ? { attachment_size: String(attachment.size) } : {}),
        ...(attachment.mime ? { attachment_mime: attachment.mime } : {}),
        ...(attachment.name ? { attachment_name: attachment.name } : {}),
      } : {}),
      ...(await replyMeta(ctx.message)),
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
      allowed_updates: ['message'],
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
