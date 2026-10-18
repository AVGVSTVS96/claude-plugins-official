import { afterEach, beforeEach, expect, test } from 'bun:test'
import { Database } from 'bun:sqlite'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { createServer, type Server } from 'net'
import { tmpdir } from 'os'
import { join } from 'path'
import { Asks, fromLedger } from './asks.ts'
import { vet } from './check.ts'
import { T3 } from './t3.ts'

const GROUP = '-1001234'
const DESK = `${GROUP}:5`
let state: string
let asks: Asks
let hub: Server
let lines: any[]
let checks: string[]

function ledger(asks: object[], pins = {}) {
  writeFileSync(join(state, 'telegram', 'ledger.json'), JSON.stringify({ asks, pins }))
}

function asked(message: number, text: string, options: string[], fields = {}) {
  return { thread: DESK, message, text, options, at: `2026-10-13T1${message % 10}:00:00.000Z`, ...fields }
}

async function until<T>(check: () => T | undefined, timeout = 3000): Promise<T> {
  for (const end = Date.now() + timeout; Date.now() < end; await Bun.sleep(20)) {
    const value = check()
    if (value) return value
  }
  throw new Error('timed out')
}

beforeEach(async () => {
  state = mkdtempSync(join(tmpdir(), 'asks-'))
  mkdirSync(join(state, 'telegram'))
  mkdirSync(join(state, 'voice'))
  writeFileSync(join(state, 'telegram', 'threads.json'), JSON.stringify({ [GROUP]: { name: 'hex' }, [DESK]: { name: 'desk' } }))
  lines = []
  checks = []
  hub = createServer(socket => {
    socket.setEncoding('utf8')
    socket.on('data', (chunk: string) => lines.push(...chunk.trim().split('\n').map(line => JSON.parse(line))))
  })
  await new Promise<void>(resolve => hub.listen(join(state, 'telegram', 'hub.sock'), resolve))
})

afterEach(() => {
  asks?.close()
  hub.close()
  rmSync(state, { recursive: true, force: true })
})

test('a question asked with buttons reads as its first line, its context and the pick its thread marked', () => {
  const ask = fromLedger('telegram', asked(1, '**Music for the Saves video?**\n\nThree new takes, no cost.\n```\nA  Deep\n```', ['Deep (my pick)', 'French touch', 'Minimal']))
  expect(ask).toMatchObject({
    id: `telegram:${DESK}:1`,
    kind: 'pick',
    task: `telegram:${DESK}`,
    question: 'Music for the Saves video?',
    context: 'Three new takes, no cost.',
    options: [{ label: 'Deep', value: 'Deep (my pick)', pick: true }, { label: 'French touch', value: 'French touch' }, { label: 'Minimal', value: 'Minimal' }],
  })
})

test('open questions come newest first with a link to each, answered and settled ones drop out', () => {
  ledger([asked(1, 'Ship it?', ['Yes', 'No']), asked(2, 'Rename it?', ['Yes', 'No'], { answer: { label: 'No', at: '', via: 'telegram' } }), asked(3, 'Which color?', ['Mint', 'Coral'])])
  asks = new Asks(state, { t3Database: '/nonexistent', check: why => checks.push(why) })
  expect(asks.view.asks.map(ask => [ask.question, ask.app, ask.topic, ask.places])).toEqual([
    ['Which color?', 'telegram', 'desk', [{ app: 'telegram', place: 'desk', task: `telegram:${DESK}`, link: 'https://t.me/c/1234/5/3' }]],
    ['Ship it?', 'telegram', 'desk', [{ app: 'telegram', place: 'desk', task: `telegram:${DESK}`, link: 'https://t.me/c/1234/5/1' }]],
  ])
})

