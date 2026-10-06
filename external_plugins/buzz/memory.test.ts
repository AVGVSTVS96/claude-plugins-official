import { afterEach, beforeEach, expect, test } from 'bun:test'
import { execFileSync } from 'child_process'
import { createHash, createHmac } from 'crypto'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { finalizeEvent, getEventHash, getPublicKey, type Event } from 'nostr-tools/pure'
import { matchFilters, type Filter } from 'nostr-tools/filter'
import { decrypt, encrypt, getConversationKey } from 'nostr-tools/nip44'
import { schnorr } from '@noble/curves/secp256k1.js'
import { startMemory } from './memory.ts'

const AGENT_KEY = Buffer.from('0000000000000000000000000000000000000000000000000000000000000001', 'hex')
const OWNER_KEY = Buffer.from('0000000000000000000000000000000000000000000000000000000000000002', 'hex')
const AGENT = getPublicKey(AGENT_KEY)
const OWNER = getPublicKey(OWNER_KEY)
const KEY = getConversationKey(OWNER_KEY, AGENT)

let dir: string
const running: { close(): void }[] = []

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'memory-'))
})

afterEach(() => {
  for (const memory of running.splice(0)) memory.close()
  rmSync(dir, { recursive: true, force: true })
})

// Stores what's published and serves it back to queries and subscriptions, like the relay does.
function fakeRelay(refuse?: (kind: number) => string | undefined) {
  const events: Event[] = []
  const attempts: number[] = []
  const subs = new Set<{ filters: Filter[]; onEvent: (event: Event) => void }>()
  function add(event: Event) {
    events.push(event)
    for (const sub of subs) if (matchFilters(sub.filters, event)) sub.onEvent(event)
  }
  return {
    events,
    attempts,
    subs,
    feed: add,
    relay: {
      pubkey: AGENT,
      async publish(template: { kind: number; content: string; tags: string[][]; created_at?: number }) {
        attempts.push(template.kind)
        const reason = refuse?.(template.kind)
        if (reason) throw new Error(reason)
        const event = finalizeEvent({ created_at: Math.floor(Date.now() / 1000), ...template }, AGENT_KEY)
        add(event)
        return event
      },
      subscribe(filters: Filter[], onEvent: (event: Event) => void) {
        const sub = { filters, onEvent }
        subs.add(sub)
        queueMicrotask(() => events.filter(event => matchFilters(filters, event)).forEach(onEvent))
        return () => void subs.delete(sub)
      },
      async query(filters: Filter[]) {
        return events.filter(event => matchFilters(filters, event))
      },
      close() {},
    },
  }
}

function start(relay: ReturnType<typeof fakeRelay>, share?: string[]) {
  const memory = startMemory({ relay: relay.relay, secretKey: AGENT_KEY, owner: OWNER, hexDir: dir, share })
  running.push(memory)
  return memory
}

function write(path: string, content: string | Uint8Array) {
  mkdirSync(join(dir, path, '..'), { recursive: true })
  writeFileSync(join(dir, path), content)
}

function opened(relay: ReturnType<typeof fakeRelay>, kind: number) {
  return relay.events.filter(event => event.kind === kind).map(event => ({ event, text: decrypt(event.content, KEY), body: JSON.parse(decrypt(event.content, KEY)) }))
}

async function until<T>(check: () => T | undefined, timeout = 3000): Promise<T> {
  for (const end = Date.now() + timeout; Date.now() < end; await Bun.sleep(20)) {
    const value = check()
    if (value) return value
  }
  throw new Error('timed out')
}

const sha256 = (data: string | Uint8Array) => createHash('sha256').update(data).digest('hex')
const fileTag = (path: string) => createHmac('sha256', KEY).update(`agent-files/v1/d-tag\0${path}`).digest('hex')

function request(relay: ReturnType<typeof fakeRelay>, body: object) {
  const event = finalizeEvent({ kind: 4180, created_at: Math.floor(Date.now() / 1000), tags: [['p', AGENT]], content: encrypt(JSON.stringify(body), KEY) }, OWNER_KEY)
  relay.feed(event)
  return event
}

