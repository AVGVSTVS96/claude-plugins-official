import { beforeAll, expect, mock, test } from 'bun:test'
import { connect } from 'net'
import { mkdtempSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import * as grammy from 'grammy'

const OWNER = 2000
const FORUM = -1001234
const DESK = `${FORUM}:5`
const owner = { id: OWNER, is_bot: false, first_name: 'Bassim', username: 'bassim' }
const hex = { id: 1000, is_bot: true, first_name: 'hex', username: 'hex_bot' }
const forum = { id: FORUM, type: 'supergroup', title: 'hex', is_forum: true }

type Call = { method: string; payload: Record<string, any> }
const calls: Call[] = []
const captionOnly = new Set<number>()
let bot: grammy.Bot
let started: Record<string, any> = {}
let nextMessage = 100
let nextUpdate = 1

function answer(method: string, payload: Record<string, any>) {
  const message = () => ({ message_id: ++nextMessage, date: 0, chat: { id: payload.chat_id }, from: hex })
  switch (method) {
    case 'sendPoll': {
      const sent = message()
      return { ...sent, poll: { id: `poll-${sent.message_id}` } }
    }
    case 'forwardMessages': return payload.message_ids.map(() => ({ message_id: ++nextMessage }))
    case 'getForumTopicIconStickers': return [{ emoji: '🔥', custom_emoji_id: '111' }, { emoji: '❤️', custom_emoji_id: '222' }]
    case 'createForumTopic': return { message_thread_id: 9, name: payload.name, icon_color: 0 }
    case 'getChat': return forum
    case 'getFile': return { file_id: payload.file_id, file_unique_id: payload.file_id, file_path: `photos/${payload.file_id}.jpg` }
    default: return method.startsWith('send') || method.startsWith('forward') ? message() : true
  }
}

// The real grammy Bot routes every update; only its calls to Telegram are faked.
class Bot extends grammy.Bot {
  constructor(token: string) {
    super(token, { botInfo: hex as any })
    bot = this
    this.api.config.use(async (_prev, method, payload: any) => {
      calls.push({ method, payload })
      if (method === 'editMessageText' && captionOnly.has(payload.message_id)) {
        return { ok: false, error_code: 400, description: 'Bad Request: there is no text in the message to edit' } as any
      }
      return { ok: true, result: answer(method, payload) } as any
    })
  }
  override async start(options: any) {
    started = options
    options.onStart?.(hex)
  }
}

mock.module('grammy', () => ({ ...grammy, Bot }))

const state = mkdtempSync(join(tmpdir(), 'telegram-'))
const received: any[] = []
let call: (tool: string, args: object) => Promise<any>
let session: (payload: object) => void

async function until<T>(check: () => T | undefined, timeout = 3000): Promise<T> {
  for (const end = Date.now() + timeout; Date.now() < end; await Bun.sleep(20)) {
    const value = check()
    if (value) return value
  }
  throw new Error('timed out')
}

const called = (method: string, match: (payload: Record<string, any>) => boolean = () => true) =>
  until(() => calls.find(c => c.method === method && match(c.payload))?.payload)
const inbound = (match: (line: any) => boolean) => until(() => received.find(line => line.type === 'inbound' && match(line)))

function message(fields: Record<string, any>) {
  return { message_id: ++nextMessage, date: 1760000000, chat: forum, from: owner, message_thread_id: 5, is_topic_message: true, ...fields }
}

async function update(fields: Record<string, any>) {
  await bot.handleUpdate({ update_id: nextUpdate++, ...fields } as any)
}

beforeAll(async () => {
  writeFileSync(join(state, 'access.json'), JSON.stringify({ allowFrom: [String(OWNER)] }))
  writeFileSync(join(state, 'threads.json'), JSON.stringify({ [DESK]: { name: 'desk' }, [`${FORUM}:6`]: { name: 'notes' } }))
  Object.assign(process.env, { TELEGRAM_STATE_DIR: state, TELEGRAM_BOT_TOKEN: 'token', HEX_LAUNCHER: 'false', HEX_MAIN_THREAD: String(FORUM) })
  globalThis.fetch = (async () => new Response('jpeg')) as any
  await import('./bot.ts')
  const socket = connect(join(state, 'hub.sock'))
  let buffer = ''
  let next = 0
  socket.setEncoding('utf8')
  socket.on('data', (chunk: string) => {
    buffer += chunk
    const lines = buffer.split('\n')
    buffer = lines.pop()!
    received.push(...lines.map(line => JSON.parse(line)))
  })
  await new Promise(resolve => socket.on('connect', resolve))
  session = payload => socket.write(JSON.stringify(payload) + '\n')
  session({ type: 'hello', thread: DESK, session: '0a1b2c3d-0000-4000-8000-000000000000' })
  call = (tool, args) => {
    const id = ++next
    session({ type: 'call', id, tool, args })
    return until(() => received.find(line => line.type === 'result' && line.id === id))
  }
})

test('the bot asks Telegram for reactions, button taps and poll votes', () => {
  expect(started.allowed_updates).toEqual(['message', 'edited_message', 'message_reaction', 'callback_query', 'poll_answer'])
})

test('a reaction reaches the thread of the message it is on, with that message\'s text and author', async () => {
  const sent = await call('reply', { text: 'deploy is green' })
  const id = Number(sent.text.match(/id: (\d+)/)[1])
  const react = (old_reaction: object[], new_reaction: object[]) =>
    update({ message_reaction: { chat: forum, message_id: id, user: owner, date: 1760000000, old_reaction, new_reaction } })
  const thumbs = { type: 'emoji', emoji: '👍' }

  await react([], [thumbs])
  expect((await inbound(line => line.meta.reaction === '👍' && !line.meta.reaction_removed)).meta).toMatchObject({
    reaction_to_message_id: String(id), reaction_to_user: 'hex_bot', reaction_to_text: 'deploy is green',
  })
  await react([thumbs], [])
  expect((await inbound(line => line.meta.reaction_removed === 'true')).content).toBe('(reaction removed: 👍)')
})

test('a reaction on a forum message the hub never saw is dropped, since Telegram names no topic', async () => {
  const before = received.length
  await update({ message_reaction: { chat: forum, message_id: 1, user: owner, date: 1760000000, old_reaction: [], new_reaction: [{ type: 'emoji', emoji: '🔥' }] } })
  await Bun.sleep(100)
  expect(received.slice(before).filter(line => line.type === 'inbound')).toEqual([])
})

test('buttons come back as a tap with the label, and the message keeps only the chosen one', async () => {
  const sent = await call('reply', { text: 'Ship it?', buttons: ['Yes', 'No'], silent: true })
  const id = Number(sent.text.match(/id: (\d+)/)[1])
  expect(await called('sendMessage', p => p.text === 'Ship it?')).toMatchObject({
    disable_notification: true,
    reply_markup: { inline_keyboard: [[{ text: 'Yes', callback_data: '0' }, { text: 'No', callback_data: '1' }]] },
  })
  const markup = { inline_keyboard: [[{ text: 'Yes', callback_data: '0' }, { text: 'No', callback_data: '1' }]] }
  await update({ callback_query: { id: 'tap', from: owner, chat_instance: 'x', data: '0', message: message({ message_id: id, from: hex, text: 'Ship it?', reply_markup: markup }) } })
  expect(await called('answerCallbackQuery')).toMatchObject({ callback_query_id: 'tap' })
  expect(await called('editMessageReplyMarkup', p => p.message_id === id)).toMatchObject({ reply_markup: { inline_keyboard: [[{ text: '✓ Yes', disabled: {} }]] } })
  const tap = await inbound(line => line.meta.button === 'true')
  expect(tap.content).toBe('Yes')
  expect(tap.meta.button_message_id).toBe(String(id))
})

test('delete, unreact, pin, unpin and forward act on the message they name', async () => {
  await call('delete_message', { message_id: '7' })
  expect(await called('deleteMessage')).toMatchObject({ chat_id: String(FORUM), message_id: 7 })
  await call('react', { message_id: '7', emoji: '👍', remove: true })
  expect(await called('setMessageReaction', p => p.message_id === 7)).toMatchObject({ reaction: [] })
  await call('pin', { message_id: '7' })
  await call('pin', { message_id: '7', unpin: true })
  expect(await called('pinChatMessage')).toMatchObject({ message_id: 7 })
  expect(await called('unpinChatMessage')).toMatchObject({ message_id: 7 })
  expect((await call('forward', { message_id: '7', thread: 'notes' })).text).toMatch(/^forwarded to "notes"/)
  expect(await called('forwardMessage')).toMatchObject({ chat_id: String(FORUM), from_chat_id: String(FORUM), message_id: 7, message_thread_id: 6 })
})

test('a poll goes out with named votes, and each vote comes back as the chosen options', async () => {
  const sent = await call('poll', { question: 'Lunch?', options: ['tacos', 'pho', 'salad'], multiple: true })
  const id = Number(sent.text.match(/id: (\d+)/)[1])
  expect(await called('sendPoll')).toMatchObject({ question: 'Lunch?', options: [{ text: 'tacos' }, { text: 'pho' }, { text: 'salad' }], is_anonymous: false, allows_multiple_answers: true })
  await update({ poll_answer: { poll_id: `poll-${id}`, user: owner, option_ids: [0, 2] } })
  const vote = await inbound(line => line.meta.vote)
  expect(vote.content).toBe('(vote: tacos; salad)')
  expect(vote.meta).toMatchObject({ vote: 'tacos; salad', poll_message_id: String(id), poll: 'Lunch?' })
  await update({ poll_answer: { poll_id: `poll-${id}`, user: owner, option_ids: [] } })
  expect((await inbound(line => line.meta.vote_removed === 'true')).content).toBe('(vote removed)')
})

test('edit_message changes a file\'s caption when it has no text, and replaces the file itself', async () => {
  captionOnly.add(42)
  await call('edit_message', { message_id: '42', text: 'new caption' })
  expect(await called('editMessageCaption')).toMatchObject({ message_id: 42, caption: 'new caption' })
  const file = join(state, '..', `chart-${Date.now()}.png`)
  writeFileSync(file, 'png')
  await call('edit_message', { message_id: '43', file })
  expect((await called('editMessageMedia')).media).toMatchObject({ type: 'photo' })
})

test('markdown goes out as Telegram\'s own rich markdown, and a code block cut between chunks stays a code block', async () => {
  await call('reply', { text: 'look:\n```\n┌─┐\n└─┘\n```', format: 'markdown' })
  expect(await called('sendRichMessage')).toMatchObject({ rich_message: { markdown: 'look:\n```\n┌─┐\n└─┘\n```' }, message_thread_id: 5 })
  writeFileSync(join(state, 'access.json'), JSON.stringify({ allowFrom: [String(OWNER)], textChunkLimit: 40 }))
  await call('reply', { text: '```ts\n' + 'const a = 1\n'.repeat(5) + '```', format: 'markdown' })
  writeFileSync(join(state, 'access.json'), JSON.stringify({ allowFrom: [String(OWNER)] }))
  const parts = calls.filter(c => c.method === 'sendRichMessage').slice(1).map(c => c.payload.rich_message.markdown)
  expect(parts.length).toBeGreaterThan(1)
  for (const part of parts) expect(part.match(/```/g)!.length % 2).toBe(0)
})

test('files go without an empty message, short text rides as the caption, and a photo over 10MB goes as a document', async () => {
  const small = join(state, '..', `small-${Date.now()}.jpg`)
  const big = join(state, '..', `big-${Date.now()}.jpg`)
  writeFileSync(small, 'jpg')
  writeFileSync(big, Buffer.alloc(11 * 1024 * 1024))
  const before = calls.length
  await call('reply', { text: 'two shots', files: [small, big] })
  const sent = calls.slice(before)
  expect(sent.map(c => c.method)).toEqual(['sendPhoto', 'sendDocument'])
  expect(sent[0]!.payload.caption).toBe('two shots')
  expect(sent[1]!.payload.caption).toBeUndefined()
})

test('new_thread opens a topic with a random icon, forwarding the request and the reply since; rename_thread renames it and changes its icon', async () => {
  const asked = message({ text: 'open a topic for the desk anchors' })
  await update({ message: asked })
  await inbound(line => line.meta.message_id === String(asked.message_id))
  session({ type: 'state', thread: DESK, busy: true })
  await until(() => calls.find(c => c.method === 'sendChatAction'))
  const sent = await call('reply', { text: 'on it' })
  const replyId = Number(sent.text.match(/id: (\d+)/)[1])
  expect((await call('new_thread', { title: 'Desk', prompt: 'research desk anchors' })).text).toMatch(/^started thread "Desk" in telegram/)
  expect((await called('createForumTopic')).icon_custom_emoji_id).toMatch(/^(111|222)$/)
  expect(await called('forwardMessages')).toMatchObject({ chat_id: String(FORUM), from_chat_id: String(FORUM), message_ids: [asked.message_id, replyId], message_thread_id: 9 })
  session({ type: 'state', thread: DESK, busy: false })

  await call('rename_thread', { title: 'Anchors', icon: '❤' })
  expect(await called('editForumTopic')).toMatchObject({ message_thread_id: 5, name: 'Anchors', icon_custom_emoji_id: '222' })
  expect((await call('rename_thread', { title: 'Desk anchors' })).error).toBe('title must be one word, got "Desk anchors"')
  expect((await call('rename_thread', { icon: '🦄' })).error).toBe('Telegram has no topic icon 🦄; pick one of 🔥 ❤️')
})

test('an album arrives as one message with every photo and the caption', async () => {
  const photo = (id: string) => [{ file_id: `${id}-small`, file_unique_id: `${id}-small`, width: 90, height: 90 }, { file_id: id, file_unique_id: id, width: 900, height: 900 }]
  const first = message({ media_group_id: 'g1', photo: photo('one'), caption: 'the anchors' })
  await update({ message: first })
  await update({ message: message({ media_group_id: 'g1', photo: photo('two') }) })
  const album = await inbound(line => line.meta.message_id === String(first.message_id))
  expect(album.content).toBe('the anchors')
  expect(album.meta.image_path.split('; ').map((path: string) => path.replace(/.*\d-/, ''))).toEqual(['one.jpg', 'two.jpg'])
})

test('polls, dice and games arrive as readable lines', async () => {
  await update({ message: message({ poll: { id: 'p', question: 'Lunch?', options: [{ text: 'tacos', voter_count: 0 }, { text: 'pho', voter_count: 0 }] } }) })
  await update({ message: message({ dice: { emoji: '🎲', value: 4 } }) })
  await update({ message: message({ game: { title: 'Snake', description: 'eat', photo: [] } }) })
  await inbound(line => line.content === '(poll: Lunch? [tacos / pho])')
  await inbound(line => line.content === '(dice 🎲: 4)')
  await inbound(line => line.content === '(game: Snake)')
})

test('a reply to a message in another topic keeps the quote and what the hub knows of it', async () => {
  const sent = await call('reply', { text: 'anchors ship friday', thread: 'notes' })
  const id = Number(sent.text.match(/id: (\d+)/)[1])
  const reply = message({
    text: 'still true?',
    external_reply: { origin: { type: 'user', date: 0, sender_user: hex }, chat: forum, message_id: id },
    quote: { text: 'friday', position: 0 },
  })
  await update({ message: reply })
  expect((await inbound(line => line.meta.message_id === String(reply.message_id))).meta).toMatchObject({
    reply_to_message_id: String(id), reply_to_user: 'hex_bot', reply_to_text: 'anchors ship friday', reply_to_quote: 'friday',
  })
})

test('the got-it reaction lands on each message when access.json sets one', async () => {
  writeFileSync(join(state, 'access.json'), JSON.stringify({ allowFrom: [String(OWNER)], ackReaction: '👀' }))
  const seen = message({ text: 'ping' })
  await update({ message: seen })
  expect(await called('setMessageReaction', p => p.message_id === seen.message_id)).toMatchObject({ reaction: [{ type: 'emoji', emoji: '👀' }] })
  writeFileSync(join(state, 'access.json'), JSON.stringify({ allowFrom: [String(OWNER)] }))
})
