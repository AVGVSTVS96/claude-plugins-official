import { afterAll, beforeAll, expect, mock, test } from 'bun:test'
import { connect as netConnect } from 'net'
import { connect } from '../../hub/testing.ts'
import { clients } from '../../hub/hub.ts'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import * as discord from 'discord.js'

const { ButtonStyle, ChannelType, Collection, ComponentType, MessageFlags, MessageFlagsBitField, MessageType, SnowflakeUtil } = discord
const TRANSCRIBER = 'http://transcriber/v1/audio/transcriptions'
const BOT = '1000'
const OWNER = '2000'
const GUILD = '3000'
const at = (minute: number) => new Date(Date.UTC(2026, 9, 5, 12, minute))
const snowflake = (minute: number) => SnowflakeUtil.generate({ timestamp: at(minute) }).toString()

type Channel = Record<string, any>
const channels = new Map<string, Channel>()
const handlers = new Map<string, (...args: any[]) => void>()
const owner = { id: OWNER, username: 'bassim', bot: false, partial: false }
const bot = { id: BOT, username: 'hex', bot: true }
const done: any[] = []
let found: object = {}
let sent = 0
let opened = 0
let logins = 0

// A guild channel or thread whose messages the fake REST answers newest-first, as Discord does.
function channel(id: string, fields: Channel): Channel {
  const messages: Channel[] = []
  const ch: Channel = {
    id,
    guildId: GUILD,
    visible: true,
    archived: false,
    parent: null,
    isThread: () => ch.type === ChannelType.PublicThread || ch.type === ChannelType.AnnouncementThread,
    isThreadOnly: () => ch.type === ChannelType.GuildForum,
    isDMBased: () => ch.type === ChannelType.DM,
    permissionsFor: () => ({ has: () => ch.visible }),
    sendTyping: async () => {},
    send: async (input: string | Channel) => {
      const options = typeof input === 'string' ? { content: input } : input
      done.push({ send: options, in: id })
      return say(ch, 59, options.content ?? '', { id: String(BigInt(snowflake(59)) + BigInt(++sent)), author: bot, components: options.components?.map((row: any) => row.toJSON()) })
    },
    fetchStarterMessage: async () => (ch.parent.isThreadOnly() ? ch : ch.parent).messages.fetch(id),
    posted: messages,
    messages: {
      fetch: async (query: string | { limit: number; before?: string }) => {
        if (typeof query === 'string') return messages.find(m => m.id === query) ?? Promise.reject(new Error('Unknown Message'))
        const { limit, before } = query
        return new Collection(messages
          .filter(m => !before || BigInt(m.id) < BigInt(before))
          .sort((a, b) => Number(BigInt(b.id) - BigInt(a.id)))
          .slice(0, limit)
          .map(m => [m.id, m]))
      },
      edit: async (message: string, options: Channel) => (done.push({ edit: message, options }), messages.find(m => m.id === message)),
    },
    threads: {
      create: async ({ name, message, appliedTags }: Channel) => {
        done.push({ create: name, in: id, ...(message && { message: message.content }), ...(appliedTags && { appliedTags }) })
        return channel(String(9000 + ++opened), { name, type: ChannelType.PublicThread, parent: ch, parentId: id })
      },
      fetchActive: async () => ({ threads: new Collection([...channels].filter(([, c]) => c.parent === ch && !c.archived)) }),
      fetchArchived: async () => ({ threads: new Collection([...channels].filter(([, c]) => c.parent === ch && c.archived)) }),
    },
    ...fields,
  }
  channels.set(id, ch)
  return ch
}

// A message whose Discord calls land in done; deleting it fires the gateway's messageDelete.
function say(where: Channel, minute: number, content: string, fields: Channel = {}): Channel {
  const id = snowflake(minute)
  const message: Channel = {
    id,
    content,
    createdAt: at(minute),
    author: owner,
    channel: where,
    channelId: where.id,
    flags: new MessageFlagsBitField(),
    attachments: new Collection(),
    messageSnapshots: new Collection(),
    stickers: new Collection(),
    poll: null,
    thread: null,
    reactions: { cache: new Collection() },
    react: async (emoji: string) => done.push({ react: emoji, on: message.id }),
    pin: async () => done.push({ pin: message.id }),
    unpin: async () => done.push({ unpin: message.id }),
    edit: async (options: Channel) => (done.push({ edit: message.id, options }), message),
    forward: async (to: string) => (done.push({ forward: message.id, to }), { id: '7777' }),
    delete: async () => {
      done.push({ delete: message.id })
      handlers.get('messageDelete')!(message)
    },
    ...fields,
  }
  where.posted.push(message)
  return message
}