function results(relay: ReturnType<typeof fakeRelay>) {
  return opened(relay, 4181).map(({ event, body }) => ({ tags: event.tags, ...body }))
}

const VECTORS = {
  conversationKey: 'c41c775356fd92eadc63ff5a0dc1da211b268cbea22316767095b2871ea1412d',
  example: {
    d: '72d4f9629106451505d7d341ea85bb3ebad4f654fcfd2aad100d5a35f8a85cba',
    body: '{"slug":"mem/example","value":"hello, agent memory"}',
    created_at: 1700000000,
    nonce: 1,
    content: 'AgAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAABedgcxyfmpph68LBjCWZsTI5lb0Cbg8dIPVYVe/WVj/l4Yd8HGgzC8awyBi9bn9ClRdtd2IPsmont0jN/cajVSQhahTOwuNNwoJtZIg35aSsUzeCq4tQfd8E+fLoKomdPxjs=',
    id: 'f4a594177b7aeea4fe99a09efbf74ae85f0126244f322135682c405888a38689',
    sig: '0a4582f0bc5995b9a010afda5984f568055988ebbe4552b4e0ec6d11aeb2b303af940f3d84726a7edd1763badb284eb3aa8457664ceba85a90d6252ed4b494cb',
  },
  notes: {
    d: '31651571a312780cfdc1f0b706b682ac9f3f51a053e8dca76fe57710bae5a4d4',
    body: '{"slug":"mem/notes/2026-05-12","value":"meeting note: [[mem/example]]"}',
    created_at: 1700000001,
    nonce: 2,
    content: 'AgAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAACG/JBPvdZxDwAxOG7bY3AW2q1slZqBjQC3NxfPVtfcR+TGjp2GKtjyXyqNwG08GK+00I1u1vUZ4cCjcun9A7ra92rleKKJ5w57pqgFspbv1vClUJY5487A/5phVDHkw6DhRCSMDpEMw5Tapj3Wm1ponAVr5PciPOrTxltEfTVdSKaPA==',
    id: '1a43298ea1fa9b73462a85b9f16f5f6bd2a7ab18b0b02424e5ec3f3b8a48e030',
    sig: 'dc9da456db1c89f070edc5f994786f270fc00e8ff19f33d5b0f6cea49421cd727fcd79bb288f3e3dbd5af9ca1ba67f9bd11b02a47c1e6c37cfd32665c17e4a24',
  },
  tombstone: {
    d: '72d4f9629106451505d7d341ea85bb3ebad4f654fcfd2aad100d5a35f8a85cba',
    body: '{"slug":"mem/example","value":null}',
    created_at: 1700000002,
    nonce: 3,
    content: 'AgAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAADuau8i0Wu4+ULnp2qTfd+O23jJAapMRrKGGwabNVOlT9hSF8FViBHIS6f86/7xK4qGOin4IH8Wr/3cvHDcQGQd3IXQJr8LHgJkaYpQPdBO1bgqiFu8K3L/CLb1PgG1X7RQ8E=',
    id: 'c8604bef05295856a67a88ec895e07b5b47a2febc23c82934734096a7b123b63',
    sig: 'c8d53859cf08b3a9a20a5b01c61d12fa2f082f462adb635420f05dc6f9bb662a174e729023854bf53e5e35fae8f6f4c9d604e8979a070e298cd77cfb7e6b6468',
  },
  core: {
    d: 'bdc233238ffe52e272b44cc233c8f33a2bc510b08be04495b225964283be4a90',
    body: '{"slug":"core","profile":"test agent. see [[mem/example]] and [[mem/notes/2026-05-12]]."}',
    created_at: 1700000003,
    nonce: 4,
    content: 'AgAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAEEeZHAFjhc8DAcKaVSSB7IoKG3nr+dX3LXlU7UIdOKayhIVPXvl4WuFmBSVxLO6yEV5vnLvzbo7rU0uPRYyAJLPNnifVTCw2EQZH70zOwTc/mVvaATHKzqcFo5VHrbpKNTzeNnz1Vds2yg2DXmdxaoWQA4YfnlLwZDOpyu9JP1uB1Yw==',
    id: '980419c4d231266471242456c832d0c2eb1e6974468dc795f3ae327484129058',
    sig: 'ce113fff1205eadb38928b224a90247be1a00b0c3f8ab583d4a5f7274ddba51ebb5eb9d627d44664a78d2e870e61835cf61446cc812ecea139e8b7d41b8e238f',
  },
}

