#!/usr/bin/env bun
import { readFileSync, writeFileSync, mkdirSync, statSync, realpathSync, chmodSync } from 'fs'
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

function now() {
  return Math.floor(Date.now() / 1000)
}

function tag(event: Event, name: string) {
  return event.tags.find(t => t[0] === name)?.[1]
}

// NIP-10 as Buzz reads it: a reply marker makes a message a thread reply,
// and its root is the root marker, or the reply marker when there is none.
function rootOf(event: Event): string | undefined {
  const marked = (marker: string) => event.tags.find(t => t[0] === 'e' && /^[0-9a-f]{64}$/.test(t[1] ?? '') && t[3] === marker)?.[1]
  const reply = marked('reply')
  return reply && (marked('root') ?? reply)
}

// imeta fields are "key value" strings.
function filesOf(event: Event) {
  return event.tags.filter(t => t[0] === 'imeta').map(t => {
    const fields = Object.fromEntries(t.slice(1).map(field => [field.slice(0, field.indexOf(' ')), field.slice(field.indexOf(' ') + 1)]))
    const name = (fields.filename ?? fields.url?.split('/').pop() ?? 'file').replace(/[<>\[\]\r\n;]/g, '_')
    return { url: fields.url as string, type: fields.m ?? 'unknown', size: Number(fields.size ?? 0), name }
  })
}

