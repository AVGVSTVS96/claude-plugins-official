import { afterAll, afterEach, expect, test } from 'bun:test'
import type { ServerWebSocket, Subprocess } from 'bun'
import { connect, type Socket } from 'net'
import { createHash } from 'crypto'
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, chmodSync, existsSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { generateSecretKey, getPublicKey, finalizeEvent, verifyEvent, type Event } from 'nostr-tools/pure'
import { matchFilter, matchFilters, type Filter } from 'nostr-tools/filter'
import { bytesToHex } from 'nostr-tools/utils'
import { schnorr } from '@noble/curves/secp256k1.js'
import { connectRelay } from './relay.ts'

type Peer = { challenge: string; pubkey?: string; subs: Map<string, Filter[]> }

// A NIP-01/42 relay small enough to read: AUTH first, then REQ/EOSE/CLOSE and EVENT fan-out,
// NIP-50 search as a substring match, and Buzz's NIP-98 /query channel window (NIP-CW).
function fakeRelay() {
  const events: Event[] = []
  const frames: unknown[][] = []
  const peers = new Set<ServerWebSocket<Peer>>()
  const downloads: string[] = []
  const relayKey = generateSecretKey()
  const isReply = (event: Event) => event.tags.some(t => t[0] === 'e' && t[3] === 'reply')

  function stored(filters: Filter[]) {
    return filters.flatMap(filter => events
      .filter(event => matchFilter(filter, event) && (!filter.search || event.content.toLowerCase().includes(filter.search.toLowerCase())))
      .sort((a, b) => b.created_at - a.created_at)
      .slice(0, filter.limit))
  }

  async function query(request: Request) {
    const body = await request.text()
    const auth: Event = JSON.parse(Buffer.from(request.headers.get('authorization')!.replace(/^Nostr /, ''), 'base64').toString())
    const tag = (name: string) => auth.tags.find(t => t[0] === name)?.[1]
    const signedFor = tag('u') === request.url && tag('method') === 'POST' && tag('payload') === createHash('sha256').update(body).digest('hex')
    if (!verifyEvent(auth) || auth.kind !== 27235 || !signedFor || JSON.parse(request.headers.get('x-auth-tag') ?? '[]')[1] !== owner) return new Response('bad auth', { status: 401 })
    const [filter] = JSON.parse(body)
    const channel = filter['#h'][0]
    const rows = events
      .filter(event => matchFilter({ kinds: filter.kinds, '#h': [channel] }, event) && !isReply(event))
      .sort((a, b) => b.created_at - a.created_at || a.id.localeCompare(b.id))
      .filter(event => !filter.before_id || event.created_at < filter.until || (event.created_at === filter.until && event.id > filter.before_id))
      .slice(0, filter.limit)
    const summaries = rows.flatMap(row => {
      const replies = events.filter(event => event.tags.some(t => t[0] === 'e' && t[1] === row.id))
      const summary = { reply_count: replies.length, descendant_count: replies.length, last_reply_at: Math.max(...replies.map(reply => reply.created_at)) }
      return replies.length > 0 ? [signed(relayKey, 39005, JSON.stringify(summary), [['e', row.id], ['d', row.id], ['h', channel]])] : []
    })
    return Response.json([...rows, ...summaries, signed(relayKey, 39006, '{"has_more":false,"next_cursor":null}', [['d', `${channel}:head`], ['h', channel]])])
  }

  const server = Bun.serve<Peer, {}>({
    port: 0,
    fetch(request, server) {
      if (new URL(request.url).pathname === '/query') return query(request)
      if (new URL(request.url).pathname.startsWith('/media/')) {
        downloads.push(request.headers.get('authorization') ?? '')
        return new Response('pixels')
      }
      return server.upgrade(request, { data: { challenge: crypto.randomUUID(), subs: new Map() } }) ? undefined : new Response('relay')
    },
    websocket: {
      open(ws) {
        peers.add(ws)
        ws.send(JSON.stringify(['AUTH', ws.data.challenge]))
      },
      close(ws) {
        peers.delete(ws)
      },
      message(ws, raw) {
        const frame = JSON.parse(String(raw))
        frames.push(frame)
        const [type, ...rest] = frame
        const reply = (...message: unknown[]) => ws.send(JSON.stringify(message))
        if (type === 'AUTH') {
          const event: Event = rest[0]
          const tag = (name: string) => event.tags.find(t => t[0] === name)
          const ok = verifyEvent(event) && event.kind === 22242 && tag('challenge')?.[1] === ws.data.challenge && tag('auth')?.[1] === owner
          if (ok) ws.data.pubkey = event.pubkey
          return reply('OK', event.id, ok, ok ? '' : 'auth-required: bad auth')
        }
        if (!ws.data.pubkey) return reply('CLOSED', rest[0], 'auth-required: authenticate first')
        if (type === 'REQ') {
          const [id, ...filters] = rest
          ws.data.subs.set(id, filters)
          for (const event of stored(filters)) reply('EVENT', id, event)
          return reply('EOSE', id)
        }
        if (type === 'CLOSE') return void ws.data.subs.delete(rest[0])
        if (type === 'EVENT') {
          const event: Event = rest[0]
          reply('OK', event.id, verifyEvent(event), '')
          inject(event)
        }
      },
    },
  })
  function inject(event: Event) {
    events.push(event)
    for (const peer of peers) {
      for (const [id, filters] of peer.data.subs) if (matchFilters(filters, event)) peer.send(JSON.stringify(['EVENT', id, event]))
    }
  }
  return {
    url: `ws://localhost:${server.port}`,
    events,
    frames,
    downloads,
    inject,
    drop: () => peers.forEach(peer => peer.terminate()),
    stop: () => server.stop(true),
  }
}