// Seals what memory.ts published with the vector's pinned nonce, time and aux,
// which must give back the published NIP-AE event byte for byte.
function expectVector(published: { event: Event; text: string }, vector: (typeof VECTORS)['core']) {
  expect(published.event.tags).toEqual([['d', vector.d], ['p', OWNER]])
  expect(published.text).toBe(vector.body)
  const content = encrypt(published.text, KEY, Buffer.from(vector.nonce.toString(16).padStart(64, '0'), 'hex'))
  const id = getEventHash({ kind: 30174, pubkey: AGENT, created_at: vector.created_at, tags: published.event.tags, content })
  const sig = Buffer.from(schnorr.sign(Buffer.from(id, 'hex'), AGENT_KEY, new Uint8Array(32))).toString('hex')
  expect({ content, id, sig }).toEqual({ content: vector.content, id: vector.id, sig: vector.sig })
}

test('SOUL.md and MEMORY.md reproduce the NIP-AE test vectors, and a removed section is tombstoned', async () => {
  expect(Buffer.from(getConversationKey(AGENT_KEY, OWNER)).toString('hex')).toBe(VECTORS.conversationKey)
  write('SOUL.md', 'test agent. see [[mem/example]] and [[mem/notes/2026-05-12]].')
  write('MEMORY.md', '# Memory\n\n## Example\nhello, agent memory\n\n## Notes/2026-05-12\nmeeting note: [[mem/example]]\n')
  const relay = fakeRelay()
  start(relay, [])
  await until(() => relay.events.length === 3)
  const [core, example, notes] = opened(relay, 30174)
  expectVector(core!, VECTORS.core)
  expectVector(example!, VECTORS.example)
  expectVector(notes!, VECTORS.notes)

  write('MEMORY.md', '# Memory\n\n## Notes/2026-05-12\nmeeting note: [[mem/example]]\n')
  await until(() => relay.events.length === 4)
  const tombstone = opened(relay, 30174)[3]!
  expectVector(tombstone, VECTORS.tombstone)
  expect(tombstone.event.created_at).toBeGreaterThan(example!.event.created_at)
})

test('only changed sections are published again, empty ones never, and a restart publishes nothing new', async () => {
  write('SOUL.md', '# Who you are\n')
  write('MEMORY.md', '# Memory\n\n## Me\n- Bassim\n\n## Preferences\n\n## Machines\n- server: CachyOS\n')
  const relay = fakeRelay()
  start(relay, [])
  await until(() => relay.events.length === 3)
  expect(opened(relay, 30174).map(({ body }) => body)).toEqual([
    { slug: 'core', profile: '# Who you are\n' },
    { slug: 'mem/me', value: '- Bassim' },
    { slug: 'mem/machines', value: '- server: CachyOS' },
  ])

  write('MEMORY.md', '# Memory\n\n## Me\n- Bassim\n\n## Preferences\n\n## Machines\n- server: CachyOS\n- mac: M1 Max\n')
  await until(() => relay.events.length === 4)
  expect(opened(relay, 30174)[3]!.body).toEqual({ slug: 'mem/machines', value: '- server: CachyOS\n- mac: M1 Max' })

  running.pop()!.close()
  start(relay, [])
  await Bun.sleep(300)
  expect(relay.events.length).toBe(4)
})