test('the check’s version of a question stands in for every place that asked it, and newer questions lead', async () => {
  ledger([asked(1, 'Twilio?', ['Upgrade', 'Not yet']), asked(2, 'Upgrade Twilio now?', ['Go', 'Wait']), asked(9, 'Brand new?', ['Yes', 'No'])])
  writeFileSync(
    join(state, 'voice', 'check.json'),
    JSON.stringify({
      at: '2026-10-13T15:00:00.000Z',
      why: 'a pinned post changed',
      read: {},
      fixed: [],
      flagged: [],
      stuck: [],
      asks: [
        {
          id: 'check:twilio',
          kind: 'do',
          task: `telegram:${DESK}`,
          at: '2026-10-11T00:00:00.000Z',
          question: 'Upgrade Twilio from trial',
          options: [{ label: 'Upgrade', value: 'Upgrade', pick: true }, { label: 'Use the app', value: 'Not yet' }],
          tag: 'unblocks 3',
          refs: [{ app: 'telegram', thread: DESK, message: 1 }, { app: 'telegram', thread: DESK, message: 2 }],
        },
        { id: 'check:read', kind: 'look', task: `telegram:${DESK}`, at: '2026-10-13T00:00:00.000Z', question: 'Read the launch review', options: [{ label: 'Open' }] },
      ],
    }),
  )
  asks = new Asks(state, { t3Database: '/nonexistent', check: why => checks.push(why) })
  expect(asks.view.asks.map(ask => ask.id)).toEqual([`telegram:${DESK}:9`, 'check:twilio', 'check:read'])
  expect(asks.view.asks.map(ask => ask.app)).toEqual(['telegram', 'telegram', 'telegram'])
  expect(asks.view.check).toEqual({ at: '2026-10-13T15:00:00.000Z', why: 'a pinned post changed', fixed: 0, flagged: 0 })

  await asks.answer('check:twilio', 'Use the app', 'app')
  await until(() => lines.length === 2)
  expect(lines).toEqual([
    { type: 'answer', thread: DESK, message: 1, label: 'Not yet', via: 'app' },
    { type: 'settle', thread: DESK, message: 2, note: '✓ Answered in the app: Use the app' },
  ])

  await asks.answer('check:read', 'Open', 'app')
  expect(await until(() => lines.find(line => line.type === 'inbound'))).toEqual({ type: 'inbound', thread: DESK, content: '(answered in the app) Read the launch review: Open', meta: { user: 'hex app' } })
  await until(() => !asks.find('check:read'))
  await asks.undo('check:read', 'app')
  await until(() => asks.find('check:read'))
})

test('an answer that lands in the ledger takes the question off the list, and undo asks for its buttons back', async () => {
  ledger([asked(1, 'Ship it?', ['Yes', 'No'])])
  asks = new Asks(state, { t3Database: '/nonexistent', check: why => checks.push(why) })
  const version = asks.version
  await asks.answer(`telegram:${DESK}:1`, 'Yes', 'app')
  expect(await until(() => lines[0])).toEqual({ type: 'answer', thread: DESK, message: 1, label: 'Yes', via: 'app' })
  ledger([asked(1, 'Ship it?', ['Yes', 'No'], { answer: { label: 'Yes', at: '', via: 'app' } })])
  await asks.changes(version, 2000)
  expect(asks.view.asks).toEqual([])
  await asks.undo(`telegram:${DESK}:1`, 'app')
  expect(await until(() => lines[1])).toEqual({ type: 'reopen', thread: DESK, message: 1, via: 'app' })
})

test('a stuck item with a request goes to General, one without is put away', async () => {
  writeFileSync(
    join(state, 'voice', 'check.json'),
    JSON.stringify({
      at: '2026-10-13T15:00:00.000Z', why: 'a call ended', read: {}, asks: [], fixed: [], flagged: [],
      stuck: [
        { id: 'disk', title: 'cloud’s disk fails every read', why: 'Since 1:10am.', action: 'Restore', mark: 'failed', at: '', request: 'Restore cloud from checkpoint v7.' },
        { id: 'runs', title: '5 T3 runs ended in an error', why: 'Their work landed.', action: 'Settle', mark: 'failed', at: '' },
      ],
    }),
  )
  asks = new Asks(state, { t3Database: '/nonexistent', check: why => checks.push(why) })
  await asks.act('disk')
  expect(await until(() => lines[0])).toEqual({ type: 'inbound', thread: GROUP, content: 'Restore cloud from checkpoint v7.', meta: { user: 'hex app' } })
  await asks.act('runs')
  await until(() => asks.view.stuck.length === 1)
  expect(asks.view.stuck[0]).toMatchObject({ id: 'disk', app: 'hex', sent: expect.any(String) })
  expect(JSON.parse(readFileSync(join(state, 'voice', 'marks.json'), 'utf8')).dismissed.runs).toBeString()
})