const ownerKey = generateSecretKey()
const owner = getPublicKey(ownerKey)
const authTag = ['auth', owner, '', 'sig']
const relay = fakeRelay()

afterAll(() => relay.stop())

async function until<T>(check: () => T | undefined, timeout = 3000): Promise<T> {
  for (const end = Date.now() + timeout; Date.now() < end; await Bun.sleep(20)) {
    const value = check()
    if (value) return value
  }
  throw new Error('timed out')
}

function signed(key: Uint8Array, kind: number, content: string, tags: string[][] = [], at = Math.floor(Date.now() / 1000)) {
  return finalizeEvent({ kind, content, tags, created_at: at }, key)
}

const iso = (seconds: number) => new Date(seconds * 1000).toISOString()

test('the relay connection authenticates with the auth tag before it asks for anything', async () => {
  const key = generateSecretKey()
  const client = connectRelay({ url: relay.url, secretKey: key, authTag })
  const event = await client.publish({ kind: 9, content: 'hi', tags: [['h', 'c1']] })
  const auth = relay.frames.find(([type, event]: any[]) => type === 'AUTH' && event.pubkey === getPublicKey(key))![1] as Event
  expect(auth.tags).toContainEqual(authTag)
  expect(auth.tags).toContainEqual(['relay', relay.url])
  expect(relay.frames.indexOf(relay.frames.find(([, sent]: any[]) => sent === auth)!)).toBeLessThan(relay.frames.findIndex(([type, sent]: any[]) => type === 'EVENT' && sent.id === event.id))
  expect(event.tags).toEqual([['h', 'c1'], authTag])
  expect(event.pubkey).toBe(getPublicKey(key))
  client.close()
})

test('a refused publish rejects with the relay\'s reason, and a query resolves at EOSE', async () => {
  const client = connectRelay({ url: relay.url, secretKey: generateSecretKey(), authTag })
  const sent = await client.publish({ kind: 9, content: 'find me', tags: [['h', 'c2']] })
  expect((await client.query([{ kinds: [9], '#h': ['c2'] }])).map(event => event.id)).toEqual([sent.id])
  client.close()
  await expect(client.publish({ kind: 9, content: 'late', tags: [] })).rejects.toThrow('closed')
})