test('shared files are published with their content, listed when it cannot be inlined, and removed when gone', async () => {
  write('AGENTS.md', '@SOUL.md\n')
  write('SOUL.md', '# Who you are\n')
  write('notes/plan.md', 'ship it\n')
  write('notes/bom.md', '﻿with a BOM\n')
  write('notes/big.txt', 'x'.repeat(70_000))
  write('notes/photo.bin', new Uint8Array([0xff, 0xd8, 0xff]))
  write('notes/.hidden', 'secret')
  write('notes/.git/config', 'x')
  const relay = fakeRelay()
  start(relay, ['AGENTS.md', 'SOUL.md', 'MEMORY.md', 'notes/'])
  await until(() => opened(relay, 30180).length === 6)
  const records = Object.fromEntries(opened(relay, 30180).map(({ event, body }) => [body.path, { d: event.tags, ...body }]))
  expect(Object.keys(records).sort()).toEqual(['AGENTS.md', 'SOUL.md', 'notes/big.txt', 'notes/bom.md', 'notes/photo.bin', 'notes/plan.md'])
  expect(records['AGENTS.md']).toEqual({ d: [['d', fileTag('AGENTS.md')], ['p', OWNER]], path: 'AGENTS.md', sha256: sha256('@SOUL.md\n'), size: 9, content: '@SOUL.md\n' })
  expect(records['notes/bom.md'].content).toBe('﻿with a BOM\n')
  expect(records['notes/bom.md'].sha256).toBe(sha256(readFileSync(join(dir, 'notes/bom.md'))))
  expect(records['notes/big.txt']).toMatchObject({ size: 70_000, sha256: sha256('x'.repeat(70_000)) })
  expect(records['notes/big.txt']).not.toHaveProperty('content')
  expect(records['notes/photo.bin']).not.toHaveProperty('content')

  running.pop()!.close()
  start(relay, ['AGENTS.md', 'SOUL.md', 'MEMORY.md', 'notes'])
  await Bun.sleep(300)
  expect(opened(relay, 30180).length).toBe(6)

  rmSync(join(dir, 'AGENTS.md'))
  await until(() => opened(relay, 30180).length === 7)
  expect(opened(relay, 30180)[6]!.text).toBe('{"path":"AGENTS.md","removed":true}')

  running.pop()!.close()
  start(relay, ['SOUL.md'])
  await until(() => opened(relay, 30180).length === 11)
  expect(opened(relay, 30180).slice(7).map(({ body }) => body.removed && body.path).sort()).toEqual(['notes/big.txt', 'notes/bom.md', 'notes/photo.bin', 'notes/plan.md'])
})

test('an edit request is written, committed, republished and answered', async () => {
  write('AGENTS.md', '# My rules for you\n')
  execFileSync('git', ['init', '-q', dir])
  execFileSync('git', ['-C', dir, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '--allow-empty', '-m', 'start'])
  execFileSync('git', ['-C', dir, 'config', 'user.name', 'Hex'])
  execFileSync('git', ['-C', dir, 'config', 'user.email', 'hex@example.com'])
  write('MEMORY.md', 'not part of the commit\n')
  const relay = fakeRelay()
  start(relay)
  await until(() => relay.subs.size)
  const edit = request(relay, { path: 'AGENTS.md', base_sha256: sha256('# My rules for you\n'), content: '# My rules for you\n- be brief\n' })
  const [result] = await until(() => results(relay).length && results(relay))
  expect(result).toEqual({ tags: [['p', OWNER], ['e', edit.id]], status: 'applied', path: 'AGENTS.md', sha256: sha256('# My rules for you\n- be brief\n') })
  expect(readFileSync(join(dir, 'AGENTS.md'), 'utf8')).toBe('# My rules for you\n- be brief\n')
  expect(opened(relay, 30180).at(-1)!.body).toMatchObject({ path: 'AGENTS.md', content: '# My rules for you\n- be brief\n' })
  expect(relay.events.findIndex(event => event.kind === 4181)).toBeGreaterThan(relay.events.indexOf(opened(relay, 30180).at(-1)!.event))
  expect(execFileSync('git', ['-C', dir, 'log', '-1', '--format=%s', '--name-only'], { encoding: 'utf8' })).toBe('AGENTS.md: edited in Buzz\n\nAGENTS.md\n')
  expect(execFileSync('git', ['-C', dir, 'status', '--porcelain'], { encoding: 'utf8' })).toBe('?? MEMORY.md\n')
})

