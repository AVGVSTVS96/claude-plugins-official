import { beforeAll, expect, mock, test } from 'bun:test'
import { connect } from 'net'
import { mkdtempSync, writeFileSync } from 'fs'
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

// A guild channel or thread whose messages the fake REST answers newest-first, as Discord does.
function channel(id: string, fields: Channel): Channel {
  const messages: Channel[] = []
  const ch: Channel = {
    id,
    guildId: GUILD,
    visible: true,
    archived: false,
    parent: null,
    isThread: () => ch.type === ChannelType.PublicThread,
    permissionsFor: () => ({ has: () => ch.visible }),
    sendTyping: async () => {},
    posted: messages,
    messages: {
      fetch: async ({ limit, before }: { limit: number; before?: string }) => new Collection(messages
        .filter(m => !before || BigInt(m.id) < BigInt(before))
        .sort((a, b) => Number(BigInt(b.id) - BigInt(a.id)))
        .slice(0, limit)
        .map(m => [m.id, m])),
    },
    ...fields,
  }
  channels.set(id, ch)
  return ch
}

function say(where: Channel, minute: number, content: string, thread?: Channel) {
  const id = snowflake(minute)
  const message = { id, content, createdAt: at(minute), author: { id: OWNER, username: 'bassim', bot: false }, attachments: new Collection(), messageSnapshots: new Collection(), thread: thread ?? null }
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
const here = channel('5000', { name: 'desk anchors', type: ChannelType.PublicThread, parent: general })

class Client {
  user = { id: BOT, tag: 'hex#0000' }
  channels = {
    fetch: async (id: string) => {
      if (!channels.has(id)) throw new Error('Unknown Channel')
      return channels.get(id)
    },
  }
  guilds = { cache: new Collection([[GUILD, { id: GUILD, systemChannel: general, channels: { fetch: async () => new Collection([...channels].filter(([, ch]) => ch.guildId === GUILD && !ch.isThread())) } }]]) }
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
const received: any[] = []
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
  const send = (payload: object) => socket.write(JSON.stringify(payload) + '\n')
  send({ type: 'hello', thread: here.id, session: '0a1b2c3d-0000-4000-8000-000000000000' })
  call = (tool, args) => {
    const id = ++next
    send({ type: 'call', id, tool, args })
    return until(() => received.find(line => line.type === 'result' && line.id === id))
  }
})

test('a message in a thread names the channel the thread is in', async () => {
  const message = { ...say(here, 6, 'what did we decide in open-source?'), inGuild: () => true, channel: here, mentions: { has: () => false }, react: async () => {} }
  handlers.get('messageCreate')!(message)
  const inbound = await until(() => received.find(line => line.type === 'inbound'))
  expect(inbound.meta).toMatchObject({ chat_id: here.id, message_id: message.id, channel: 'general' })
})

test('a reply says which message it answers, an edit comes back marked edited, and a forward carries what was forwarded', async () => {
  const live = { inGuild: () => true, channel: here, mentions: { has: () => false }, react: async () => {} }
  const inbound = (id: string, edited?: string) => until(() => received.find(line => line.type === 'inbound' && line.meta.message_id === id && line.meta.edited === edited))
  const asked = say(here, 7, 'which anchors?')
  const reply = { ...say(here, 8, 'the left ones'), ...live, type: MessageType.Reply, reference: { messageId: asked.id }, fetchReference: async () => asked }
  handlers.get('messageCreate')!(reply)
  expect((await inbound(reply.id)).meta).toMatchObject({ reply_to_message_id: asked.id, reply_to_user: 'bassim', reply_to_text: 'which anchors?' })

  handlers.get('messageUpdate')!({ ...reply, partial: false }, { ...reply, content: 'the right ones' })
  const edit = await inbound(reply.id, 'true')
  expect(edit.content).toBe('the right ones')
  expect(edit.meta.new_thread).toBeUndefined()

  const forward = { ...say(here, 9, ''), ...live, messageSnapshots: new Collection([['1', { content: 'ship it friday', attachments: new Collection() }]]) }
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

test('list_channels names the text channels the bot can read', async () => {
  expect((await call('list_channels', {})).text).toBe(`#open-source  (id: ${openSource.id})\n#general  (id: ${general.id})`)
})