test('after a drop it reconnects, authenticates again, resubscribes from shortly before, and delivers each event once', async () => {
  const client = connectRelay({ url: relay.url, secretKey: generateSecretKey(), authTag })
  const seen: string[] = []
  const since = Math.floor(Date.now() / 1000)
  client.subscribe([{ kinds: [9], '#h': ['c3'], since }], event => seen.push(event.content))
  relay.inject(signed(ownerKey, 9, 'one', [['h', 'c3']]))
  await until(() => seen.length === 1)
  const reqs = () => relay.frames.filter(([type, , filter]: any[]) => type === 'REQ' && filter['#h']?.[0] === 'c3')
  relay.drop()
  relay.inject(signed(ownerKey, 9, 'two', [['h', 'c3']]))
  await until(() => seen.length === 2, 5000)
  expect(reqs().length).toBe(2)
  expect((reqs()[1]![2] as Filter).since).toBeGreaterThanOrEqual(since)
  expect(seen).toEqual(['one', 'two'])
  client.close()
})

const SESSION = '0a1b2c3d-0000-4000-8000-000000000000'
const running: { bot: Subprocess; relay: ReturnType<typeof fakeRelay>; sockets: Socket[] }[] = []

afterEach(() => {
  for (const { bot, relay, sockets } of running.splice(0)) {
    bot.kill(9)
    sockets.forEach(socket => socket.destroy())
    relay.stop()
  }
})

// Runs bot.ts the way the hub service does, against its own fake relay, with
// a fake `claude` that records its calls and a channel and a DM Hex is in.
async function startBot() {
  const dir = mkdtempSync(join(tmpdir(), 'buzz-'))
  const state = join(dir, 'state')
  mkdirSync(state)
  mkdirSync(join(dir, 'hex'))
  mkdirSync(join(dir, 'config', 'jobs', 'job12345'), { recursive: true })
  writeFileSync(join(dir, 'claude'), `#!/bin/sh
jq -cn '$ARGS.positional' --args -- "$@" >> "${dir}/calls"
[ "$1" = "--bg" ] && echo "backgrounded · job12345 · test"
exit 0
`)
  chmodSync(join(dir, 'claude'), 0o755)

  const relay = fakeRelay()
  const key = generateSecretKey()
  const me = getPublicKey(key)
  const sig = schnorr.sign(createHash('sha256').update(`nostr:agent-auth:${me}:`).digest(), ownerKey)
  const auth = ['auth', owner, '', bytesToHex(sig)]
  writeFileSync(join(state, '.env'), `BUZZ_RELAY_URL=${relay.url}\nBUZZ_PRIVATE_KEY=${bytesToHex(key)}\nBUZZ_AUTH_TAG=${JSON.stringify(auth)}\n`)
  writeFileSync(join(state, 'access.json'), JSON.stringify({ panels: false }))

  const channel = crypto.randomUUID()
  const openSource = crypto.randomUUID()
  const secret = crypto.randomUUID()
  const dm = crypto.randomUUID()
  const host = generateSecretKey()
  relay.inject(signed(key, 0, JSON.stringify({ name: 'Hex' })))
  relay.inject(signed(ownerKey, 0, JSON.stringify({ display_name: 'Bassim' })))
  for (const id of [channel, openSource, dm]) relay.inject(signed(host, 39002, '', [['d', id], ['p', owner], ['p', me]]))
  relay.inject(signed(host, 39002, '', [['d', secret], ['p', owner]]))
  relay.inject(signed(host, 39000, '', [['d', channel], ['name', 'general'], ['t', 'stream']]))
  relay.inject(signed(host, 39000, '', [['d', openSource], ['name', 'open-source'], ['t', 'stream']]))
  relay.inject(signed(host, 39000, '', [['d', secret], ['name', 'secret'], ['t', 'stream']]))
  relay.inject(signed(host, 39000, '', [['d', dm], ['name', 'dm'], ['hidden'], ['t', 'dm']]))

  const env = Object.fromEntries(Object.entries(process.env).filter(([name]) => !/^(BUZZ_|HEX_|TELEGRAM_|DISCORD_)/.test(name)))
  const bot = Bun.spawn(['bun', join(import.meta.dir, 'bot.ts')], {
    env: { ...env, BUZZ_STATE_DIR: state, HEX_DIR: join(dir, 'hex'), CLAUDE_CONFIG_DIR: join(dir, 'config'), PATH: `${dir}:${process.env.PATH}` },
    stdout: 'ignore',
    stderr: 'ignore',
  })
  const sockets: Socket[] = []
  running.push({ bot, relay, sockets })
  await until(() => relay.frames.some(([type, , filter]: any[]) => type === 'REQ' && filter['#h']?.includes(dm)))

  const published = (kind: number) => relay.events.filter(event => event.kind === kind && event.pubkey === me)
  const calls = (): string[][] => existsSync(join(dir, 'calls')) ? readFileSync(join(dir, 'calls'), 'utf8').split('\n').slice(0, -1).map(line => JSON.parse(line)) : []

  async function session(thread: string) {
    const socket = connect(join(state, 'hub.sock'))
    sockets.push(socket)
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
    send({ type: 'hello', thread, session: SESSION })
    return {
      send,
      inbound: (count: number) => until(() => received.filter(line => line.type === 'inbound')[count - 1] && received.filter(line => line.type === 'inbound')),
      call: (tool: string, args: object) => {
        const id = ++next
        send({ type: 'call', id, tool, args })
        return until(() => received.find(line => line.type === 'result' && line.id === id))
      },
    }
  }

  return {
    me,
    key,
    auth,
    channel,
    openSource,
    secret,
    dm,
    relay,
    published,
    calls,
    launches: () => calls().filter(args => args[0] === '--bg'),
    session,
    say: (content: string, tags: string[][] = [], from = ownerKey, where = channel, at?: number) => {
      const event = signed(from, 9, content, [['h', where], ...tags], at)
      relay.inject(event)
      return event
    },
  }
}