test('the file on disk decides: stale edits conflict, unshared, hidden, linked and uninlined files are declined, invalid paths get no answer', async () => {
  write('AGENTS.md', 'now\n')
  write('notes/.env', 'TOKEN=1\n')
  write('notes/big.txt', 'x'.repeat(70_000))
  write('state/access.json', '{}')
  write('outside.md', 'mine\n')
  symlinkSync(join(dir, 'outside.md'), join(dir, 'notes/link.md'))
  const relay = fakeRelay()
  start(relay, ['AGENTS.md', 'notes'])
  await until(() => relay.subs.size)
  request(relay, { path: 'AGENTS.md', base_sha256: sha256('before\n'), content: 'mine\n' })
  request(relay, { path: 'notes/.env', base_sha256: sha256('TOKEN=1\n'), content: 'TOKEN=2\n' })
  request(relay, { path: 'state/access.json', base_sha256: sha256('{}'), content: '[]' })
  request(relay, { path: 'notes/link.md', base_sha256: sha256('mine\n'), content: 'yours\n' })
  request(relay, { path: 'notes/big.txt', base_sha256: sha256('x'.repeat(70_000)), content: 'x' })
  request(relay, { path: 'notes/gone.md', base_sha256: sha256(''), content: 'x' })
  request(relay, { path: '../outside.md', base_sha256: sha256('mine\n'), content: 'x' })
  request(relay, { path: 'AGENTS.md', base_sha256: 'BEFORE', content: 'x' })
  request(relay, { path: 'AGENTS.md', base_sha256: sha256('now\n'), content: 'next\n' })
  request(relay, { path: 'AGENTS.md', base_sha256: sha256('now\n'), content: 'next\n' })
  await until(() => results(relay).length === 8)
  await Bun.sleep(100)
  const notShared = (path: string) => ({ status: 'declined', path, reason: 'file is not shared' })
  expect(results(relay).map(({ tags, ...result }) => result)).toEqual([
    { status: 'conflict', path: 'AGENTS.md', sha256: sha256('now\n') },
    notShared('notes/.env'),
    notShared('state/access.json'),
    notShared('notes/link.md'),
    { status: 'declined', path: 'notes/big.txt', reason: 'file is too large or not text' },
    notShared('notes/gone.md'),
    { status: 'applied', path: 'AGENTS.md', sha256: sha256('next\n') },
    { status: 'conflict', path: 'AGENTS.md', sha256: sha256('next\n') },
  ])
  expect(readFileSync(join(dir, 'AGENTS.md'), 'utf8')).toBe('next\n')
  expect(readFileSync(join(dir, 'notes/.env'), 'utf8')).toBe('TOKEN=1\n')
  expect(readFileSync(join(dir, 'outside.md'), 'utf8')).toBe('mine\n')
  expect(opened(relay, 30180).map(({ body }) => body.path)).not.toContain('notes/link.md')
})

test('after a restart, answered requests are not applied again and ones sent while offline are', async () => {
  write('AGENTS.md', 'one\n')
  const relay = fakeRelay()
  start(relay)
  await until(() => relay.subs.size)
  request(relay, { path: 'AGENTS.md', base_sha256: sha256('one\n'), content: 'two\n' })
  await until(() => results(relay).length === 1)
  running.pop()!.close()

  write('AGENTS.md', 'three\n')
  const offline = request(relay, { path: 'AGENTS.md', base_sha256: sha256('three\n'), content: 'four\n' })
  start(relay)
  await until(() => results(relay).length === 2)
  await Bun.sleep(300)
  expect(results(relay).slice(1)).toEqual([{ tags: [['p', OWNER], ['e', offline.id]], status: 'applied', path: 'AGENTS.md', sha256: sha256('four\n') }])
  expect(readFileSync(join(dir, 'AGENTS.md'), 'utf8')).toBe('four\n')
})