function serve(url: string, secretKey: Uint8Array, authTag: string[]) {
  const owner = authTag[1]!
  const relay = connectRelay({ url, secretKey, authTag })
  const me = relay.pubkey
  const start = now()
  const http = url.replace(/^ws/, 'http').replace(/\/$/, '')
  const channels = new Map<string, { name: string; dm: boolean }>()
  const homes = new Map<string, string>()
  const names = new Map<string, Promise<string>>()
  const triggers = new Map<string, string[]>()
  const acks = new Map<string, string[]>()
  const typing = new Map<string, ReturnType<typeof setInterval>>()
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
      const [root] = await relay.query([{ kinds: [9], ids: [thread] }])
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

  const link = (channel: string, id: string) => `buzz://message?channel=${channel}&id=${id}`

  function threadTags(thread: string, parent?: string): string[][] {
    if (isChannel(thread)) return parent ? [['e', parent, '', 'reply']] : []
    return parent && parent !== thread ? [['e', thread, '', 'root'], ['e', parent, '', 'reply']] : [['e', thread, '', 'reply']]
  }

  async function post(thread: string, content: string, extra: string[][] = [], parent?: string): Promise<Event> {
    const channel = await channelOf(thread)
    return relay.publish({ kind: 9, content, tags: [['h', channel], ...threadTags(thread, parent), ['p', owner], ...extra] })
  }

  async function place(name: string, where?: string) {
    const channel = channelNamed(where ?? loadAccess().channel)
    const root = await relay.publish({ kind: 9, content: `**${name}**`, tags: [['h', channel], ['p', owner]] })
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
    const [found] = await relay.query([{ kinds: [9], ids: [id], '#h': [await channelOf(thread)] }])
    if (!found) throw new Error(`no message ${id} in this thread`)
    return found
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
    hub.stop(matches[0]!)
    return 'sent'
  }

  async function call(caller: string, tool: string, args: Record<string, unknown>): Promise<string> {
    if (tool === 'new_thread') {
      const name = title(args.title as string)
      const { thread, link } = await place(name, (args.channel as string | undefined) ?? await channelOf(caller))
      hub.open(thread, name, args.prompt as string)
      return `started thread "${name}": ${link}`
    }
    const thread = args.thread ? hub.find(args.thread as string) : caller
    switch (tool) {
      case 'reply': {
        const text = args.text as string
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

        return sentIds.length === 1 ? `sent (id: ${sentIds[0]})` : `sent ${sentIds.length} parts (ids: ${sentIds.join(', ')})`
      }
      case 'fetch_messages': {
        const limit = Math.min((args.limit as number) ?? 20, 100)
        const channel = await channelOf(thread)
        const events = await relay.query(isChannel(thread)
          ? [{ kinds: [9], '#h': [channel], limit }]
          : [{ kinds: [9], ids: [thread], '#h': [channel] }, { kinds: [9], '#h': [channel], '#e': [thread], limit }])
        const arr = events.sort((a, b) => a.created_at - b.created_at).slice(-limit)
        if (arr.length === 0) return '(no messages)'
        const lines = await Promise.all(arr.map(async m => {
          const who = m.pubkey === me ? 'me' : await nameOf(m.pubkey)
          const files = filesOf(m).length
          const atts = files > 0 ? ` +${files}att` : ''
          // The result is newline-joined, so multi-line content would forge adjacent rows.
          const text = m.content.replace(/[\r\n]+/g, ' ⏎ ')
          return `[${new Date(m.created_at * 1000).toISOString()}] ${who}: ${text}  (id: ${m.id}${atts})`
        }))
        return lines.join('\n')
      }
      case 'react': {
        await message(thread, args.message_id as string)
        await react(args.message_id as string, args.emoji as string)
        return 'reacted'
      }
      case 'edit_message': {
        const target = await message(thread, args.message_id as string)
        if (target.pubkey !== me) throw new Error('only the bot\'s own messages can be edited')
        // Desktop shows an edit's attachments in place of the original's, so they carry over.
        const urls = filesOf(target).map(file => `](${file.url})`)
        const media = target.content.split('\n').filter(line => urls.some(url => line.endsWith(url)))
        const imeta = target.tags.filter(t => t[0] === 'imeta')
        const edited = await relay.publish({ kind: 40003, content: [args.text as string, ...media].join('\n'), tags: [['h', tag(target, 'h')!], ['e', target.id], ...imeta] })
        return `edited (id: ${edited.id})`
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
        return `renamed to "${name}"`
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
  function threadOf(event: Event, tagged: boolean): string | undefined {
    const root = rootOf(event)
    if (root && hub.name(root) !== undefined) return root
    const channel = tag(event, 'h')!
    if (channels.get(channel)?.dm) return channel
    if (tagged) return root ?? event.id
  }

  async function handleInbound(event: Event): Promise<void> {
    if (event.pubkey === me || !allowed(event.pubkey)) return
    const tagged = event.tags.some(t => t[0] === 'p' && t[1] === me)
    const thread = threadOf(event, tagged)
    if (!thread) return
    const channel = tag(event, 'h')!
    if (!isChannel(thread)) homes.set(thread, channel)
    const text = await unmention(event.content)

    if (event.pubkey === owner && tagged && text === '!shutdown') return shutdown()
    if (event.pubkey === owner && tagged && text === '!cancel') return hub.stop(thread)

    triggers.set(thread, [...(triggers.get(thread) ?? []), event.id])
    void ack(thread, event.id, '👀').catch(() => {})

    // Attachments are listed (name/type/size) but not downloaded: the model
    // calls download_attachment when it wants them. The listing goes in meta
    // only, since an in-content annotation is forgeable by the sender.
    const atts = filesOf(event).map(file => `${file.name} (${file.type}, ${(file.size / 1024).toFixed(0)}KB)`)
    const words = text.split(/\s+/).filter(word => word && !word.startsWith('@'))
    const name = isChannel(thread) ? await nameOf(event.pubkey) : words.slice(0, 2).join(' ') || 'New thread'

    const message: Message = {
      content: text || (atts.length > 0 ? '(attachment)' : ''),
      meta: {
        chat_id: thread,
        message_id: event.id,
        user: await nameOf(event.pubkey),
        user_id: event.pubkey,
        ts: new Date(event.created_at * 1000).toISOString(),
        ...(thread === event.id ? { new_thread: 'true' } : {}),
        ...(atts.length > 0 ? { attachment_count: String(atts.length), attachments: atts.join('; ') } : {}),
      },
    }
    hub.deliver(thread, name, message)
  }

  // The relay only sends channel messages live to a subscription naming its
  // channels, so membership changes swap it for one over the new set.
  let unlisten = () => {}
  function listen() {
    const previous = unlisten
    unlisten = channels.size === 0 ? () => {} : relay.subscribe([{ kinds: [9], '#h': [...channels.keys()], since: start }], event => {
      handleInbound(event).catch(e => log(`handleInbound failed: ${e}`))
    })
    previous()
  }

  async function enter(ids: string[]) {
    const metas = ids.length > 0 ? await relay.query([{ kinds: [39000], '#d': ids }]) : []
    for (const id of ids) {
      const meta = metas.find(meta => tag(meta, 'd') === id)
      const dm = meta?.tags.some(t => (t[0] === 't' && t[1] === 'dm') || t[0] === 'hidden') ?? false
      channels.set(id, { name: (meta && tag(meta, 'name')) ?? id, dm })
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