const openSource = channel('4000', { name: 'open-source', type: ChannelType.GuildText })
const general = channel('4001', { name: 'general', type: ChannelType.GuildText })
const hidden = channel('4002', { name: 'hidden', type: ChannelType.GuildText, visible: false })
const dm = channel('4003', { name: 'dm', type: ChannelType.DM, guildId: undefined })
const elsewhere = channel('4004', { name: 'elsewhere', type: ChannelType.PublicThread, guildId: '9999' })

const ci = say(openSource, 0, 'flaky CI on the relay PR')
const ciThread = channel(ci.id, { name: 'flaky CI', type: ChannelType.PublicThread, parent: openSource, messageCount: 2, lastMessageId: snowflake(3) })
ci.thread = ciThread
const docs = say(openSource, 1, 'merged the docs fix')
const rebased = say(ciThread, 2, 'rebased it')
const pushed = say(ciThread, 3, 'rebased again\nand pushed')
const release = say(openSource, 4, 'release tomorrow')
say(hidden, 5, 'not for the bot')
const news = channel('4005', { name: 'news', type: ChannelType.GuildAnnouncement })
const ideas = channel('4006', { name: 'ideas', type: ChannelType.GuildForum })
const here = channel('5000', { name: 'desk anchors', type: ChannelType.PublicThread, parent: general })
const live = (where: Channel) => ({ inGuild: () => true, channel: where, mentions: { has: () => false }, react: async () => {} })

class Client {
  user = { id: BOT, tag: 'hex#0000' }
  channels = {
    fetch: async (id: string) => {
      if (!channels.has(id)) throw new Error('Unknown Channel')
      return channels.get(id)
    },
  }
  guilds = { cache: new Collection([[GUILD, { id: GUILD, systemChannel: general, channels: { cache: channels, fetch: async () => new Collection([...channels].filter(([, ch]) => ch.guildId === GUILD && !ch.isThread())) } }]]) }
  users = { fetch: async (id: string) => (id === OWNER ? owner : { id, username: 'someone' }) }
  rest = {
    get: async (route: string, { query }: { query: URLSearchParams }) => (done.push({ get: route, query: query.toString() }), found),
  }
  on(event: string, handler: (...args: any[]) => void) {
    handlers.set(event, handler)
    return this
  }
  once(event: string, handler: (...args: any[]) => void) {
    return this.on(event, handler)
  }
  login = async () => {
    if (++logins === 1) throw new Error('getaddrinfo ETIMEOUT discord.com')
    return 'token'
  }
}

mock.module('discord.js', () => ({ ...discord, Client }))

const state = mkdtempSync(join(tmpdir(), 'discord-'))
afterAll(() => rmSync(state, { recursive: true, force: true }))
let received: any[]
let call: (tool: string, args: object) => Promise<any>
let send: (payload: object) => void
let ask: (request: object) => Promise<Response>

async function until<T>(check: () => T | undefined, timeout = 3000): Promise<T> {
  for (const end = Date.now() + timeout; Date.now() < end; await Bun.sleep(20)) {
    const value = check()
    if (value) return value
  }
  throw new Error('timed out')
}

beforeAll(async () => {
  writeFileSync(join(state, 'access.json'), JSON.stringify({ allowFrom: [OWNER] }))
  Object.assign(process.env, { DISCORD_STATE_DIR: state, DISCORD_BOT_TOKEN: 'token', HEX_LAUNCHER: 'false', TRANSCRIBE_URL: TRANSCRIBER, TRANSCRIBE_MODEL: 'whisper' })
  const fetch = globalThis.fetch
  globalThis.fetch = (async (url: string, init?: RequestInit) => {
    if (url === 'https://cdn.discord/voice-message.ogg') return new Response('ogg')
    if (url === 'https://cdn.discord/shot.png') return new Response('png bytes')
    if (url !== TRANSCRIBER) return fetch(url, init)
    return Response.json({ text: (init!.body as FormData).get('model') === 'whisper' ? ' anchors ship friday ' : 'wrong model' })
  }) as any
  await import('./bot.ts')
  ;({ received, call, send, ask } = await session(here.id))
})

// A session bound to thread, connected once the hub has registered it, with its hooks on hub.sock.
async function session(thread: string) {
  const line = await connect({ stateDir: state, path: '/discord', channel: 'plugin:discord@hex', thread })
  const hooks = netConnect(join(state, 'hub.sock'))
  await new Promise(resolve => hooks.on('connect', resolve))
  const send = (payload: object) => hooks.write(JSON.stringify(payload) + '\n')
  await line.call('list_channels', {})
  return { received: line.received, call: line.call, send, ask: line.ask }
}

const book = () => JSON.parse(readFileSync(join(state, 'ledger.json'), 'utf8'))
const labels = (components: any[]) => components[0].toJSON().components.map((c: any) => c.label)

test('a message in a thread names the channel the thread is in', async () => {
  const message = { ...say(here, 6, 'what did we decide in open-source?'), ...live(here) }
  handlers.get('messageCreate')!(message)
  const inbound = await until(() => received.find(line => line.type === 'inbound'))
  expect(inbound.meta).toMatchObject({ chat_id: here.id, message_id: message.id, channel: 'general' })
})

