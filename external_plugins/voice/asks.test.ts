import { afterEach, beforeEach, expect, test } from 'bun:test'
import { Database } from 'bun:sqlite'
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'fs'
import { createServer, type Server } from 'net'
import { tmpdir } from 'os'
import { join } from 'path'
import { Asks, fromLedger } from './asks.ts'
import { T3 } from './t3.ts'

const GROUP = '-1001234'
const DESK = `${GROUP}:5`
let state: string
let asks: Asks
let hub: Server
let lines: any[]

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
  hub = createServer(socket => {
    socket.setEncoding('utf8')
    socket.on('data', (chunk: string) => lines.push(...chunk.trim().split('\n').map(line => JSON.parse(line))))
  })
  await new Promise<void>(resolve => hub.listen(join(state, 'telegram', 'hub.sock'), resolve))
})

afterEach(() => {
  asks?.close()
  hub.close()
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
  asks = new Asks(state, '/nonexistent')
  expect(asks.view.asks.map(ask => [ask.question, ask.topic, ask.link])).toEqual([
    ['Which color?', 'desk', 'https://t.me/c/1234/5/3'],
    ['Ship it?', 'desk', 'https://t.me/c/1234/5/1'],
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
  asks = new Asks(state, '/nonexistent')
  expect(asks.view.asks.map(ask => ask.id)).toEqual([`telegram:${DESK}:9`, 'check:twilio', 'check:read'])
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
  asks = new Asks(state, '/nonexistent')
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
  asks = new Asks(state, '/nonexistent')
  await asks.act('disk')
  expect(await until(() => lines[0])).toEqual({ type: 'inbound', thread: GROUP, content: 'Restore cloud from checkpoint v7.', meta: { user: 'hex app' } })
  await asks.act('runs')
  await until(() => asks.view.stuck.length === 1)
  expect(asks.view.stuck[0]).toMatchObject({ id: 'disk', sent: expect.any(String) })
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
  expect(fresh).toEqual([{ id: expect.stringMatching(/^t3-done-/), title: 'finished thread', where: 'T3 · hex', line: 'Done', at: '2026-10-13T10:00:00.000Z' }])
})