test('a relay without Agent Files refuses one record and memory keeps working', async () => {
  write('SOUL.md', 'me\n')
  write('AGENTS.md', 'rules\n')
  const relay = fakeRelay(kind => (kind === 30174 ? undefined : 'restricted: unknown event kind'))
  start(relay)
  await until(() => relay.events.length === 1)
  write('SOUL.md', 'me, changed\n')
  await until(() => relay.events.length === 2)
  expect(opened(relay, 30174).map(({ body }) => body.profile)).toEqual(['me\n', 'me, changed\n'])
  expect(relay.attempts.filter(kind => kind === 30180)).toEqual([30180])
  expect(relay.subs.size).toBe(0)
})

const FILES = {
  notes: {
    body: '{"path":"notes.md","sha256":"38d997fefd1b7e6bb304b744dc708cc5e42ff41414e3e2878e3656c8f5ad02e4","size":19,"content":"hello, agent files\\n"}',
    d: '6a2ae802e89df6c3311cc145e4fd40280669b2853d13ca80b920ec7ac36a1160',
    created_at: 1700000000,
    nonce: 1,
    content: 'AgAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAABeWYcxyTrp5d68LBgA38mWthpZhLbxJYMfhJBIaLKj/BibYNSQQWLt6lkAXZKid+iG4Qbw5alru2O5QNHEsvgLDxoohNxwegWO+R8ZglzvKJvONpvb2DQgtDOCoAHlk4U79qce+Bc6EPESBbYYhyTsoZ3K4phyhQbPf4Wf17d6VrIjF90VGEnjdGQ8+kf9Q+LvFbLZK5Yy8TJmm+uSe6nruhmEJtEgN+E4HqYl3hm3wi0I7zDVq6XE5YP8+33SUgi3Fw=',
    id: 'ffedcefb2ceca14ebd23fc5832be2eaece81364e5749b40551febb34ece68129',
    sig: '851749264f0ee6cc356343942f6a8987687eeeb36718624459c8057ebd910676afa566280b06896b627e024b99a5ac65508c98becca7359873e2241ef9b46db6',
  },
  plan: {
    body: '{"path":"PLANS/agent files.md","sha256":"c3964bb3b70a957ec9b233c7dd3653f6ba17701ab00facf88ae1393dc6155577","size":7,"content":"# Plan\\n"}',
    d: 'f1a77048f250f512bdae879a96da177787f71a9b33e5218d255d99c8cf33a134',
    created_at: 1700000001,
    nonce: 2,
    content: 'AgAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAACGzxBPvRUxTMAxOGGRKGhZiqgsEArQCRWg50Ke1gDJx+TGj9/Fewz3WSyeAfivT3k1gBothiBPJ5s4cOhoEO8II+l0uqLSfcuoPyWdKtqiGzypCM6179dYp0PvWim9j+wvCOLYun2TmeW8X9jYUNEs30aK7W0KxbM0JFd90vjbhlIh9YFQzQmV/gd5sN2BqBULXmmZgc5sMVzdb8DKkbG4CfkSf4eefdbfkQh4P8Adrk5gFTQ3MMFjBFsMXvjpLUQrAs=',
    id: '7057f1c1826c58d24cd61bd2ca084e6ebe3ac23e9d664deb286629e029d43da4',
    sig: 'c72a734e84af6b038e7c28dfefba7576b0bcb02f385bd38a99ce7c4795b867dc6d27e72d446aed33c2fcf4a211099fd55fc135ee3236f863180baa56a18ff751',
  },
  big: {
    body: '{"path":"logs/big.log","sha256":"66915c0872933db504e7578828dd85b7e74a4e0a061f9756793b89c4151bd4b5","size":70000}',
    d: '3eba5168333f7a57b7d9967429fc681a45affe7e5a182e84d5c588c1f8da1d47',
    created_at: 1700000002,
    nonce: 3,
    content: 'AgAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAADufi8i0aj4uoLnp2rR/0icXfrLlipO1/EFjgIaMEZgjMtBxFfHRl2FE2vy5jJ/Z0ZfIqS0LWZbYrASsnxSWX0T0d1keXs2rhM8a/1YsmLEwPZUyetBJ6AUQpEoMjyKlwhJ8hHY02Z/WmOvJ+eAcSak81lFyUYqr/Q+r9Vu8cOmTJd+doLd9zrrbg1weUnGD1ZxHH403ggde05EdOMG+BgzCWm',
    id: '6ba315bfc0b986c56662e78e94de1a5df07fdee30e410e2b84e62b1608b3fba7',
    sig: '5b73e8ffda0caeb76fac13150a2e617b2b4bb0b1c1a38dbee6619a5ee5852ed81ee1b0a3e6d80733e0d47f57625303988d842285880189c4656a0c4a81254947',
  },
  removed: {
    body: '{"path":"notes.md","removed":true}',
    d: '6a2ae802e89df6c3311cc145e4fd40280669b2853d13ca80b920ec7ac36a1160',
    created_at: 1700000003,
    nonce: 4,
    content: 'AgAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAEEZ1HAFvscs/AcKaYSSZ7c4DJyiq9MWbCVhh3F5cJYKzzNVHP0Co4mCrkLHwQYMHhOrSCVp2209axj77xAk5tDKg8mc1ZeRGDsVVtCEMHNYahgYEMzcE4bH/po+T3shhnl0c=',
    id: '1bec75664cb1939429d2f18b0a431dac23c5557668ac28665fa4ce7b2024c38a',
    sig: 'ff395138e65c57fa113c59c70e60f82a6ef47738a2de72fc9ab527c399f852836f7b74ce792b568ac7fec7986801d674c4881d87d21df4f87b4b413fc8bc0600',
  },
  applied: {
    body: '{"status":"applied","path":"PLANS/agent files.md","sha256":"e62b5d89e5ee431c4431bed125f015eaf4b952c81d55d5577487a5f1efc89786"}',
    created_at: 1700000005,
    nonce: 6,
    content: 'AgAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAG2YpLVPS9j3qTMUV7xmqgMArZz1CjPEhhG0JsgG4XHf+FPtdlkCm4jFwS+VjJVE34cm3MoDwj2pcQhaj+htkGXJs4d7jd6KwsQ0BEMJzlNzuIPtLQz4n4ondlvElmfJ8A9ERMkc7h/IEgSUNSLF1J/9bVHdCtJeL7A08N2xOw5vsXZv/FO37yF0CVL7K6pCUlCPFHr6K/KbMaFHDFC8bu0Ajk',
    id: '5bc47d506d8eb863d57d5c00308f8e864d0f201ce5e881d58be43ab4ab3492e3',
    sig: '3cc169f878ebda8ff972e3864475b14184dd14d8b6a62f22e88f2a84955391e4c8902761553a78e345245c4d6e2ce809d594f1cc4447a998f062424f3944ada9',
  },
}