test('a reply says which message it answers, an edit comes back marked edited, and a forward carries what was forwarded', async () => {
  const inbound = (id: string, edited?: string) => until(() => received.find(line => line.type === 'inbound' && line.meta.message_id === id && line.meta.edited === edited))
  const asked = say(here, 7, 'which anchors?')
  const reply = { ...say(here, 8, 'the left ones'), ...live(here), type: MessageType.Reply, reference: { messageId: asked.id }, fetchReference: async () => asked }
  handlers.get('messageCreate')!(reply)
  expect((await inbound(reply.id)).meta).toMatchObject({ reply_to_message_id: asked.id, reply_to_user: 'bassim', reply_to_text: 'which anchors?' })

  handlers.get('messageUpdate')!({ ...reply, partial: false }, { ...reply, content: 'the right ones' })
  const edit = await inbound(reply.id, 'true')
  expect(edit.content).toBe('the right ones')
  expect(edit.meta.new_thread).toBeUndefined()

  const forward = { ...say(here, 9, ''), ...live(here), messageSnapshots: new Collection([['1', { content: 'ship it friday', flags: new MessageFlagsBitField(), attachments: new Collection(), stickers: new Collection() }]]) }
  handlers.get('messageCreate')!(forward)
  const forwarded = await inbound(forward.id)
  expect(forwarded.content).toBe('ship it friday')
  expect(forwarded.meta.forwarded).toBe('true')
})

test('a voice message arrives as its transcript, with the recording still listed', async () => {
  const recording = { id: '61', name: 'voice-message.ogg', url: 'https://cdn.discord/voice-message.ogg', contentType: 'audio/ogg', size: 2048 }
  const voice = { ...say(here, 40, ''), ...live(here), flags: new MessageFlagsBitField(MessageFlags.IsVoiceMessage), attachments: new Collection([[recording.id, recording]]) }
  handlers.get('messageCreate')!(voice)
  const heard = await until(() => received.find(line => line.type === 'inbound' && line.meta.message_id === voice.id))
  expect(heard).toMatchObject({ content: '(voice message) anchors ship friday', meta: { attachments: 'voice-message.ogg (audio/ogg, 2KB)' } })
})

test('fetch_messages reads a channel\'s top-level messages oldest-first, with each thread\'s replies, and pages back', async () => {
  const page = await call('fetch_messages', { channel: '#open-source', limit: 2 })
  expect(page.text).toBe([
    `[${at(1).toISOString()}] bassim: merged the docs fix  (id: ${docs.id})`,
    `[${at(4).toISOString()}] bassim: release tomorrow  (id: ${release.id})`,
  ].join('\n'))
  const older = await call('fetch_messages', { channel: openSource.id, before: docs.id })
  expect(older.text).toBe(`[${at(0).toISOString()}] bassim: flaky CI on the relay PR  (id: ${ci.id}, 2 replies, last reply ${at(3).toISOString()})`)
})

test('fetch_messages drills into a thread by the id of the message it hangs off, and pages back through it', async () => {
  const thread = await call('fetch_messages', { thread: ci.id })
  expect(thread.text).toBe([
    `[${at(2).toISOString()}] bassim: rebased it  (id: ${rebased.id})`,
    `[${at(3).toISOString()}] bassim: rebased again ⏎ and pushed  (id: ${pushed.id})`,
  ].join('\n'))
  expect((await call('fetch_messages', { thread: ci.id, before: pushed.id })).text).toBe(`[${at(2).toISOString()}] bassim: rebased it  (id: ${rebased.id})`)
})

test('sessions read only text channels and threads in the server the bot can see, never a DM', async () => {
  const refused = (id: string) => `the bot can't read ${id}; list_channels shows the channels it can`
  expect((await call('fetch_messages', { channel: 'hidden' })).error).toBe(refused(hidden.id))
  expect((await call('fetch_messages', { channel: 'nowhere' })).error).toBe('no text or forum channel named #nowhere')
  expect((await call('fetch_messages', { thread: '4003' })).error).toBe(refused('4003'))
  expect((await call('fetch_messages', { thread: elsewhere.id })).error).toBe(refused(elsewhere.id))
})

test('list_channels names the text, announcement and forum channels the bot can read', async () => {
  expect((await call('list_channels', {})).text).toBe(`#open-source  (id: ${openSource.id})\n#general  (id: ${general.id})\n#news  (id: ${news.id})\n#ideas  (id: ${ideas.id}, forum)`)
})

const inbound = (lines: any[], check: (line: any) => boolean) => until(() => lines.find(line => line.type === 'inbound' && check(line)))