async function threadStarted(bot: Awaited<ReturnType<typeof startBot>>) {
  const root = bot.say('@Hex desk anchors are loose', [['p', bot.me]])
  await until(() => bot.launches()[0])
  const session = await bot.session(root.id)
  await session.inbound(1)
  return { root, session }
}

test('Hex goes online, and a tag in a channel starts a thread on that message, named by its first words', async () => {
  const bot = await startBot()
  expect((await until(() => bot.published(20001)[0])).content).toBe('online')
  const root = bot.say('@Hex desk anchors are loose', [['p', bot.me]])
  const args = await until(() => bot.launches()[0])
  expect(args.slice(0, 5)).toEqual(['--bg', '--channels', 'plugin:buzz@hex', '--name', 'desk anchors'])
  const [inbound] = await (await bot.session(root.id)).inbound(1)
  expect(inbound.content).toBe('desk anchors are loose')
  expect(inbound.meta).toMatchObject({ chat_id: root.id, message_id: root.id, user: 'Bassim', user_id: owner, channel: 'general', new_thread: 'true' })
  const ack = await until(() => bot.published(7).find(event => event.content === '👀'))
  expect(ack.tags).toEqual([['e', root.id], bot.auth])
})

test('in a thread Hex runs no tag is needed, and other messages, strangers and its own are ignored', async () => {
  const bot = await startBot()
  const { root, session } = await threadStarted(bot)
  const inThread = [['e', root.id, '', 'reply']]
  bot.say('lunch anyone?')
  bot.say('@Hex let me in', [['p', bot.me]], generateSecretKey())
  bot.say('@Hex sneaking in', inThread, generateSecretKey())
  bot.say('my own words', inThread, bot.key)
  bot.say('the left one mostly', inThread)
  const inbound = await session.inbound(2)
  expect(inbound.map(line => line.content)).toEqual(['desk anchors are loose', 'the left one mostly'])
  expect(inbound[1].meta.new_thread).toBeUndefined()
  expect(bot.launches().length).toBe(1)
})