// NIP-AF's Event 5, the owner's edit request, exactly as published.
const EDIT_REQUEST: Event = {
  kind: 4180,
  pubkey: OWNER,
  created_at: 1700000004,
  tags: [['p', AGENT]],
  content: 'AgAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAFxUvaeNKl0ciXDyss+prpTNPK3paTrOuWRaJv0G9O6yQ57/2WtCobF8+8BMczu9OQI4Q9KwSBdWkY8Ip329LNeWAYp5u5pPq6pcxk/n3lIITYflSIQ+xSL+Q7Z3J4Nl1W4sFSQVcEqz7vBIYEE1qQDNS9vhdTUr+iNPkyvK4eTC4HtGywJUG1vzo4lQxPLf9go1gQAgGTZd97QXNgYSm9wmuVLpCkQm34rQJWejJvvI7CTY5h5m6BsjqGG39EahG9EzE=',
  id: '3fe347efff08d8f3da196d35a02d73207fe91cb463c8d122d9681af4552493f1',
  sig: '06819ae9d529f977ebfb4e569efac6e232d13cbf197824f6302c373178b5d1e90228fa397217f58e10616dba1fd98d48e05ca673c2b7a400026df038a1fac0c9',
}

function expectFileVector(published: { event: Event; text: string }, vector: { body: string; d?: string; created_at: number; nonce: number; content: string; id: string; sig: string }) {
  expect(published.text).toBe(vector.body)
  if (vector.d) expect(published.event.tags).toEqual([['d', vector.d], ['p', OWNER]])
  const content = encrypt(published.text, KEY, Buffer.from(vector.nonce.toString(16).padStart(64, '0'), 'hex'))
  const id = getEventHash({ kind: published.event.kind, pubkey: AGENT, created_at: vector.created_at, tags: published.event.tags, content })
  const sig = Buffer.from(schnorr.sign(Buffer.from(id, 'hex'), AGENT_KEY, new Uint8Array(32))).toString('hex')
  expect({ content, id, sig }).toEqual({ content: vector.content, id: vector.id, sig: vector.sig })
}