test('a reaction reaches a served thread with what it was on, a removal says so, and reactions elsewhere or by others are dropped', async () => {
  const msg = say(here, 10, 'ship the anchors?')
  const partial = { id: msg.id, channelId: here.id, channel: here, partial: true, fetch: async () => msg }
  const thumbs = { message: partial, emoji: { toString: () => '👍' } }
  handlers.get('messageReactionAdd')!(thumbs, owner)
  const added = await inbound(received, line => line.meta.reaction_to_message_id === msg.id)
  expect(added.content).toBe('(reaction: 👍)')
  expect(added.meta).toMatchObject({ chat_id: here.id, user: 'bassim', reaction: '👍', reaction_to_user: 'bassim', reaction_to_text: 'ship the anchors?' })
  expect(added.meta.reaction_removed).toBeUndefined()

  handlers.get('messageReactionRemove')!(thumbs, owner)
  const removed = await inbound(received, line => line.meta.reaction_removed === 'true')
  expect(removed.content).toBe('(reaction removed: 👍)')

  const stranger = say(here, 11, 'not mine')
  handlers.get('messageReactionAdd')!({ message: stranger, emoji: { toString: () => '🎉' } }, { id: '8888', username: 'someone', partial: false })
  handlers.get('messageReactionAdd')!({ message: rebased, emoji: { toString: () => '🎉' } }, owner)
  await Bun.sleep(100)
  expect(received.some(line => line.meta?.reaction === '🎉')).toBe(false)
})

test('a reaction on the message a served thread hangs off reaches that thread', async () => {
  const ci2 = await session(ciThread.id)
  handlers.get('messageReactionAdd')!({ message: ci, emoji: { toString: () => '<:ship:123>' } }, owner)
  expect((await inbound(ci2.received, line => line.meta.reaction)).meta).toMatchObject({ chat_id: ciThread.id, reaction: '<:ship:123>', reaction_to_message_id: ci.id })
})

test('a deleted message is reported with its text when known, but the bot\'s own delete_message is not echoed back', async () => {
  const typo = say(here, 12, 'teh anchors')
  handlers.get('messageDelete')!(typo)
  expect((await inbound(received, line => line.meta.deleted === 'true')).meta).toMatchObject({ message_id: typo.id, deleted_text: 'teh anchors' })

  handlers.get('messageDeleteBulk')!(new Collection([['1', { id: '1234', channelId: here.id, channel: here, partial: true, content: null }]]))
  const unknown = await inbound(received, line => line.meta.message_id === '1234')
  expect(unknown.content).toBe('(deleted a message)')
  expect(unknown.meta.deleted_text).toBeUndefined()

  const mine = say(here, 13, 'wrong answer', { author: bot })
  expect((await call('delete_message', { message_id: mine.id })).text).toBe('deleted')
  expect(done).toContainEqual({ delete: mine.id })
  expect((await call('delete_message', { message_id: typo.id })).error).toBe('the bot can only delete its own messages')
  await Bun.sleep(100)
  expect(received.some(line => line.meta?.message_id === mine.id)).toBe(false)
})

test('reply buttons go on the last chunk, and a tap locks them on the choice and comes back as its label', async () => {
  const sent = await call('reply', { text: 'merge it?', buttons: ['Yes', 'No'], silent: true })
  const posted = here.posted.at(-1)
  expect(sent.text).toBe(`sent (id: ${posted.id})`)
  expect(done.at(-1).send.flags).toBe(discord.MessageFlags.SuppressNotifications)
  expect(posted.components[0].components.map((b: any) => [b.label, b.disabled])).toEqual([['Yes', false], ['No', false]])

  let update: any
  handlers.get('interactionCreate')!({
    isButton: () => true,
    user: owner,
    customId: '1',
    channelId: here.id,
    createdAt: at(14),
    message: posted,
    update: async (options: any) => (update = options),
  })
  const tap = await inbound(received, line => line.meta.button === 'true')
  expect(tap.content).toBe('No')
  expect(tap.meta).toMatchObject({ chat_id: here.id, user: 'bassim', button_message_id: posted.id })
  expect(update.components[0].toJSON().components.map((b: any) => [b.label, b.disabled, b.style])).toEqual([
    ['Yes', true, discord.ButtonStyle.Secondary],
    ['No', true, discord.ButtonStyle.Primary],
  ])
})