test('a direct message reaches the DM\'s own thread without a tag', async () => {
  const bot = await startBot()
  const sent = bot.say('are you there?', [], ownerKey, bot.dm)
  const args = await until(() => bot.launches()[0])
  expect(args[args.indexOf('--name') + 1]).toBe('Bassim')
  const [inbound] = await (await bot.session(bot.dm)).inbound(1)
  expect(inbound.content).toBe('are you there?')
  expect(inbound.meta).toMatchObject({ chat_id: bot.dm, message_id: sent.id })
  expect(inbound.meta.new_thread).toBeUndefined()
})

test('a reply to one message in a thread says which, with its text; one to the thread head says nothing', async () => {
  const bot = await startBot()
  const { root, session } = await threadStarted(bot)
  const shelf = bot.say('the shelf too', [['e', root.id, '', 'reply']])
  bot.say('both of them', [['e', root.id, '', 'root'], ['e', shelf.id, '', 'reply']])
  const inbound = await session.inbound(3)
  expect(inbound[1].meta.reply_to_message_id).toBeUndefined()
  expect(inbound[2].meta).toMatchObject({ reply_to_message_id: shelf.id, reply_to_user: 'Bassim', reply_to_text: 'the shelf too' })
})

test('an edit reaches the thread as the edited message\'s new text', async () => {
  const bot = await startBot()
  const { root, session } = await threadStarted(bot)
  const typo = bot.say('the lfet one', [['e', root.id, '', 'reply']])
  await session.inbound(2)
  bot.relay.inject(signed(ownerKey, 40003, 'the left one', [['h', bot.channel], ['e', typo.id]]))
  const inbound = await session.inbound(3)
  expect(inbound[2].content).toBe('the left one')
  expect(inbound[2].meta).toMatchObject({ message_id: typo.id, edited: 'true' })
  expect(inbound[2].meta.new_thread).toBeUndefined()
})

test('reply posts into the thread with NIP-10 markers, a p tag for the owner and the auth tag', async () => {
  const bot = await startBot()
  const { root, session } = await threadStarted(bot)
  const later = bot.say('and the shelf', [['e', root.id, '', 'reply']])
  await session.inbound(2)
  const sentBy = (result: any) => bot.relay.events.find(event => event.id === result.text.match(/^sent \(id: ([0-9a-f]{64})\)$/)?.[1])!
  const direct = sentBy(await session.call('reply', { text: 'on it' }))
  expect(direct).toMatchObject({ kind: 9, content: 'on it', tags: [['h', bot.channel], ['e', root.id, '', 'reply'], ['p', owner], bot.auth] })
  const nested = sentBy(await session.call('reply', { text: 'that one too', reply_to: later.id }))
  expect(nested.tags).toEqual([['h', bot.channel], ['e', root.id, '', 'root'], ['e', later.id, '', 'reply'], ['p', owner], bot.auth])
})

test('an edit keeps the message\'s attachments, since Desktop shows the edit\'s in their place', async () => {
  const bot = await startBot()
  const { root, session } = await threadStarted(bot)
  const url = `http://localhost/media/${'a'.repeat(64)}.png`
  const imeta = ['imeta', `url ${url}`, 'm image/png', `x ${'a'.repeat(64)}`, 'size 10']
  const original = bot.say(`here it is\n![image](${url})`, [['e', root.id, '', 'reply'], imeta], bot.key)
  const result = await session.call('edit_message', { message_id: original.id, text: 'here it is, fixed' })
  const edit = bot.relay.events.find(event => event.id === result.text.match(/^edited \(id: (\w+)\)$/)?.[1])!
  expect(edit).toMatchObject({ kind: 40003, content: `here it is, fixed\n![image](${url})`, tags: [['h', bot.channel], ['e', original.id], imeta, bot.auth] })
})

test('a busy thread shows typing, and going idle takes back the acks', async () => {
  const bot = await startBot()
  const { root, session } = await threadStarted(bot)
  await until(() => bot.published(7).find(event => event.content === '💬'))
  session.send({ type: 'state', thread: root.id, busy: false })
  const acks = bot.published(7).map(event => event.id).sort()
  await until(() => bot.published(5).length === acks.length)
  expect(bot.published(5).map(event => event.tags[0]![1]).sort()).toEqual(acks)
  const before = bot.published(20002).length
  session.send({ type: 'state', thread: root.id, busy: true })
  const typing = await until(() => bot.published(20002)[before])
  expect(typing.content).toBe('')
  expect(typing.tags).toEqual([['h', bot.channel], ['e', root.id, '', 'reply'], bot.auth])
})

