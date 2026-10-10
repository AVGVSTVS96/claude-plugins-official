#!/usr/bin/env bun
import { readFileSync, writeFileSync, mkdirSync, statSync, realpathSync, chmodSync, renameSync } from 'fs'
import { createHash } from 'crypto'
import { homedir } from 'os'
import { basename, join, sep } from 'path'
import { finalizeEvent, type Event } from 'nostr-tools/pure'
import { decode } from 'nostr-tools/nip19'
import { hexToBytes } from 'nostr-tools/utils'
import { startHub, clients, move, type Message } from '../../hub/hub.ts'
import { connectRelay } from './relay.ts'
import { startActivity } from './activity.ts'
import { startMemory } from './memory.ts'

const STATE_DIR = process.env.BUZZ_STATE_DIR ?? join(homedir(), '.claude', 'channels', 'hex', 'buzz')
const ACCESS_FILE = join(STATE_DIR, 'access.json')
const ENV_FILE = join(STATE_DIR, '.env')
const CURSOR_FILE = join(STATE_DIR, 'cursor.json')
const BUTTONS_FILE = join(STATE_DIR, 'buttons.json')
const INBOX_DIR = join(STATE_DIR, 'inbox')

try {
  chmodSync(ENV_FILE, 0o600)
  for (const line of readFileSync(ENV_FILE, 'utf8').split('\n')) {
    const m = line.match(/^(\w+)=(.*)$/)
    if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2]
  }
} catch {}

const RELAY_URL = process.env.BUZZ_RELAY_URL
const PRIVATE_KEY = process.env.BUZZ_PRIVATE_KEY
const AUTH_TAG = process.env.BUZZ_AUTH_TAG

if (!RELAY_URL || !PRIVATE_KEY || !AUTH_TAG) {
  process.stderr.write(`buzz hub: no BUZZ_RELAY_URL, BUZZ_PRIVATE_KEY and BUZZ_AUTH_TAG in ${ENV_FILE}, Buzz stays off\n`)
} else {
  process.on('unhandledRejection', err => {
    process.stderr.write(`buzz hub: unhandled rejection: ${err}\n`)
  })
  process.on('uncaughtException', err => {
    process.stderr.write(`buzz hub: uncaught exception: ${err}\n`)
  })
  serve(RELAY_URL, secretKeyOf(PRIVATE_KEY), JSON.parse(AUTH_TAG))
}

type Access = {
  /** Pubkeys (hex) allowed to talk to Hex. Default: the owner named in the auth tag. */
  allowFrom?: string[]
  /** Channel, by name or id, that handoffs from other apps open in. Default: general. */
  channel?: string
  /** false turns off the activity and memory panels. */
  panels?: boolean
  /** Files and folders, relative to the hex folder, shown in the owner's memory panel. */
  share?: string[]
}

function loadAccess(): Access {
  try {
    return JSON.parse(readFileSync(ACCESS_FILE, 'utf8'))
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return {}
    process.stderr.write(`buzz hub: ${ACCESS_FILE} is unreadable, so every sender is dropped: ${err}\n`)
    return { allowFrom: [] }
  }
}

function secretKeyOf(key: string): Uint8Array {
  return key.startsWith('nsec1') ? (decode(key as `nsec1${string}`).data as Uint8Array) : hexToBytes(key)
}

// Buzz clients cap a message at 64 KiB, and a character takes at most 4 bytes.
const MAX_CHUNK_LIMIT = 16 * 1024
const MAX_ATTACHMENT_BYTES = 100 * 1024 * 1024
// Chat messages, Buzz's older message kind, diffs, and forum posts and comments: what a channel's history is made of.
const MESSAGES = [9, 40002, 40008, 45001, 45003]
const POST = 45001
const COMMENT = 45003
// Messages, forum posts and comments, edits, reactions, and deletions (NIP-09, and NIP-29's admin delete): what reaches Hex live.
const INBOUND = [9, POST, COMMENT, 40003, 7, 5, 9005]
const CANVAS = 40100
// Buzz has no buttons, so choices are numbered with these and tapped as reactions.
const KEYCAPS = ['1️⃣', '2️⃣', '3️⃣', '4️⃣', '5️⃣', '6️⃣', '7️⃣', '8️⃣', '9️⃣', '🔟']

// reply's files param takes any path, but channel state and .env files (keys)
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

function chunk(text: string, limit: number): string[] {
  if (text.length <= limit) return [text]
  const out: string[] = []
  let rest = text
  while (rest.length > limit) {
    const para = rest.lastIndexOf('\n\n', limit)
    const line = rest.lastIndexOf('\n', limit)
    const space = rest.lastIndexOf(' ', limit)
    const cut = para > limit / 2 ? para : line > limit / 2 ? line : space > 0 ? space : limit
    out.push(rest.slice(0, cut))
    rest = rest.slice(cut).replace(/^\n+/, '')
  }
  if (rest) out.push(rest)
  return out
}