test('react can take the bot\'s reaction off, pin toggles, poll posts a poll, and edit_message swaps the files', async () => {
  const msg = say(here, 15, 'pin me')
  msg.reactions.cache.set('👀', { me: true, users: { remove: async () => done.push({ unreact: msg.id }) } })
  expect((await call('react', { message_id: msg.id, emoji: '👀', remove: true })).text).toBe('reaction removed')
  expect(done).toContainEqual({ unreact: msg.id })
  expect((await call('react', { message_id: msg.id, emoji: '🙈', remove: true })).error).toBe(`the bot hasn't reacted 🙈 to that message`)

  await call('pin', { message_id: msg.id })
  await call('pin', { message_id: msg.id, unpin: true })
  expect(done).toContainEqual({ pin: msg.id })
  expect(done).toContainEqual({ unpin: msg.id })

  await call('poll', { question: 'Lunch?', options: ['Tacos', 'Ramen'], multiple: true })
  expect(done.at(-1).send.poll).toEqual({ question: { text: 'Lunch?' }, answers: [{ text: 'Tacos' }, { text: 'Ramen' }], allowMultiselect: true, duration: 24 })

  mkdirSync(join(state, 'inbox'), { recursive: true })
  const file = join(state, 'inbox', 'chart.png')
  writeFileSync(file, 'png')
  await call('edit_message', { message_id: msg.id, files: [file] })
  expect(done.at(-1)).toEqual({ edit: msg.id, options: { files: [file], attachments: [] } })
  await call('edit_message', { message_id: msg.id, text: 'new caption' })
  expect(done.at(-1)).toEqual({ edit: msg.id, options: { content: 'new caption' } })
})

test('forward sends a message from this thread into another thread by name or a channel', async () => {
  const msg = say(here, 16, 'the left anchors')
  handlers.get('threadUpdate')!({ name: ciThread.id }, ciThread)
  expect((await call('forward', { message_id: msg.id, thread: 'flaky CI' })).text).toBe('forwarded (id: 7777)')
  expect(done.at(-1)).toEqual({ forward: msg.id, to: ciThread.id })
  await call('forward', { message_id: msg.id, channel: 'news' })
  expect(done.at(-1)).toEqual({ forward: msg.id, to: news.id })
  expect((await call('forward', { message_id: msg.id })).error).toBe('name a thread or channel to forward to')
})

test('the message a thread was started from is found in the channel it hangs off', async () => {
  const shot = say(general, 17, 'explain this screenshot', { id: '5001' })
  const started = channel(shot.id, { name: 'screenshot', type: ChannelType.PublicThread, parent: general })
  const s = await session(started.id)
  await s.call('react', { message_id: shot.id, emoji: '👀' })
  expect(done.at(-1)).toEqual({ react: '👀', on: shot.id })
  expect((await s.call('download_attachment', { message_id: shot.id })).text).toBe('message has no attachments')
})

test('search_messages searches the whole server and says where each match is', async () => {
  found = {
    total_results: 2,
    messages: [
      [{ id: '11', channel_id: openSource.id, content: 'relay flake again', timestamp: at(20).toISOString(), author: { id: OWNER, username: 'bassim' }, attachments: [] }],
      [{ id: '12', channel_id: ciThread.id, content: 'relay fixed', timestamp: at(21).toISOString(), author: { id: BOT, username: 'hex' }, attachments: [{}] }],
    ],
    threads: [{ id: ciThread.id, name: 'flaky CI' }],
  }
  expect((await call('search_messages', { query: 'relay', channel: 'open-source' })).text).toBe([
    '2 found, newest first',
    `[${at(20).toISOString()}] bassim: relay flake again  (id: 11, in #open-source)`,
    `[${at(21).toISOString()}] me: relay fixed  (id: 12, in thread ${ciThread.id} "flaky CI" +1att)`,
  ].join('\n'))
  expect(done.at(-1)).toEqual({ get: `/guilds/${GUILD}/messages/search`, query: `content=relay&limit=25&channel_id=${openSource.id}` })

  found = { message: 'Index not yet available. Try again later', code: 110000, retry_after: 2 }
  expect((await call('search_messages', { query: 'relay' })).text).toBe("Discord is still indexing this server's messages; search again in 2s")
})

test('stickers and polls arrive described, and a new forum post carries its title instead of asking for a rename', async () => {
  const sticker = { ...say(here, 22, ''), ...live(here), stickers: new Collection([['1', { name: 'wave', url: 'https://media.discordapp.net/stickers/1.png' }]]) }
  handlers.get('messageCreate')!(sticker)
  const waved = await inbound(received, line => line.meta.message_id === sticker.id)
  expect(waved.content).toBe('(sticker)')
  expect(waved.meta.stickers).toBe('wave (https://media.discordapp.net/stickers/1.png)')

  const poll = { ...say(here, 23, ''), ...live(here), poll: { question: { text: 'Lunch?' }, answers: new Collection([[1, { text: 'Tacos' }], [2, { text: 'Ramen' }]]), allowMultiselect: false } }
  handlers.get('messageCreate')!(poll)
  const asked = await inbound(received, line => line.meta.message_id === poll.id)
  expect(asked.content).toBe('(poll)')
  expect(asked.meta).toMatchObject({ poll: 'Lunch?', poll_options: 'Tacos; Ramen' })
  expect(asked.meta.poll_multiple).toBeUndefined()

  const thread = channel('6000', { name: 'Dark mode', type: ChannelType.PublicThread, parent: ideas, setArchived: async () => {} })
  const s = await session(thread.id)
  const post = { ...say(thread, 24, 'it hurts my eyes', { id: thread.id }), ...live(thread) }
  handlers.get('messageCreate')!(post)
  const opened = await inbound(s.received, line => line.meta.message_id === thread.id)
  expect(opened.meta).toMatchObject({ channel: 'ideas', post_title: 'Dark mode' })
  expect(opened.meta.new_thread).toBeUndefined()
})