test('!cancel from the owner stops the thread\'s session', async () => {
  const bot = await startBot()
  const { root, session } = await threadStarted(bot)
  bot.say('!cancel', [['e', root.id, '', 'reply'], ['p', bot.me]])
  expect(await until(() => bot.calls().find(args => args[0] === 'stop'))).toEqual(['stop', SESSION.slice(0, 8)])
  expect((await session.inbound(1)).length).toBe(1)
})

test('!shutdown from the owner takes Hex offline, and nothing reaches it after', async () => {
  const bot = await startBot()
  bot.say('!shutdown', [['p', bot.me]])
  expect((await until(() => bot.published(20001).find(event => event.content === 'offline'))).content).toBe('offline')
  bot.say('@Hex still there?', [['p', bot.me]])
  await Bun.sleep(300)
  expect(bot.launches()).toEqual([])
  expect(bot.published(7)).toEqual([])
})

test('new_thread opens a thread in Buzz, starts its session with the prompt, and links to it', async () => {
  const bot = await startBot()
  const { session } = await threadStarted(bot)
  const result = await session.call('new_thread', { title: 'Desk anchors', prompt: 'find better anchors' })
  const root = await until(() => bot.published(9).find(event => event.content === '**Desk anchors**'))
  expect(root.tags).toEqual([['h', bot.channel], ['p', owner], bot.auth])
  expect(result.text).toBe(`started thread "Desk anchors": buzz://message?channel=${bot.channel}&id=${root.id}`)
  const args = await until(() => bot.launches()[1])
  expect(args[args.indexOf('--name') + 1]).toBe('Desk anchors')
  expect(args.at(-1)).toBe('find better anchors')
})

test('download_attachment saves a message\'s files to the inbox, fetched with Blossom auth', async () => {
  const bot = await startBot()
  const { root, session } = await threadStarted(bot)
  const url = `${bot.relay.url.replace(/^ws/, 'http')}/media/${'b'.repeat(64)}.png`
  const sent = bot.say('a picture', [['e', root.id, '', 'reply'], ['imeta', `url ${url}`, 'm image/png', 'size 6', 'filename desk.png']])
  const result = await session.call('download_attachment', { message_id: sent.id })
  const path = result.text.match(/^ {2}(\S+) {2}\(desk\.png, image\/png, 0KB\)$/m)?.[1]
  expect(readFileSync(path!, 'utf8')).toBe('pixels')
  expect(bot.relay.downloads).toEqual([expect.stringMatching(/^Nostr /)])
})

// A channel with two threads' worth of PR work, posted by the owner a second apart.
function seedOpenSource(bot: Awaited<ReturnType<typeof startBot>>) {
  const t = Math.floor(Date.now() / 1000) - 100
  const at = (offset: number, content: string, tags: string[][] = []) => bot.say(content, tags, ownerKey, bot.openSource, t + offset)
  const ci = at(0, 'flaky CI on the relay PR')
  const docs = at(1, 'merged the docs fix')
  const rebased = at(2, 'rebased it', [['e', ci.id, '', 'reply']])
  const pushed = at(3, 'rebased again\nand pushed', [['e', ci.id, '', 'reply']])
  const release = at(4, 'release tomorrow')
  return { t, ci, docs, rebased, pushed, release }
}

