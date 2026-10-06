import { createHash, createHmac } from 'crypto'
import { execFile } from 'child_process'
import { lstatSync, readFileSync, readdirSync, renameSync, statSync, watch, writeFileSync, type FSWatcher } from 'fs'
import { join, posix } from 'path'
import { promisify } from 'util'
import { verifyEvent, type Event } from 'nostr-tools/pure'
import { decrypt, encrypt, getConversationKey } from 'nostr-tools/nip44'
import type { Relay } from './relay.ts'

const ENGRAM = 30174
const FILE = 30180
const EDIT = 4180
const RESULT = 4181
const LIMIT = 65535
const SHARE = ['AGENTS.md', 'SOUL.md', 'MEMORY.md', 'schedules.json']
const SETTLE = 500
const RESYNC = 10 * 60_000
const HEX64 = /^[0-9a-f]{64}$/

const exec = promisify(execFile)
const now = () => Math.floor(Date.now() / 1000)
const sha256 = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex')
const tag = (event: Event, name: string) => event.tags.find(tag => tag[0] === name)?.[1]
const log = (line: string) => process.stderr.write(`buzz hub: ${line}\n`)
// Readers check content against sha256, and a default TextDecoder drops a leading BOM.
const utf8 = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true })

// The memory panel (NIP-AE) shows SOUL.md as the core record and each `## ` section
// of MEMORY.md as a memory. Agent Files shows the shared files and takes the owner's edits.
export function startMemory({ relay, secretKey, owner, hexDir, share = SHARE }: {
  relay: Relay
  secretKey: Uint8Array
  owner: string
  hexDir: string
  share?: string[]
}) {
  const key = getConversationKey(secretKey, owner)
  const engrams = book(ENGRAM, 'agent-memory/v1/d-tag', body => body?.slug)
  const records = book(FILE, 'agent-files/v1/d-tag', recordPath)
  const shared = share.map(entry => posix.normalize(entry).replace(/\/$/, '')).filter(entry => valid(entry) || void log(`can't share ${entry}, paths stay inside the hex folder`))
  const answered = new Set<string>()
  const watchers: FSWatcher[] = []
  let queue: Promise<unknown> = Promise.resolve()
  let timer: ReturnType<typeof setTimeout> | undefined
  let sharing = true
  let edits: (() => void) | undefined
  let closed = false

  function address(domain: string, name: string) {
    return createHmac('sha256', key).update(`${domain}\0${name}`).digest('hex')
  }

  function open(event: Event): { text: string; body: any } | undefined {
    try {
      if (!verifyEvent(event)) return
      const text = decrypt(event.content, key)
      return { text, body: JSON.parse(text) }
    } catch {}
  }

  // Own addressable records, newest per name, so only what changed is published again.
  function book(kind: number, domain: string, nameOf: (body: any) => unknown) {
    const heads = new Map<string, { text: string; at: number; id: string }>()
    let loaded: Promise<void> | undefined

    async function load() {
      for (const event of await relay.query([{ kinds: [kind], authors: [relay.pubkey], '#p': [owner] }])) {
        const opened = open(event)
        const name = opened && nameOf(opened.body)
        if (typeof name !== 'string' || address(domain, name) !== tag(event, 'd')) continue
        const head = heads.get(name)
        if (head && (head.at > event.created_at || (head.at === event.created_at && head.id < event.id))) continue
        heads.set(name, { text: opened!.text, at: event.created_at, id: event.id })
      }
    }

    async function put(name: string, body: object) {
      const text = JSON.stringify(body)
      const head = heads.get(name)
      if (head?.text === text) return
      if (Buffer.byteLength(text) > LIMIT) return log(`${name} is over 64 KB, so the Buzz panel doesn't get it`)
      const event = await relay.publish({
        kind,
        content: encrypt(text, key),
        tags: [['d', address(domain, name)], ['p', owner]],
        created_at: Math.max(now(), (head?.at ?? 0) + 1),
      })
      heads.set(name, { text, at: event.created_at, id: event.id })
    }

    return {
      async sync(wanted: Map<string, object>, gone: (name: string) => object | undefined) {
        await (loaded ??= load().catch(error => {
          loaded = undefined
          throw error
        }))
        for (const [name, body] of wanted) await put(name, body)
        for (const name of heads.keys()) {
          const body = wanted.has(name) ? undefined : gone(name)
          if (body) await put(name, body)
        }
      },
    }
  }

  function read(path: string) {
    try {
      return readFileSync(join(hexDir, path), 'utf8')
    } catch {}
  }

  function memories() {
    const wanted = new Map<string, object>()
    const soul = read('SOUL.md')
    if (soul !== undefined) wanted.set('core', { slug: 'core', profile: soul })
    for (const section of (read('MEMORY.md') ?? '').split(/^## /m).slice(1)) {
      const [heading = '', ...lines] = section.split('\n')
      const value = lines.join('\n').trim()
      const base = `mem/${slugify(heading)}`
      let slug = base
      for (let n = 2; wanted.has(slug); n++) slug = `${base}-${n}`
      if (value) wanted.set(slug, { slug, value })
    }
    return wanted
  }

  function files() {
    const found = new Map<string, Buffer>()
    function visit(path: string) {
      if (!valid(path)) return
      const full = join(hexDir, path)
      try {
        const stat = lstatSync(full)
        if (stat.isFile()) found.set(path, readFileSync(full))
        if (stat.isDirectory()) for (const name of readdirSync(full)) if (!name.startsWith('.')) visit(`${path}/${name}`)
      } catch {}
    }
    for (const entry of shared) visit(entry)
    return new Map([...found].map(([path, bytes]) => [path, record(path, bytes)]))
  }

  function run(task: () => Promise<unknown>) {
    queue = queue.then(() => (closed ? undefined : task())).catch(error => log(`memory: ${error instanceof Error ? error.message : error}`))
  }

  function later() {
    clearTimeout(timer)
    timer = setTimeout(sync, SETTLE)
  }

  function sync() {
    arm()
    run(() => engrams.sync(memories(), slug => (slug === 'core' ? undefined : { slug, value: null })))
    run(publish)
  }

  async function publish() {
    if (!sharing) return
    try {
      await records.sync(files(), path => ({ path, removed: true }))
    } catch (error) {
      if (!String(error).includes('unknown event kind')) throw error
      sharing = false
      return log(`this relay doesn't take Agent Files yet (${error instanceof Error ? error.message : error}), so shared files stay off`)
    }
    edits ??= await listen()
  }

  async function listen() {
    for (const event of await relay.query([{ kinds: [RESULT], authors: [relay.pubkey], '#p': [owner] }])) answered.add(tag(event, 'e') ?? '')
    if (closed) return
    return relay.subscribe([{ kinds: [EDIT], authors: [owner], '#p': [relay.pubkey] }], event => run(() => answer(event)))
  }

  // A request that can't be read or names an invalid path gets no answer, as NIP-AF says.
  async function answer(event: Event) {
    if (answered.has(event.id) || event.pubkey !== owner) return
    const addressed = event.tags.filter(tag => tag[0] === 'p')
    const request = addressed.length === 1 && addressed[0]![1] === relay.pubkey ? open(event)?.body : undefined
    if (!editRequest(request)) {
      answered.add(event.id)
      return log(`ignored an unreadable edit request ${event.id}`)
    }
    const result = await edit(request)
    await relay.publish({ kind: RESULT, content: encrypt(JSON.stringify(result), key), tags: [['p', owner], ['e', event.id]] })
    answered.add(event.id)
  }

  // The file on disk decides, as found by the same scan that shares it, so a
  // symlink or a path outside the share list is never written.
  async function edit({ path, base_sha256: base, content }: { path: string; base_sha256: string; content: string }) {
    const current = files().get(path)
    if (!current) return { status: 'declined', path, reason: 'file is not shared' }
    if (!('content' in current)) return { status: 'declined', path, reason: 'file is too large or not text' }
    if (current.sha256 !== base) return { status: 'conflict', path, sha256: current.sha256 }
    const full = join(hexDir, path)
    const bytes = Buffer.from(content)
    const sha = sha256(bytes)
    writeFileSync(`${full}.tmp`, bytes, { mode: statSync(full).mode })
    renameSync(`${full}.tmp`, full)
    await commit(path)
    await publish()
    return { status: 'applied', path, sha256: sha }
  }

  async function commit(path: string) {
    try {
      await exec('git', ['-C', hexDir, 'rev-parse', '--git-dir'])
    } catch {
      return
    }
    try {
      await exec('git', ['-C', hexDir, 'add', '--', path])
      await exec('git', ['-C', hexDir, 'commit', '-q', '-m', `${path}: edited in Buzz`, '--', path])
    } catch (error) {
      log(`couldn't commit ${path}: ${error instanceof Error ? error.message.trim() : error}`)
    }
  }

  function arm() {
    for (const watcher of watchers.splice(0)) watcher.close()
    if (closed) return
    const top = new Set(['SOUL.md', 'MEMORY.md', ...shared.map(entry => entry.split('/')[0])])
    for (const dir of ['', ...shared]) {
      const full = join(hexDir, dir)
      try {
        if (dir && !statSync(full).isDirectory()) continue
        watchers.push(watch(full, { recursive: !!dir }, (_, name) => (dir || top.has(String(name))) && later()).on('error', () => {}))
      } catch {}
    }
  }

  sync()
  const resync = setInterval(sync, RESYNC)

  return {
    close() {
      closed = true
      clearTimeout(timer)
      clearInterval(resync)
      for (const watcher of watchers.splice(0)) watcher.close()
      edits?.()
    },
  }
}

function record(path: string, bytes: Buffer): { path: string; sha256: string; size: number; content?: string } {
  const listed = { path, sha256: sha256(bytes), size: bytes.length }
  try {
    const inlined = { ...listed, content: utf8.decode(bytes) }
    if (Buffer.byteLength(JSON.stringify(inlined)) <= LIMIT) return inlined
  } catch {}
  return listed
}

// A file record body as NIP-AF defines it; anything else never counts as a head.
function recordPath(body: any) {
  if (typeof body?.path !== 'string' || !valid(body.path)) return
  if ('removed' in body) return body.removed === true ? body.path : undefined
  const { sha256: sha, size, content } = body
  if (typeof sha !== 'string' || !HEX64.test(sha) || !Number.isSafeInteger(size) || size < 0) return
  if (content !== undefined && (typeof content !== 'string' || Buffer.byteLength(content) !== size || sha256(Buffer.from(content)) !== sha)) return
  return body.path
}

function editRequest(body: any): body is { path: string; base_sha256: string; content: string } {
  return typeof body?.path === 'string' && valid(body.path) && typeof body.base_sha256 === 'string' && HEX64.test(body.base_sha256) && typeof body.content === 'string'
}

function slugify(heading: string) {
  const parts = heading.normalize('NFKD').toLowerCase().split('/').map(part => part.replace(/[^a-z0-9_-]+/g, '-').replace(/^[-_]+|-+$/g, '').slice(0, 64))
  return parts.filter(Boolean).join('/') || 'section'
}

function valid(path: string) {
  return Buffer.byteLength(path) <= 255 && !/[\\\p{Cc}]/u.test(path) && path.split('/').every(part => part && part !== '.' && part !== '..')
}