test('T3 Code’s records give what waits on a limit, what never started, what failed unseen, and what finished since you looked', () => {
  const path = join(state, 't3.sqlite')
  const db = new Database(path)
  db.run(`create table orchestration_v2_projection_threads (thread_id text, project_id text, title text, archived_at text, deleted_at text, payload_json text)`)
  db.run(`create table projection_projects (project_id text, title text)`)
  db.run(`create table orchestration_v2_projection_runs (thread_id text, ordinal int, status text, requested_at text, completed_at text)`)
  db.run(`create table orchestration_v2_projection_messages (thread_id text, role text, created_at text, payload_json text)`)
  db.run(`insert into projection_projects values ('p', 'hex')`)
  const thread = (id: string, payload: object) => db.run(`insert into orchestration_v2_projection_threads values (?, 'p', ?, null, null, ?)`, [id, `${id} thread`, JSON.stringify(payload)])
  thread('parked', { limitRecovery: { resetAt: '2026-10-18T19:00:00.000Z' } })
  thread('queued', {})
  thread('broken', { lastVisitedAt: '2026-10-13T08:00:00.000Z' })
  thread('finished', { createdBy: 'user', lastVisitedAt: '2026-10-13T08:00:00.000Z' })
  thread('seen', { createdBy: 'user', lastVisitedAt: '2026-10-13T12:00:00.000Z' })
  const run = (id: string, ordinal: number, status: string, completed: string | null) => db.run(`insert into orchestration_v2_projection_runs values (?, ?, ?, '2026-10-09T23:00:00.000Z', ?)`, [id, ordinal, status, completed])
  run('parked', 1, 'failed', '2026-10-13T10:00:00.000Z')
  run('queued', 1, 'queued', null)
  run('broken', 1, 'failed', '2026-10-13T10:00:00.000Z')
  run('finished', 1, 'completed', '2026-10-13T10:00:00.000Z')
  run('seen', 1, 'completed', '2026-10-13T10:00:00.000Z')
  db.run(`insert into orchestration_v2_projection_messages values ('finished', 'assistant', '2026-10-13T10:00:00.000Z', ?)`, [JSON.stringify({ text: '## Done\n\n**Shipped** the memory fix.' })])
  db.close()

  const t3 = new T3(() => {}, path)
  const { stuck, fresh } = t3.query(Date.parse('2026-10-13T20:00:00.000Z'))
  t3.close()
  expect(stuck.map(item => [item.title, item.action, item.mark])).toEqual([
    ['1 T3 thread waits for Oct 18', 'Switch plan', 'paused'],
    ['queued thread: queued since Oct 9', 'Resume', 'paused'],
    ['broken thread ended in an error', 'Look', 'failed'],
  ])
  expect(stuck.every(item => item.request)).toBe(true)
  expect(fresh).toEqual([{ id: expect.stringMatching(/^t3-done-/), app: 't3', topic: 'hex', title: 'finished thread', where: 'T3 · hex', line: 'Done', at: '2026-10-13T10:00:00.000Z' }])
  expect(stuck.every(item => item.app === 't3')).toBe(true)
})

test('a check’s verdict is held to the ledger: real open refs and buttons only, and nothing both settled and listed', () => {
  const asks = { telegram: [asked(1, 'Twilio?', ['Upgrade', 'Not yet']), asked(2, 'Old?', ['Yes', 'No'], { settled: { note: 'x', at: '' } }), asked(3, 'Music?', ['A', 'B'])] }
  const ref = (message: number) => ({ app: 'telegram', thread: DESK, message })
  const verdict = vet(
    {
      asks: [
        {
          id: 'twilio',
          kind: 'do',
          task: `telegram:${DESK}`,
          at: '',
          question: 'Upgrade Twilio',
          options: [{ label: 'Upgrade', value: 'Upgrade' }, { label: 'Later', value: 'Wait' }],
          from: [ref(1), ref(2), ref(9), { app: 'telegram', thread: GROUP }, { app: 'telegram', thread: '-100999' }, { app: 'voice', call: 'live_1' }, { app: 'voice', call: 'live_made_up' }],
        },
      ],
      settle: [{ ...ref(1), note: 'Settled' }, { ...ref(2), note: 'Settled' }, { ...ref(3), note: 'Settled: Tech Live, picked on a call with a very long note' }],
      fixed: [],
      flagged: [],
      stuck: [{ id: 'disk', title: 'disk', why: '', action: 'Look', mark: 'failed', at: '' }],
    },
    asks,
    { threads: { [`telegram:${GROUP}`]: 'hex', [`telegram:${DESK}`]: 'desk' }, calls: [{ id: 'live_1' }] },
  )
  expect(verdict.asks[0]).toMatchObject({
    id: 'check:twilio',
    refs: [ref(1)],
    from: [ref(1), ref(2), ref(9), { app: 'telegram', thread: GROUP }, { app: 'voice', call: 'live_1' }],
    options: [{ label: 'Upgrade', value: 'Upgrade' }, { label: 'Later' }],
  })
  expect(verdict.settle).toEqual([{ ...ref(3), note: 'Settled: Tech Live, picked on a call with a very long note'.slice(0, 60) }])
  expect(verdict.stuck[0]!.id).toBe('check-disk')
})