test('shared files reproduce the NIP-AF test vectors: records, a tombstone for a file deleted while down, and an applied edit', async () => {
  write('notes.md', 'hello, agent files\n')
  write('PLANS/agent files.md', '# Plan\n')
  write('logs/big.log', 'a'.repeat(70_000))
  const relay = fakeRelay()
  start(relay, ['notes.md', 'PLANS', 'logs'])
  await until(() => opened(relay, 30180).length === 3)
  const byPath = (path: string) => opened(relay, 30180).findLast(({ body }) => body.path === path)!
  expectFileVector(byPath('notes.md'), FILES.notes)
  expectFileVector(byPath('PLANS/agent files.md'), FILES.plan)
  expectFileVector(byPath('logs/big.log'), FILES.big)

  running.pop()!.close()
  rmSync(join(dir, 'notes.md'))
  start(relay, ['notes.md', 'PLANS', 'logs'])
  await until(() => opened(relay, 30180).length === 4)
  expectFileVector(opened(relay, 30180)[3]!, FILES.removed)
  expect(opened(relay, 30180)[3]!.event.created_at).toBeGreaterThan(opened(relay, 30180)[0]!.event.created_at)

  relay.feed(EDIT_REQUEST)
  const answer = await until(() => opened(relay, 4181)[0])
  expect(answer.event.tags).toEqual([['p', OWNER], ['e', EDIT_REQUEST.id]])
  expectFileVector(answer, FILES.applied)
  expect(readFileSync(join(dir, 'PLANS/agent files.md'), 'utf8')).toBe('# Plan\n\n- ship it\n')
  expect(byPath('PLANS/agent files.md').body).toEqual({ path: 'PLANS/agent files.md', sha256: sha256('# Plan\n\n- ship it\n'), size: 18, content: '# Plan\n\n- ship it\n' })
})

test('heads that break NIP-AF are not heads, and a new record lands after the newest valid one', async () => {
  write('notes.md', 'hello, agent files\n')
  const relay = fakeRelay()
  const future = Math.floor(Date.now() / 1000) + 600
  const forged = (body: object, created_at: number) =>
    relay.feed(finalizeEvent({ kind: 30180, created_at, tags: [['d', fileTag('notes.md')], ['p', OWNER]], content: encrypt(JSON.stringify(body), KEY) }, AGENT_KEY))
  forged({ path: 'notes.md', sha256: sha256('hello, agent files\n'), size: 19, content: 'hello, agent files\n' }, future)
  forged({ path: 'notes.md', sha256: sha256('hello, agent files\n'), size: 19, content: 'tampered\n' }, future + 5)
  start(relay, ['notes.md'])
  await Bun.sleep(300)
  expect(opened(relay, 30180).length).toBe(2)

  write('notes.md', 'changed\n')
  await until(() => opened(relay, 30180).length === 3)
  expect(opened(relay, 30180)[2]!.event.created_at).toBe(future + 1)
})