test('a tag in an announcement channel starts a thread like in a text channel', async () => {
  const thread = channel('7000', { name: 'launch post', type: ChannelType.AnnouncementThread, parent: news })
  const s = await session(thread.id)
  const tag = { ...say(news, 25, '<@1000> launch post review'), inGuild: () => true, channel: news, mentions: { has: () => true }, react: async () => {}, startThread: async () => thread, id: thread.id }
  handlers.get('messageCreate')!(tag)
  const opened = await inbound(s.received, line => line.meta.message_id === thread.id)
  expect(opened.content).toBe('launch post review')
  expect(opened.meta).toMatchObject({ channel: 'news', new_thread: 'true' })
})

test('a vote on the bot\'s poll reaches its thread as the answer, a retracted vote says so, and other votes are dropped', async () => {
  const answers = new Collection([[1, { text: 'Tacos' }], [2, { text: 'Ramen' }]])
  const lunch = say(here, 26, '', { author: bot, poll: { question: { text: 'Lunch?' }, answers } })
  const partial = { id: lunch.id, channelId: here.id, channel: here, partial: true, fetch: async () => lunch }
  handlers.get('messagePollVoteAdd')!({ id: 2, poll: { message: partial } }, OWNER)
  const voted = await inbound(received, line => line.meta.poll_message_id === lunch.id)
  expect(voted.content).toBe('(vote: Ramen)')
  expect(voted.meta).toMatchObject({ chat_id: here.id, user: 'bassim', vote: 'Ramen', poll: 'Lunch?' })
  expect(voted.meta.vote_removed).toBeUndefined()

  handlers.get('messagePollVoteRemove')!({ id: 2, poll: { message: lunch } }, OWNER)
  expect((await inbound(received, line => line.meta.vote_removed === 'true')).content).toBe('(vote removed: Ramen)')

  const theirs = say(here, 27, '', { poll: { question: { text: 'Dinner?' }, answers } })
  handlers.get('messagePollVoteAdd')!({ id: 1, poll: { message: theirs } }, OWNER)
  handlers.get('messagePollVoteAdd')!({ id: 1, poll: { message: lunch } }, '8888')
  await Bun.sleep(100)
  expect(received.some(line => line.meta?.poll === 'Dinner?' || line.meta?.vote === 'Tacos')).toBe(false)
})

test('a DM is its own session named DM, a message reaches it while it works, and replies go back to the DM', async () => {
  const mine = await session(dm.id)
  mine.send({ type: 'state', thread: dm.id, busy: true })
  const message = { ...say(dm, 30, 'quick one'), inGuild: () => false, channel: dm, mentions: { has: () => false }, react: async () => {} }
  handlers.get('messageCreate')!(message)
  const inbound = await until(() => mine.received.find(line => line.type === 'inbound' && line.content === 'quick one'))
  expect(inbound.meta.chat_id).toBe(dm.id)
  expect(inbound.meta.channel).toBeUndefined()
  await mine.call('reply', { text: 'on it, from the DM' })
  expect(done).toContainEqual({ send: expect.objectContaining({ content: 'on it, from the DM' }), in: dm.id })
  expect((await mine.call('close_thread', {})).error).toBe('a DM is not a thread')
})

test('once connected the bot leaves the id of its server in guild.json, so the voice app can link a thread, and registers its slash commands', async () => {
  let registered: any[] = []
  handlers.get('clientReady')!({ user: { tag: 'hex#0000' }, application: { commands: { set: async (commands: any[]) => (registered = commands) } } })
  expect(JSON.parse(readFileSync(join(state, 'guild.json'), 'utf8'))).toEqual({ id: GUILD })
  await until(() => registered.length)
  expect(registered.map(command => command.name)).toEqual(['model', 'effort', 'compact', 'stop'])
})

test('a first login that fails, as with no network at boot, is tried again', async () => {
  await until(() => logins >= 2)
})