test('fetch_messages reads a channel\'s top-level messages oldest-first, with each thread\'s replies, and pages back', async () => {
  const bot = await startBot()
  const { session } = await threadStarted(bot)
  const { t, ci, docs, release } = seedOpenSource(bot)
  const page = await session.call('fetch_messages', { channel: '#open-source', limit: 2 })
  expect(page.text).toBe([
    `[${iso(t + 1)}] Bassim: merged the docs fix  (id: ${docs.id})`,
    `[${iso(t + 4)}] Bassim: release tomorrow  (id: ${release.id})`,
  ].join('\n'))
  const older = await session.call('fetch_messages', { channel: bot.openSource, before: docs.id })
  expect(older.text).toBe(`[${iso(t)}] Bassim: flaky CI on the relay PR  (id: ${ci.id}, 2 replies, last reply ${iso(t + 3)})`)
})

test('fetch_messages drills into any thread in a channel by its message id, and pages back through it', async () => {
  const bot = await startBot()
  const { session } = await threadStarted(bot)
  const { t, ci, rebased, pushed } = seedOpenSource(bot)
  const thread = await session.call('fetch_messages', { thread: ci.id })
  expect(thread.text).toBe([
    `[${iso(t)}] Bassim: flaky CI on the relay PR  (id: ${ci.id})`,
    `[${iso(t + 2)}] Bassim: rebased it  (id: ${rebased.id})`,
    `[${iso(t + 3)}] Bassim: rebased again ⏎ and pushed  (id: ${pushed.id})`,
  ].join('\n'))
  const back = await session.call('fetch_messages', { thread: ci.id, before: pushed.id, limit: 1 })
  expect(back.text).toBe(`[${iso(t + 2)}] Bassim: rebased it  (id: ${rebased.id})`)
})

test('sessions read only channels Hex is in, and no direct message but their own', async () => {
  const bot = await startBot()
  const { session } = await threadStarted(bot)
  const hidden = bot.say('secret plans', [], ownerKey, bot.secret)
  bot.say('just between us', [], ownerKey, bot.dm)
  expect((await session.call('fetch_messages', { channel: 'secret' })).error).toBe('Hex is in no channel named #secret')
  expect((await session.call('fetch_messages', { channel: bot.secret })).error).toBe('Hex is in no channel named #' + bot.secret)
  expect((await session.call('fetch_messages', { thread: hidden.id })).error).toBe('Hex isn\'t in that channel; list_channels shows the ones it is in')
  expect((await session.call('fetch_messages', { channel: bot.dm })).error).toBe('that is a direct message with someone else')
  expect((await session.call('search_messages', { query: 'secret', channel: 'secret' })).error).toBe('Hex is in no channel named #secret')
  const own = await bot.session(bot.dm)
  expect((await own.call('fetch_messages', { channel: bot.dm })).text).toContain('Bassim: just between us')
})

test('search_messages finds words in Hex\'s channels, naming each hit\'s channel and thread, and nothing it can\'t read', async () => {
  const bot = await startBot()
  const { root, session } = await threadStarted(bot)
  const { ci } = seedOpenSource(bot)
  const reply = bot.say('the flaky test is back', [['e', root.id, '', 'reply']])
  bot.say('flaky secrets', [], ownerKey, bot.secret)
  bot.say('flaky in private', [], ownerKey, bot.dm)
  const hits = (await session.call('search_messages', { query: 'FLAKY' })).text.split('\n')
  expect(hits).toEqual([
    expect.stringMatching(new RegExp(`Bassim: the flaky test is back  \\(id: ${reply.id}, in #general, thread ${root.id}\\)$`)),
    expect.stringMatching(new RegExp(`Bassim: flaky CI on the relay PR  \\(id: ${ci.id}, in #open-source\\)$`)),
  ])
  const scoped = await session.call('search_messages', { query: 'flaky', channel: 'open-source' })
  expect(scoped.text).toContain(ci.id)
  expect(scoped.text).not.toContain(reply.id)
})

test('list_channels names the channels Hex is in, and marks direct messages', async () => {
  const bot = await startBot()
  const { session } = await threadStarted(bot)
  const lines = (await session.call('list_channels', {})).text.split('\n').sort()
  expect(lines).toEqual([
    `#general  (id: ${bot.channel})`,
    `#open-source  (id: ${bot.openSource})`,
    `dm  (id: ${bot.dm}, direct message)`,
  ].sort())
})
