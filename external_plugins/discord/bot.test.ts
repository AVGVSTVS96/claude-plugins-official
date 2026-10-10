import { beforeAll, expect, mock, test } from 'bun:test'
import { connect } from 'net'
import { mkdirSync, mkdtempSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import * as discord from 'discord.js'

const { ChannelType, Collection, MessageType, SnowflakeUtil } = discord
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
    permissionsFor: () => ({ has: () => ch.visible }),
    sendTyping: async () => {},
    send: async (options: Channel) => {
      done.push({ send: options, in: id })
      return say(ch, 59, options.content ?? '', { author: bot, components: options.components?.map((row: any) => row.toJSON()) })
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
channel('4003', { name: 'dm', type: ChannelType.DM, guildId: undefined })
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
  login = async () => 'token'
}

mock.module('discord.js', () => ({ ...discord, Client }))

const state = mkdtempSync(join(tmpdir(), 'discord-'))
let received: any[]
let call: (tool: string, args: object) => Promise<any>

async function until<T>(check: () => T | undefined, timeout = 3000): Promise<T> {
  for (const end = Date.now() + timeout; Date.now() < end; await Bun.sleep(20)) {
    const value = check()
    if (value) return value
  }
  throw new Error('timed out')
}

beforeAll(async () => {
  writeFileSync(join(state, 'access.json'), JSON.stringify({ allowFrom: [OWNER] }))
  Object.assign(process.env, { DISCORD_STATE_DIR: state, DISCORD_BOT_TOKEN: 'token', HEX_LAUNCHER: 'false' })
  await import('./bot.ts')
  ;({ received, call } = await session(here.id))
})

// A session bound to thread, connected once the hub has registered it.
async function session(thread: string) {
  const socket = connect(join(state, 'hub.sock'))
  const received: any[] = []
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
  const send = (payload: object) => socket.write(JSON.stringify(payload) + '\n')
  send({ type: 'hello', thread, session: crypto.randomUUID() })
  const call = (tool: string, args: object): Promise<any> => {
    const id = ++next
    send({ type: 'call', id, tool, args })
    return until(() => received.find(line => line.type === 'result' && line.id === id))
  }
  await call('list_channels', {})
  return { received, call }
}

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

  const forward = { ...say(here, 9, ''), ...live(here), messageSnapshots: new Collection([['1', { content: 'ship it friday', attachments: new Collection(), stickers: new Collection() }]]) }
  handlers.get('messageCreate')!(forward)
  const forwarded = await inbound(forward.id)
  expect(forwarded.content).toBe('ship it friday')
  expect(forwarded.meta.forwarded).toBe('true')
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
  expect((await call('fetch_messages', { channel: 'nowhere' })).error).toBe('no text channel named #nowhere')
  expect((await call('fetch_messages', { thread: '4003' })).error).toBe(refused('4003'))
  expect((await call('fetch_messages', { thread: elsewhere.id })).error).toBe(refused(elsewhere.id))
})

test('list_channels names the text and announcement channels the bot can read', async () => {
  expect((await call('list_channels', {})).text).toBe(`#open-source  (id: ${openSource.id})\n#general  (id: ${general.id})\n#news  (id: ${news.id})`)
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