test('a permission prompt asks in the thread with Allow and Deny, a tap answers it, and one still open when the turn ends stops asking', async () => {
  const prompt = (request_id: string) => ({ request_id, tool_name: 'Bash', description: 'Run the tests', input_preview: JSON.stringify({ command: 'bun test', description: 'Run the tests' }) })
  await ask(prompt('abcde'))
  const asked = await until(() => here.posted.findLast((m: any) => m.content.startsWith('🔐')))
  expect(asked.content).toBe('🔐 **Bash**: Run the tests\n```\ncommand: bun test\n```')
  expect(asked.components[0].components.map((b: any) => [b.label, b.custom_id, b.style])).toEqual([
    ['Allow', 'perm:allow:abcde', ButtonStyle.Success],
    ['Deny', 'perm:deny:abcde', ButtonStyle.Danger],
  ])

  let update: any
  handlers.get('interactionCreate')!({ isButton: () => true, user: owner, customId: 'perm:allow:abcde', channelId: here.id, createdAt: at(41), message: asked, update: async (options: any) => (update = options) })
  expect(await until(() => received.find(line => line.type === 'permission'))).toMatchObject({ request_id: 'abcde', behavior: 'allow' })
  expect(update.components[0].toJSON().components.map((b: any) => [b.label, b.disabled, b.style])).toEqual([
    ['Allow', true, ButtonStyle.Success],
    ['Deny', true, ButtonStyle.Secondary],
  ])

  await ask(prompt('fghij'))
  const open = await until(() => here.posted.findLast((m: any) => m.content.startsWith('🔐') && m !== asked))
  send({ type: 'state', thread: here.id, busy: false })
  const moot = await until(() => done.find(d => d.edit === open.id))
  expect(labels(moot.options.components)).toEqual(['No longer waiting'])
})

test('a question with buttons goes in the ledger: a tap answers it there, and one answered in hex\'s app closes its buttons, reaches the thread, and can be taken back', async () => {
  await call('reply', { text: 'Which anchors?\nThe left ones are cheaper.', buttons: ['Left', 'Right'] })
  const asked = here.posted.at(-1)
  expect(book().asks.find((a: any) => a.message === asked.id)).toMatchObject({ thread: here.id, text: 'Which anchors?\nThe left ones are cheaper.', options: ['Left', 'Right'] })

  send({ type: 'answer', thread: here.id, message: asked.id, label: 'Right', via: 'app' })
  const answered = await inbound(received, line => line.meta.answered_in === 'in the app')
  expect(answered).toMatchObject({ content: 'Right', meta: { user: 'hex app', button: 'true', button_message_id: asked.id } })
  expect(labels(done.findLast(d => d.edit === asked.id).options.components)).toEqual(['✓ Answered in the app: Right'])
  expect(book().asks.find((a: any) => a.message === asked.id).answer).toMatchObject({ label: 'Right', via: 'app' })

  send({ type: 'reopen', thread: here.id, message: asked.id, via: 'app' })
  expect((await inbound(received, line => line.meta.took_back === 'Right')).content).toBe('(took back: Right)')
  expect(labels(done.findLast(d => d.edit === asked.id).options.components)).toEqual(['Left', 'Right'])

  handlers.get('interactionCreate')!({ isButton: () => true, user: owner, customId: '0', channelId: here.id, createdAt: at(44), message: asked, update: async () => {} })
  await until(() => book().asks.find((a: any) => a.message === asked.id).answer?.via === 'discord')

  await call('reply', { text: 'Ship today?', buttons: ['Yes', 'No'] })
  const later = here.posted.at(-1)
  send({ type: 'settle', thread: here.id, message: later.id, note: 'Settled: shipped' })
  await until(() => book().asks.find((a: any) => a.message === later.id).settled)
  expect(labels(done.findLast(d => d.edit === later.id).options.components)).toEqual(['Settled: shipped'])
})

test('buttons with multiple come as a menu, and a pick of several comes back as their labels and locks the menu on them', async () => {
  await call('reply', { text: 'Which files?', buttons: ['a.ts', 'b.ts', 'c.ts'], multiple: true })
  const asked = here.posted.at(-1)
  const select = asked.components[0].components[0]
  expect(select).toMatchObject({ type: ComponentType.StringSelect, custom_id: 'menu', min_values: 1, max_values: 3 })
  expect(book().asks.find((a: any) => a.message === asked.id)).toMatchObject({ options: ['a.ts', 'b.ts', 'c.ts'], multiple: true })

  let update: any
  handlers.get('interactionCreate')!({ isButton: () => false, isStringSelectMenu: () => true, user: owner, values: ['0', '2'], component: { options: select.options }, channelId: here.id, createdAt: at(45), message: asked, update: async (options: any) => (update = options) })
  const pick = await inbound(received, line => line.meta.button_message_id === asked.id)
  expect(pick.content).toBe('a.ts; c.ts')
  const locked = update.components[0].toJSON().components[0]
  expect(locked.disabled).toBe(true)
  expect(locked.options.filter((o: any) => o.default).map((o: any) => o.label)).toEqual(['a.ts', 'c.ts'])
})