test('an ask names every place it was asked, newest first, each with the best link its app has, and its pages apart from its answers', () => {
  const DM = '777'
  const THREAD = '1560277464146644992'
  writeFileSync(join(state, 'telegram', 'threads.json'), JSON.stringify({ [GROUP]: { name: 'hex' }, [DESK]: { name: 'desk' }, [DM]: { name: 'DM' } }))
  writeFileSync(join(state, 'telegram', 'bot.json'), JSON.stringify({ username: 'hexbot' }))
  mkdirSync(join(state, 'discord'))
  writeFileSync(join(state, 'discord', 'guild.json'), JSON.stringify({ id: '42' }))
  writeFileSync(join(state, 'discord', 'threads.json'), JSON.stringify({ [THREAD]: { name: 'fix hex NOW' } }))
  const calls = join(state, 'calls')
  mkdirSync(calls)
  writeFileSync(join(calls, 'live_1.json'), JSON.stringify({ id: 'live_1', title: 'Apple charges', started: '2026-10-13T18:00:00.000Z' }))
  ledger([asked(1, 'Order the Duo?', ['Ordered', 'Not yet'])], { [GROUP]: { message: 2693, text: 'Blocked on you: the Duo order', at: '2026-10-13T19:00:00.000Z' } })
  writeFileSync(
    join(state, 'voice', 'check.json'),
    JSON.stringify({
      at: '2026-10-13T20:00:00.000Z', why: 'a call ended', read: {}, fixed: [], flagged: [], stuck: [],
      asks: [
        {
          id: 'check:duo',
          kind: 'yesno',
          task: `telegram:${DESK}`,
          at: '2026-10-13T11:00:00.000Z',
          question: 'Is the Duo ordered?',
          options: [{ label: 'Ordered', value: 'Ordered' }, { label: 'Not yet', value: 'Not yet' }],
          links: [{ label: 'Apple Store', url: 'https://apple.com/store' }],
          from: [
            { app: 'telegram', thread: DESK, message: 1 },
            { app: 'telegram', thread: GROUP, message: 2693 },
            { app: 'voice', call: 'live_1' },
            { app: 'telegram', thread: DM, message: 585 },
            { app: 'discord', thread: THREAD },
            { app: 'telegram', thread: DESK },
          ],
          refs: [{ app: 'telegram', thread: DESK, message: 1 }],
        },
      ],
    }),
  )
  asks = new Asks(state, { t3Database: '/nonexistent', t3Home: '/nonexistent', calls, check: why => checks.push(why) })
  const [duo] = asks.view.asks
  expect(duo).toMatchObject({ options: [{ label: 'Ordered', value: 'Ordered' }, { label: 'Not yet', value: 'Not yet' }], links: [{ label: 'Apple Store', url: 'https://apple.com/store' }] })
  expect(duo!.places).toEqual([
    { app: 'telegram', place: 'General', task: `telegram:${GROUP}`, link: 'https://t.me/c/1234/2693' },
    { app: 'voice', place: 'Apple charges', call: 'live_1' },
    { app: 'telegram', place: 'desk', task: `telegram:${DESK}`, link: 'https://t.me/c/1234/5/1' },
    { app: 'telegram', place: 'DM', task: `telegram:${DM}`, link: 'https://t.me/hexbot' },
    { app: 'discord', place: 'fix hex NOW', task: `discord:${THREAD}`, link: `https://discord.com/channels/42/${THREAD}` },
  ])
})

test('a check written before places and links were typed still gives each ask its places, and its url options as links', () => {
  ledger([asked(1, 'Read the review?', ['Done', 'Later'])])
  writeFileSync(
    join(state, 'voice', 'check.json'),
    JSON.stringify({
      at: '2026-10-13T20:00:00.000Z', why: 'a call ended', read: {}, fixed: [], flagged: [], stuck: [],
      asks: [
        { id: 'check:review', kind: 'do', task: `telegram:${DESK}`, at: '', question: 'Read the review', options: [{ label: 'Done', value: 'Done' }, { label: 'Open PR #2', url: 'https://github.com/x/pull/2' }], places: ['desk', 'hex'], refs: [{ app: 'telegram', thread: DESK, message: 1 }] },
        { id: 'check:pin', kind: 'do', task: `telegram:${GROUP}`, at: '', question: 'File the claim', options: [{ label: 'Done' }], places: ['hex'] },
      ],
    }),
  )
  asks = new Asks(state, { t3Database: '/nonexistent', t3Home: '/nonexistent', check: why => checks.push(why) })
  expect(asks.view.asks.map(ask => [ask.id, ask.options, ask.links, ask.places])).toEqual([
    ['check:review', [{ label: 'Done', value: 'Done' }], [{ label: 'Open PR #2', url: 'https://github.com/x/pull/2' }], [{ app: 'telegram', place: 'desk', task: `telegram:${DESK}`, link: 'https://t.me/c/1234/5/1' }]],
    ['check:pin', [{ label: 'Done' }], undefined, [{ app: 'telegram', place: 'General', task: `telegram:${GROUP}`, link: 'https://t.me/c/1234/1' }]],
  ])
})