// A code block cut across two messages renders as broken text in both, so
// each chunk closes the fence it opened and the next one reopens it.
function fenced(text: string, limit: number): string[] {
  const out: string[] = []
  let open = ''
  for (const part of chunk(text, limit - 16)) {
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

function title(text: string): string {
  const title = text.trim()
  if (!title || title.split(/\s+/).length > 2) throw new Error(`title must be 1–2 words, got "${title}"`)
  return title
}

function keep(path: string, value: unknown) {
  writeFileSync(`${path}.tmp`, JSON.stringify(value) + '\n')
  renameSync(`${path}.tmp`, path)
}

function load<T>(path: string, fallback: T): T {
  try {
    return JSON.parse(readFileSync(path, 'utf8'))
  } catch {
    return fallback
  }
}

// Some clients send a keycap without its variation selector.
const keycap = (emoji: string) => KEYCAPS.findIndex(choice => choice.replace(/\uFE0F/g, '') === emoji.replace(/\uFE0F/g, ''))

function now() {
  return Math.floor(Date.now() / 1000)
}

function iso(seconds: number) {
  return new Date(seconds * 1000).toISOString()
}

function byTime(a: Event, b: Event) {
  return a.created_at - b.created_at || a.id.localeCompare(b.id)
}

function tag(event: Event, name: string) {
  return event.tags.find(t => t[0] === name)?.[1]
}

// NIP-10 as Buzz reads it: a reply marker makes a message a thread reply,
// and its root is the root marker, or the reply marker when there is none.
function marked(event: Event, marker: string): string | undefined {
  return event.tags.find(t => t[0] === 'e' && /^[0-9a-f]{64}$/.test(t[1] ?? '') && t[3] === marker)?.[1]
}

function rootOf(event: Event): string | undefined {
  const reply = marked(event, 'reply')
  return reply && (marked(event, 'root') ?? reply)
}

// imeta fields are "key value" strings.
function filesOf(event: Event) {
  return event.tags.filter(t => t[0] === 'imeta').map(t => {
    const fields = Object.fromEntries(t.slice(1).map(field => [field.slice(0, field.indexOf(' ')), field.slice(field.indexOf(' ') + 1)]))
    const name = (fields.filename ?? fields.url?.split('/').pop() ?? 'file').replace(/[<>\[\]\r\n;]/g, '_')
    return { url: fields.url as string, type: fields.m ?? 'unknown', size: Number(fields.size ?? 0), name }
  })
}

function listed(event: Event): string[] {
  return filesOf(event).map(file => `${file.name} (${file.type}, ${(file.size / 1024).toFixed(0)}KB)`)
}

function serve(url: string, secretKey: Uint8Array, authTag: string[]) {
  const owner = authTag[1]!
  const relay = connectRelay({ url, secretKey, authTag })
  const me = relay.pubkey
  const start = now()
  const http = url.replace(/^ws/, 'http').replace(/\/$/, '')
  const channels = new Map<string, { name: string; dm: boolean; forum: boolean }>()
  const homes = new Map<string, string>()
  const names = new Map<string, Promise<string>>()
  const triggers = new Map<string, string[]>()
  const acks = new Map<string, string[]>()
  const typing = new Map<string, ReturnType<typeof setInterval>>()
  // The relay hides deleted events, so a deletion is explained by what Hex saw before it.
  const texts = new Map<string, { thread: string; text: string }>()
  const reactions = new Map<string, { thread: string; emoji: string; meta: Record<string, string> }>()
  // Messages Hex sent with buttons, its keycap reaction for each, and which one was tapped.
  const buttons = load<Record<string, { thread: string; choices: { label: string; reaction?: string }[]; chosen?: number }>>(BUTTONS_FILE, {})
  const access = loadAccess()
  const panels = access.panels !== false
  const activity = panels ? startActivity({ relay, secretKey, owner, hexDir: process.env.HEX_DIR ?? process.cwd(), cancel }) : undefined
  const memory = panels ? startMemory({ relay, secretKey, owner, hexDir: process.env.HEX_DIR ?? process.cwd(), share: access.share }) : undefined

  function log(line: string) {
    process.stderr.write(`buzz hub: ${line}\n`)
    activity?.log(line)
  }

  const allowed = (pubkey: string) => (loadAccess().allowFrom ?? [owner]).includes(pubkey)

  // A direct message is one conversation, so its thread is the channel itself.
  const isChannel = (thread: string) => thread.includes('-')

  function nameOf(pubkey: string): Promise<string> {
    if (!names.has(pubkey)) {
      names.set(pubkey, relay.query([{ kinds: [0], authors: [pubkey], limit: 1 }]).then(
        ([profile]) => {
          const { display_name, name } = JSON.parse(profile?.content || '{}')
          return display_name || name || pubkey.slice(0, 8)
        },
        () => pubkey.slice(0, 8),
      ))
    }
    return names.get(pubkey)!
  }

  async function channelOf(thread: string): Promise<string> {
    if (isChannel(thread)) return thread
    if (!homes.has(thread)) {
      const [root] = await relay.query([{ kinds: MESSAGES, ids: [thread] }])
      const channel = root && tag(root, 'h')
      if (!channel) throw new Error(`can't find the channel of thread ${thread}`)
      homes.set(thread, channel)
    }
    return homes.get(thread)!
  }

  function channelNamed(where?: string): string {
    const wanted = where?.replace(/^#/, '').toLowerCase()
    if (wanted && channels.has(wanted)) return wanted
    const open = [...channels].filter(([, channel]) => !channel.dm)
    const found = wanted
      ? open.find(([, channel]) => channel.name.toLowerCase() === wanted)
      : open.find(([, channel]) => channel.name.toLowerCase() === 'general') ?? open[0]
    if (!found) throw new Error(wanted ? `Hex is in no channel named #${wanted}` : 'Hex is in no Buzz channel')
    return found[0]
  }

  // The relay also serves open channels Hex isn't in; sessions read only Hex's own.
  function readable(caller: string, channel: string): string {
    if (!channels.has(channel)) throw new Error('Hex isn\'t in that channel; list_channels shows the ones it is in')
    if (channels.get(channel)!.dm && channel !== caller) throw new Error('that is a direct message with someone else')
    return channel
  }

  const link = (channel: string, id: string) => `buzz://message?channel=${channel}&id=${id}`

  function threadTags(thread: string, parent?: string): string[][] {
    if (isChannel(thread)) return parent ? [['e', parent, '', 'reply']] : []
    return parent && parent !== thread ? [['e', thread, '', 'root'], ['e', parent, '', 'reply']] : [['e', thread, '', 'reply']]
  }

  // In a forum channel every thread is a post, and a reply in it is a comment.
  async function post(thread: string, content: string, extra: string[][] = [], parent?: string): Promise<Event> {
    const channel = await channelOf(thread)
    const sent = await relay.publish({ kind: channels.get(channel)?.forum ? COMMENT : 9, content, tags: [['h', channel], ...threadTags(thread, parent), ['p', owner], ...extra] })
    texts.set(sent.id, { thread, text: content })
    return sent
  }

  async function place(name: string, where?: string) {
    const channel = channelNamed(where ?? loadAccess().channel)
    const root = await relay.publish({ kind: channels.get(channel)!.forum ? POST : 9, content: `**${name}**`, tags: [['h', channel], ['p', owner]] })
    homes.set(root.id, channel)
    return { thread: root.id, link: link(channel, root.id) }
  }

  function blossom(action: 'upload' | 'get', sha256?: string) {
    const auth = finalizeEvent({
      kind: 24242,
      content: action === 'get' ? 'Get buzz-media' : 'Upload file',
      created_at: now(),
      tags: [['t', action], ...(sha256 ? [['x', sha256]] : []), ['expiration', String(now() + 60)], ['server', new URL(http).host]],
    }, secretKey)
    return { Authorization: `Nostr ${Buffer.from(JSON.stringify(auth)).toString('base64url')}`, 'x-auth-tag': JSON.stringify(authTag) }
  }

  // Blossom upload, as the buzz CLI does it: /upload, or /media/upload on older relays.
  async function upload(path: string) {
    const body = readFileSync(path)
    const sha256 = createHash('sha256').update(body).digest('hex')
    const type = Bun.file(path).type.split(';')[0]!
    const put = (endpoint: string) => fetch(`${http}${endpoint}`, { method: 'PUT', body, headers: { ...blossom('upload', sha256), 'Content-Type': type, 'X-SHA-256': sha256 } })
    let res = await put('/upload')
    if (res.status === 404 || res.status === 405) res = await put('/media/upload')
    if (!res.ok) throw new Error(`upload of ${path} failed: ${res.status} ${await res.text()}`)
    const blob = await res.json() as { url: string; sha256: string; size: number; type: string; dim?: string }
    const filename = basename(path)
    const line = blob.type.startsWith('video/') ? `![video](${blob.url})` : blob.type.startsWith('image/') ? `![image](${blob.url})` : `[${filename.replace(/[\\[\]]/g, '\\$&')}](${blob.url})`
    const imeta = ['imeta', `url ${blob.url}`, `m ${blob.type}`, `x ${blob.sha256}`, `size ${blob.size}`, ...(blob.dim ? [`dim ${blob.dim}`] : []), `filename ${filename}`]
    return { line, imeta }
  }

  async function download(file: { url: string; name: string; size: number }, id: string): Promise<string> {
    if (file.size > MAX_ATTACHMENT_BYTES) {
      throw new Error(`attachment too large: ${(file.size / 1024 / 1024).toFixed(1)}MB, max ${MAX_ATTACHMENT_BYTES / 1024 / 1024}MB`)
    }
    const res = await fetch(file.url, { headers: new URL(file.url).host === new URL(http).host ? blossom('get') : {} })
    if (!res.ok) throw new Error(`download failed: HTTP ${res.status}`)
    const rawExt = file.name.includes('.') ? file.name.slice(file.name.lastIndexOf('.') + 1) : 'bin'
    const ext = rawExt.replace(/[^a-zA-Z0-9]/g, '') || 'bin'
    const path = join(INBOX_DIR, `${Date.now()}-${id.slice(0, 8)}.${ext}`)
    mkdirSync(INBOX_DIR, { recursive: true })
    writeFileSync(path, Buffer.from(await res.arrayBuffer()))
    return path
  }

  async function message(thread: string, id: string): Promise<Event> {
    const [found] = await relay.query([{ kinds: MESSAGES, ids: [id], '#h': [await channelOf(thread)] }])
    if (!found) throw new Error(`no message ${id} in this thread`)
    return found
  }

  // The relay's NIP-98 signed HTTP query, which serves the channel windows
  // Desktop reads (NIP-CW): top-level messages with their thread summaries.
  async function bridge(filters: object[]): Promise<Event[]> {
    const url = `${http}/query`
    const body = JSON.stringify(filters)
    const auth = finalizeEvent({
      kind: 27235,
      content: '',
      created_at: now(),
      tags: [['u', url], ['method', 'POST'], ['payload', createHash('sha256').update(body).digest('hex')], ['nonce', crypto.randomUUID()]],
    }, secretKey)
    const headers = { Authorization: `Nostr ${Buffer.from(JSON.stringify(auth)).toString('base64')}`, 'x-auth-tag': JSON.stringify(authTag), 'Content-Type': 'application/json' }
    const res = await fetch(url, { method: 'POST', body, headers })
    if (!res.ok) throw new Error(`the relay refused the read: ${res.status} ${await res.text()}`)
    return await res.json() as Event[]
  }

  async function rows(events: Event[], note: (event: Event) => string = () => ''): Promise<string> {
    if (events.length === 0) return '(no messages)'
    const lines = await Promise.all(events.map(async m => {
      const who = m.pubkey === me ? 'me' : await nameOf(m.pubkey)
      const files = filesOf(m).length
      const atts = files > 0 ? ` +${files}att` : ''
      // The result is newline-joined, so multi-line content would forge adjacent rows.
      const text = m.content.replace(/[\r\n]+/g, ' ⏎ ')
      return `[${iso(m.created_at)}] ${who}: ${text}  (id: ${m.id}${atts}${note(m)})`
    }))
    return lines.join('\n')
  }

  async function channelWindow(channel: string, limit: number, before?: Event): Promise<string> {
    const page = await bridge([{ kinds: MESSAGES, '#h': [channel], limit, top_level: true, include_summaries: true, ...(before ? { until: before.created_at, before_id: before.id } : {}) }])
    if (!page.some(event => event.kind === 39006)) throw new Error('the relay won\'t show Hex that channel')
    const threads = new Map(page.filter(event => event.kind === 39005).map(event => [tag(event, 'd'), JSON.parse(event.content)]))
    return rows(page.filter(event => MESSAGES.includes(event.kind)).reverse(), event => {
      const thread = threads.get(event.id)
      return thread ? `, ${thread.descendant_count} replies${thread.last_reply_at ? `, last reply ${iso(thread.last_reply_at)}` : ''}` : ''
    })
  }

  async function history(caller: string, args: Record<string, unknown>): Promise<string> {
    const limit = Math.min((args.limit as number) ?? 20, 100)
    const named = args.thread as string | undefined
    const thread = named ? (/^[0-9a-f]{64}$/.test(named) ? named : hub.find(named)) : args.channel ? channelNamed(args.channel as string) : caller
    const channel = await channelOf(thread)
    if (thread !== caller) readable(caller, channel)
    const before = args.before ? await message(channel, args.before as string) : undefined
    if (isChannel(thread) && !channels.get(thread)?.dm) return channelWindow(thread, limit, before)
    const page = before ? { until: before.created_at, limit: limit + 1 } : { limit }
    const events = await relay.query(isChannel(thread)
      ? [{ kinds: MESSAGES, '#h': [channel], ...page }]
      : [{ kinds: MESSAGES, ids: [thread], '#h': [channel] }, { kinds: MESSAGES, '#h': [channel], '#e': [thread], ...page }])
    return rows(events.filter(event => !before || byTime(event, before) < 0).sort(byTime).slice(-limit))
  }

  async function search(caller: string, args: Record<string, unknown>): Promise<string> {
    const limit = Math.min((args.limit as number) ?? 20, 100)
    const scope = args.channel ? [readable(caller, channelNamed(args.channel as string))] : [...channels.keys()].filter(id => !channels.get(id)!.dm || id === caller)
    const hits = scope.length > 0 ? await relay.query([{ kinds: MESSAGES, search: args.query as string, '#h': scope, limit }]) : []
    return rows(hits, event => {
      const channel = channels.get(tag(event, 'h')!)
      const root = rootOf(event)
      return `, in ${channel?.dm ? 'this direct message' : `#${channel?.name}`}${root ? `, thread ${root}` : ''}`
    })
  }

  // Desktop shows an edit's attachments in place of the original's, so they carry over.
  function edit(target: Event, text: string) {
    const urls = filesOf(target).map(file => `](${file.url})`)
    const media = target.content.split('\n').filter(line => urls.some(url => line.endsWith(url)))
    const imeta = target.tags.filter(t => t[0] === 'imeta')
    return relay.publish({ kind: 40003, content: [text, ...media].join('\n'), tags: [['h', tag(target, 'h')!], ['e', target.id], ...imeta] })
  }

  // A channel's canvas is its newest kind 40100 event; Desktop writes one a second
  // past the head it read, so a new revision always sorts first.
  async function canvas(channel: string, text?: string, revision?: string): Promise<string> {
    const [head] = await relay.query([{ kinds: [CANVAS], '#h': [channel], limit: 1 }])
    if (text === undefined) return head ? `${head.content}\n\n(revision: ${head.id})` : '(this channel has no canvas yet)'
    const saved = await relay.publish({
      kind: CANVAS,
      content: text,
      tags: [['h', channel], ...(revision ? [['expected-revision', revision]] : [])],
      created_at: Math.max(now(), (head?.created_at ?? 0) + 1),
    })
    return `canvas saved (revision: ${saved.id})`
  }

  // The relay answers presence over /query only, one event per person who is
  // online or away; anyone missing is offline, as Desktop reads it.
  async function whoIsOnline(): Promise<string> {
    const people = loadAccess().allowFrom ?? [owner]
    const status = new Map((await bridge([{ kinds: [20001], authors: people }])).map(event => [tag(event, 'p') ?? event.pubkey, event.content]))
    const lines = await Promise.all(people.map(async pubkey => `${await nameOf(pubkey)}: ${status.get(pubkey) ?? 'offline'}`))
    return lines.join('\n')
  }

  function listChannels(): string {
    const lines = [...channels].map(([id, channel]) => channel.dm ? `${channel.name}  (id: ${id}, direct message)` : `#${channel.name}  (id: ${id})`)
    return lines.join('\n') || '(none)'
  }

  // NIP-29 create-group: Hex owns the channel it creates, and adds the owner so it shows up for them.
  async function createChannel(args: Record<string, unknown>): Promise<string> {
    const name = (args.name as string).trim().replace(/^#/, '')
    if (!name) throw new Error('a channel needs a name')
    const id = crypto.randomUUID()
    const forum = args.type === 'forum'
    await relay.publish({
      kind: 9007,
      content: '',
      tags: [['h', id], ['name', name], ['visibility', args.private ? 'private' : 'open'], ['channel_type', forum ? 'forum' : 'stream'], ...(args.about ? [['about', args.about as string]] : [])],
    })
    await relay.publish({ kind: 9000, content: '', tags: [['h', id], ['p', owner]] })
    channels.set(id, { name, dm: false, forum })
    listen()
    return `created #${name} (id: ${id}); new_thread can open threads in it`
  }

  function react(id: string, emoji: string) {
    return relay.publish({ kind: 7, content: emoji, tags: [['e', id]] })
  }

  async function ack(thread: string, id: string, emoji: string) {
    const reaction = await react(id, emoji)
    acks.set(thread, [...(acks.get(thread) ?? []), reaction.id])
  }

  function unack(thread: string) {
    for (const id of acks.get(thread) ?? []) void relay.publish({ kind: 5, content: '', tags: [['e', id]] }).catch(() => {})
    acks.delete(thread)
  }

  function sendTyping(thread: string): void {
    void channelOf(thread).then(channel => relay.publish({ kind: 20002, content: '', tags: [['h', channel], ...threadTags(thread)] })).catch(() => {})
  }

  // Buzz shows "typing…" for about 8 seconds per event, so it is re-sent
  // for as long as the thread's session is busy. The 👀 and 💬 acks go once it's idle.
  function showState(thread: string, busy: boolean): void {
    log(`${thread} ${busy ? 'busy' : 'idle'}`)
    const started = busy && !typing.has(thread)
    clearInterval(typing.get(thread))
    typing.delete(thread)
    if (!busy) {
      triggers.delete(thread)
      unack(thread)
      activity?.idle(thread)
      return
    }
    typing.set(thread, setInterval(() => sendTyping(thread), 3000))
    const latest = triggers.get(thread)?.at(-1)
    if (started) {
      sendTyping(thread)
      if (latest) void ack(thread, latest, '💬').catch(() => {})
    }
    void channelOf(thread).then(channel => {
      if (typing.has(thread)) activity?.busy({ thread, channel, session: hub.session(thread), triggers: triggers.get(thread) ?? [] })
    }).catch(() => {})
  }

  function cancel({ channel, thread, session }: { channel: string; thread?: string; session?: string }) {
    const matches = [...typing.keys()].filter(busy =>
      (isChannel(busy) ? busy : homes.get(busy)) === channel && (!thread || busy === thread) && (!session || hub.session(busy) === session))
    if (matches.length === 0) return 'no_active_turn'
    if (matches.length > 1) return 'ambiguous_target'
    stop(matches[0]!)
    return 'sent'
  }

  function stop(thread: string) {
    activity?.stopped(thread)
    hub.stop(thread)
  }

  async function call(caller: string, tool: string, args: Record<string, unknown>): Promise<string> {
    if (tool === 'new_thread') {
      const name = title(args.title as string)
      const { thread, link } = await place(name, (args.channel as string | undefined) ?? await channelOf(caller))
      hub.open(thread, name, args.prompt as string)
      return `started thread "${name}": ${link}`
    }
    if (tool === 'fetch_messages') return history(caller, args)
    if (tool === 'search_messages') return search(caller, args)
    if (tool === 'list_channels') return listChannels()
    if (tool === 'create_channel') return createChannel(args)
    if (tool === 'presence') return whoIsOnline()
    if (tool === 'canvas') {
      const channel = args.channel ? readable(caller, channelNamed(args.channel as string)) : await channelOf(caller)
      return canvas(channel, args.text as string | undefined, args.revision as string | undefined)
    }
    const thread = args.thread ? hub.find(args.thread as string) : caller
    switch (tool) {
      case 'reply': {
        const choices = (args.buttons as string[] | undefined) ?? []
        if (choices.length > KEYCAPS.length) throw new Error(`at most ${KEYCAPS.length} buttons`)
        const text = [args.text as string, choices.map((label, i) => `${KEYCAPS[i]} ${label}`).join('\n')].filter(Boolean).join('\n\n')
        const reply_to = args.reply_to as string | undefined
        const files = (args.files as string[] | undefined) ?? []

        for (const f of files) {
          assertSendable(f)
          const st = statSync(f)
          if (st.size > MAX_ATTACHMENT_BYTES) {
            throw new Error(`file too large: ${f} (${(st.size / 1024 / 1024).toFixed(1)}MB, max 100MB)`)
          }
        }

        const uploads = await Promise.all(files.map(upload))
        const chunks = fenced(text, MAX_CHUNK_LIMIT)
        const sentIds: string[] = []

        try {
          for (let i = 0; i < chunks.length; i++) {
            const last = i === chunks.length - 1
            const content = last ? chunks[i] + uploads.map(u => `\n${u.line}`).join('') : chunks[i]!
            const sent = await post(thread, content, last ? uploads.map(u => u.imeta) : [], i === 0 ? reply_to : undefined)
            sentIds.push(sent.id)
          }
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err)
          throw new Error(`reply failed after ${sentIds.length} of ${chunks.length} chunk(s) sent: ${msg}`)
        }

        if (choices.length > 0) {
          const asked = (buttons[sentIds.at(-1)!] = { thread, choices: choices.map(label => ({ label })) })
          keep(BUTTONS_FILE, buttons)
          for (const [i, choice] of asked.choices.entries()) choice.reaction = (await react(sentIds.at(-1)!, KEYCAPS[i]!)).id
          keep(BUTTONS_FILE, buttons)
        }

        return sentIds.length === 1 ? `sent (id: ${sentIds[0]})` : `sent ${sentIds.length} parts (ids: ${sentIds.join(', ')})`
      }
      case 'react': {
        const target = await message(thread, args.message_id as string)
        if (!args.remove) {
          await react(target.id, args.emoji as string)
          return 'reacted'
        }
        const mine = await relay.query([{ kinds: [7], authors: [me], '#e': [target.id], '#h': [tag(target, 'h')!] }])
        const reaction = mine.find(event => event.content === args.emoji)
        if (!reaction) throw new Error(`the bot hasn't reacted ${args.emoji} to that message`)
        await relay.publish({ kind: 5, content: '', tags: [['e', reaction.id]] })
        return 'reaction removed'
      }
      case 'edit_message': {
        const target = await message(thread, args.message_id as string)
        if (target.pubkey !== me) throw new Error('only the bot\'s own messages can be edited')
        const edited = await edit(target, args.text as string)
        texts.set(target.id, { thread, text: args.text as string })
        return `edited (id: ${edited.id})`
      }
      case 'delete_message': {
        const target = await message(thread, args.message_id as string)
        if (target.pubkey !== me) throw new Error('only the bot\'s own messages can be deleted')
        await relay.publish({ kind: 5, content: '', tags: [['h', tag(target, 'h')!], ['e', target.id]] })
        texts.delete(target.id)
        return 'deleted'
      }
      case 'download_attachment': {
        const msg = await message(thread, args.message_id as string)
        const files = filesOf(msg)
        if (files.length === 0) return 'message has no attachments'
        const lines: string[] = []
        for (const file of files) {
          const path = await download(file, msg.id)
          lines.push(`  ${path}  (${file.name}, ${file.type}, ${(file.size / 1024).toFixed(0)}KB)`)
        }
        return `downloaded ${lines.length} attachment(s):\n${lines.join('\n')}`
      }
      case 'rename_thread': {
        const name = title(args.title as string)
        hub.rename(thread, name)
        const head = isChannel(thread) ? undefined : await message(thread, thread)
        if (head?.pubkey !== me) return `renamed to "${name}"`
        await edit(head, `**${name}**`)
        return `renamed to "${name}", and its first message in Buzz now says so`
      }
      case 'close_thread': {
        if (isChannel(thread)) throw new Error('only threads can be closed')
        void hub.retire(thread)
        await react(thread, '✅')
        return `closed "${hub.name(thread) ?? thread}"; its session stops once it's idle`
      }
      case 'handoff': {
        const to = args.to as string
        const name = args.title ? title(args.title as string) : hub.name(thread) ?? 'Buzz'
        const target = await move(hub, thread, to, name)
        await post(thread, `Moved to ${to}: ${target}`)
        return `moving to ${to}: ${target}. Your session stops here once this turn ends and resumes there.`
      }
      default:
        throw new Error(`unknown tool: ${tool}`)
    }
  }

  const hub = startHub({
    stateDir: STATE_DIR,
    channel: 'plugin:buzz@hex',
    call,
    state: showState,
    failed: (thread, reason) => {
      void post(thread, `Couldn't start this thread's session: ${reason}`).catch(() => {})
    },
    hexDir: process.env.HEX_DIR,
    launcher: process.env.HEX_LAUNCHER,
  })

  clients.set('buzz', { hub, place })

  // Desktop writes a mention as "@Name", or "@Name (pubkey)" when two members share a name.
  async function unmention(text: string): Promise<string> {
    const label = (await nameOf(me)).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    return text.replace(new RegExp(`(^|\\s)@${label}(?: \\(${me}\\))?(?=[\\s,;.!?:)]|$)`, 'gi'), '$1').trim()
  }

  // A tag in a channel starts a thread on that message, or joins the thread
  // it was sent in; inside a thread Hex knows, and in a DM, no tag is needed.
  // Desktop's replies at any depth carry the top-level message as their root, so
  // each top-level message is one thread and every reply under it reaches its session.
  function threadOf(event: Event, tagged: boolean): string | undefined {
    const head = rootOf(event) ?? event.id
    if (hub.name(head) !== undefined) return head
    const channel = tag(event, 'h')!
    if (channels.get(channel)?.dm) return channel
    if (tagged) return head
  }

  // A reply's reply marker is the thread head, unless it answers one message in
  // particular; the head is named too when the reply brings Hex into the thread.
  async function replyMeta(event: Event, thread: string, joined: boolean): Promise<Record<string, string>> {
    const parent = marked(event, 'reply')
    if (!parent || (parent === thread && !joined)) return {}
    const [replied] = await relay.query([{ kinds: MESSAGES, ids: [parent] }])
    if (!replied) return { reply_to_message_id: parent }
    const atts = listed(replied)
    return {
      reply_to_message_id: replied.id,
      reply_to_user: replied.pubkey === me ? 'me' : await nameOf(replied.pubkey),
      ...(replied.content ? { reply_to_text: replied.content } : {}),
      ...(atts.length > 0 ? { reply_to_attachments: atts.join('; ') } : {}),
    }
  }

  // An edit (kind 40003) names the message it replaces, which holds the thread and mention tags.
  async function originalOf(event: Event): Promise<Event | undefined> {
    if (event.kind !== 40003) return event
    const id = tag(event, 'e')
    const [original] = id ? await relay.query([{ kinds: MESSAGES, ids: [id] }]) : []
    return original?.pubkey === event.pubkey ? original : undefined
  }

  async function about(event: Event, thread: string, channel = tag(event, 'h')): Promise<Record<string, string>> {
    const where = channels.get(channel ?? '')
    return {
      chat_id: thread,
      user: await nameOf(event.pubkey),
      user_id: event.pubkey,
      ts: iso(event.created_at),
      ...(where && !where.dm ? { channel: where.name } : {}),
    }
  }

  async function inbound(event: Event): Promise<void> {
    if (event.pubkey === me || !allowed(event.pubkey)) return
    if (event.kind === 7) return handleReaction(event)
    if (event.kind === 5 || event.kind === 9005) return handleDeletion(event)
    return handleInbound(event)
  }

  // A reaction reaches the thread the message it's on belongs to, if Hex is in it.
  // A keycap on a message with buttons is a tap instead, and only the first counts.
  async function handleReaction(event: Event): Promise<void> {
    const id = event.tags.findLast(t => t[0] === 'e')?.[1]
    const asked = id ? buttons[id] : undefined
    const index = keycap(event.content)
    if (asked?.choices[index]) return asked.chosen === undefined ? tap(event, id!, index) : undefined
    const [target] = id ? await relay.query([{ kinds: MESSAGES, ids: [id] }]) : []
    const thread = target && threadOf(target, false)
    if (!thread) return
    const meta = {
      reaction_to_message_id: target.id,
      reaction_to_user: target.pubkey === me ? 'me' : await nameOf(target.pubkey),
      ...(target.content ? { reaction_to_text: target.content } : {}),
    }
    reactions.set(event.id, { thread, emoji: event.content, meta })
    hub.deliver(thread, hub.name(thread) ?? await nameOf(event.pubkey), {
      content: `(reaction: ${event.content})`,
      meta: { ...(await about(event, thread, tag(target, 'h'))), reaction: event.content, ...meta },
    })
  }

  // The bot's other keycaps come off, so the one tapped stands out.
  async function tap(event: Event, id: string, index: number): Promise<void> {
    const asked = buttons[id]!
    asked.chosen = index
    keep(BUTTONS_FILE, buttons)
    for (const [i, choice] of asked.choices.entries()) {
      if (i !== index && choice.reaction) void relay.publish({ kind: 5, content: '', tags: [['e', choice.reaction]] }).catch(() => {})
    }
    const meta = await about(event, asked.thread, await channelOf(asked.thread))
    hub.deliver(asked.thread, hub.name(asked.thread) ?? meta.user!, {
      content: asked.choices[index]!.label,
      meta: { ...meta, button: 'true', button_message_id: id },
    })
  }

  async function handleDeletion(event: Event): Promise<void> {
    const id = tag(event, 'e') ?? ''
    const reaction = reactions.get(id)
    const said = texts.get(id)
    const thread = reaction?.thread ?? said?.thread
    if (!thread) return
    reactions.delete(id)
    texts.delete(id)
    const meta = await about(event, thread)
    hub.deliver(thread, hub.name(thread) ?? meta.user!, reaction
      ? { content: `(reaction removed: ${reaction.emoji})`, meta: { ...meta, reaction: reaction.emoji, reaction_removed: 'true', ...reaction.meta } }
      : { content: '(deleted a message)', meta: { ...meta, deleted: 'true', message_id: id, ...(said?.text ? { deleted_text: said.text } : {}) } })
  }

  async function handleInbound(event: Event): Promise<void> {
    const original = await originalOf(event)
    if (!original) return
    const edited = original !== event
    const tagged = [original, event].some(e => e.tags.some(t => t[0] === 'p' && t[1] === me))
    const thread = threadOf(original, tagged)
    if (!thread) return
    const channel = tag(original, 'h')!
    const joined = !edited && !isChannel(thread) && hub.name(thread) === undefined
    if (!isChannel(thread)) homes.set(thread, channel)
    const text = await unmention(event.content)

    if (!edited && event.pubkey === owner && tagged && text === '!shutdown') return shutdown()
    if (!edited && event.pubkey === owner && tagged && text === '!cancel') return stop(thread)

    triggers.set(thread, [...(triggers.get(thread) ?? []), original.id])
    texts.set(original.id, { thread, text: event.content })
    void ack(thread, original.id, '👀').catch(() => {})

    // Attachments are listed (name/type/size) but not downloaded: the model
    // calls download_attachment when it wants them. The listing goes in meta
    // only, since an in-content annotation is forgeable by the sender.
    const atts = listed(event)
    const reply = await replyMeta(original, thread, joined)
    const words = (text || reply.reply_to_text || '').split(/\s+/).filter(word => word && !word.startsWith('@'))
    const name = isChannel(thread) ? await nameOf(event.pubkey) : words.slice(0, 2).join(' ') || 'New thread'

    // A bare tag on someone's message brings Hex in to read it: the message is reply_to_*.
    const message: Message = {
      content: text || (atts.length > 0 ? '(attachment)' : '(tagged you)'),
      meta: {
        ...(await about(event, thread, channel)),
        message_id: original.id,
        ...(joined ? { new_thread: 'true' } : {}),
        ...(atts.length > 0 ? { attachment_count: String(atts.length), attachments: atts.join('; ') } : {}),
        ...reply,
        ...(edited ? { edited: 'true' } : {}),
      },
    }
    hub.deliver(thread, name, message)
  }

  // The last event handled, and every id handled in that second, so a restart
  // picks up from there and nothing is delivered twice.
  let cursor = load<{ at: number; ids: string[] }>(CURSOR_FILE, { at: start, ids: [] })

  function handled(event: Event) {
    if (event.created_at < cursor.at) return
    cursor = event.created_at === cursor.at ? { at: cursor.at, ids: [...cursor.ids, event.id] } : { at: event.created_at, ids: [event.id] }
    keep(CURSOR_FILE, cursor)
  }

  // Events are handled one at a time, in the order they came, so a thread's
  // messages reach its session in order.
  let queue = Promise.resolve()
  let off = false

  // The relay only sends channel messages live to a subscription naming its
  // channels, so membership changes swap it for one over the new set.
  let unlisten = () => {}
  function listen() {
    const previous = unlisten
    unlisten = channels.size === 0 ? () => {} : relay.subscribe([{ kinds: INBOUND, '#h': [...channels.keys()], since: cursor.at }], event => {
      queue = queue.then(async () => {
        if (off || (event.created_at === cursor.at && cursor.ids.includes(event.id))) return
        await inbound(event).catch(e => log(`handleInbound failed: ${e}`))
        handled(event)
      }).catch(e => log(`couldn't save where Buzz left off: ${e}`))
    })
    previous()
  }

  async function enter(ids: string[]) {
    const metas = ids.length > 0 ? await relay.query([{ kinds: [39000], '#d': ids }]) : []
    for (const id of ids) {
      const meta = metas.find(meta => tag(meta, 'd') === id)
      const dm = meta?.tags.some(t => (t[0] === 't' && t[1] === 'dm') || t[0] === 'hidden') ?? false
      const forum = meta?.tags.some(t => t[0] === 't' && t[1] === 'forum') ?? false
      channels.set(id, { name: (meta && tag(meta, 'name')) ?? id, dm, forum })
    }
    listen()
  }

  async function discover() {
    const members = await relay.query([{ kinds: [39002], '#p': [me] }])
    await enter(members.map(event => tag(event, 'd')!).filter(Boolean))
    log(`connected as ${me.slice(0, 8)}, in ${channels.size} channel(s)`)
  }

  const membership = relay.subscribe([{ kinds: [44100, 44101], '#p': [me], since: start }], event => {
    const id = tag(event, 'h')
    if (!id) return
    if (event.kind === 44100) return void enter([id]).catch(e => log(`joining ${id} failed: ${e}`))
    channels.delete(id)
    listen()
  })

  const presence = () => relay.publish({ kind: 20001, content: 'online', tags: [] }).catch(() => {})
  const heartbeat = setInterval(presence, 60_000)
  void presence()
  discover().catch(e => log(`channel discovery failed: ${e}`))

  // !shutdown from the owner (Buzz Desktop's Shutdown button) takes Hex off
  // Buzz until the service restarts; the rest of the hub keeps running.
  async function shutdown() {
    log('shutting down')
    off = true
    clearInterval(heartbeat)
    for (const timer of typing.values()) clearInterval(timer)
    typing.clear()
    membership()
    unlisten()
    await Promise.race([relay.publish({ kind: 20001, content: 'offline', tags: [] }).catch(() => {}), Bun.sleep(2000)])
    activity?.close()
    memory?.close()
    relay.close()
  }

  for (const signal of ['SIGTERM', 'SIGINT'] as const) process.once(signal, () => void shutdown().finally(() => process.exit(0)))
}