test('an image arrives already downloaded, as image_path, next to its listing', async () => {
  const shot = { id: '62', name: 'shot.png', url: 'https://cdn.discord/shot.png', contentType: 'image/png', size: 1024 }
  const message = { ...say(here, 46, 'what is this?'), ...live(here), attachments: new Collection([[shot.id, shot]]) }
  handlers.get('messageCreate')!(message)
  const arrived = await inbound(received, line => line.meta.message_id === message.id)
  expect(arrived.meta.image_path).toMatch(/inbox\/\d+-62\.png$/)
  expect(readFileSync(arrived.meta.image_path, 'utf8')).toBe('png bytes')
  expect(arrived.meta.attachments).toBe('shot.png (image/png, 1KB)')
})

test('new_thread opens with the request that asked for it and the replies since, forwarded', async () => {
  const desk = channel('5100', { name: 'desk', type: ChannelType.PublicThread, parent: general })
  const s = await session(desk.id)
  say(desk, 31, 'earlier chatter')
  say(desk, 32, 'old answer', { author: bot })
  const asked = say(desk, 33, 'spin off the anchors work')
  const reply = say(desk, 34, 'on it', { author: bot })
  s.send({ type: 'state', thread: desk.id, busy: true })
  await Bun.sleep(50)
  const result = await s.call('new_thread', { title: 'Anchors', prompt: 'work on the anchors', about: 'Spun off from desk' })
  s.send({ type: 'state', thread: desk.id, busy: false })
  const thread = [...channels.values()].find(ch => ch.name === 'Anchors')!
  expect(result.text).toBe(`started thread "Anchors": https://discord.com/channels/${GUILD}/${thread.id}`)
  expect(done.find(d => d.create === 'Anchors')).toEqual({ create: 'Anchors', in: general.id })
  expect(thread.posted[0].content).toBe('Spun off from desk')
  expect(done.filter(d => d.forward && d.to === thread.id).map(d => d.forward)).toEqual([asked.id, reply.id])
})

test('new_thread in a forum opens a post with its tags, and fetch_messages lists a forum\'s posts', async () => {
  ideas.availableTags = [{ id: 't1', name: 'Bug' }, { id: 't2', name: 'Idea' }]
  await call('new_thread', { title: 'Glare', prompt: 'look into the glare', about: 'Glare on the desk', channel: 'ideas', tags: ['idea'] })
  expect(done.find(d => d.create === 'Glare')).toEqual({ create: 'Glare', in: ideas.id, message: 'Glare on the desk', appliedTags: ['t2'] })
  expect((await call('new_thread', { title: 'Nope', prompt: 'x', about: 'x', channel: 'ideas', tags: ['urgent'] })).error).toBe('#ideas has the tags Bug, Idea')
  const post = [...channels.values()].find(ch => ch.name === 'Glare')!
  expect((await call('fetch_messages', { channel: 'ideas' })).text).toContain(`Glare  (post ${post.id}, 0 replies)`)
})

test('new_thread with another app opens the thread there through the hub', async () => {
  const opened: any[] = []
  clients.set('buzz', { hub: { open: (...args: any[]) => opened.push(args) } as any, place: async (name, where, about) => (opened.push(['place', name, where, about]), { thread: 'b1', link: 'buzz://b1' }) })
  expect((await call('new_thread', { title: 'Relay', prompt: 'fix the relay', about: 'From Discord', app: 'buzz' })).text).toBe('started thread "Relay" in buzz: buzz://b1')
  expect(opened).toEqual([['place', 'Relay', undefined, 'From Discord'], ['b1', 'Relay', 'fix the relay', undefined]])
  clients.delete('buzz')
  expect((await call('new_thread', { title: 'Relay', prompt: 'x', about: 'x', app: 'buzz' })).error).toBe("buzz isn't connected; threads open in discord")
})

test('slash commands set a thread\'s model and effort, and answer only the owner in a thread with a session', async () => {
  const desk = channels.get('5100')!
  const replies: any[] = []
  const command = (commandName: string, value?: string, user = owner, channelId = desk.id) =>
    handlers.get('interactionCreate')!({ isButton: () => false, isStringSelectMenu: () => false, isChatInputCommand: () => true, commandName, user, channelId, options: { getString: () => value }, reply: async (options: any) => replies.push(options) })
  command('model', 'claude-opus-5-5')
  command('effort', 'max')
  command('stop', undefined, owner, general.id)
  command('stop', undefined, { id: '8888', username: 'someone', partial: false })
  await until(() => replies.length === 4)
  expect(replies.map(reply => reply.content)).toEqual([
    "Model: Opus 5.5, from this thread's next message.",
    "Effort: Max, from this thread's next message.",
    "This channel has no session: use it in one of hex's threads or the DM.",
    'hex only answers its owner.',
  ])
  expect(replies.every(reply => reply.flags === MessageFlags.Ephemeral)).toBe(true)
  expect(JSON.parse(readFileSync(join(state, 'threads.json'), 'utf8'))[desk.id]).toMatchObject({ model: 'claude-opus-5-5', effort: 'max' })
})
