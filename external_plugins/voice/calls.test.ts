import { expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { CallLog, type CallRecord } from './calls.ts'

function scratch() {
  const dir = mkdtempSync(join(tmpdir(), 'calls-'))
  return { calls: new CallLog(dir), [Symbol.dispose]: () => rmSync(dir, { recursive: true }) }
}

const record = (id: string, started: string, extra: Partial<CallRecord> = {}): CallRecord => ({
  id,
  started,
  from: 'app',
  turns: [
    { who: 'voice', at: 900, text: 'Hey.' },
    { who: 'you', at: 3400, text: 'Is the build green?' },
  ],
  tasks: [],
  ...extra,
})

test('the list is newest first, without the turns, with how long and how it began', () => {
  using log = scratch()
  const { calls } = log
  calls.save(record('a', '2026-10-13T01:00:00.000Z', { ended: '2026-10-13T01:04:30.000Z' }))
  calls.save(record('b', '2026-10-13T03:00:00.000Z'))
  expect(calls.list()).toEqual([
    { id: 'b', started: '2026-10-13T03:00:00.000Z', from: 'app', seconds: 3, preview: 'Is the build green?' },
    { id: 'a', started: '2026-10-13T01:00:00.000Z', ended: '2026-10-13T01:04:30.000Z', from: 'app', seconds: 270, preview: 'Is the build green?' },
  ])
  expect(calls.get('a')?.turns).toHaveLength(2)
})

test('ids that are not plain names never reach the disk', () => {
  using log = scratch()
  expect(log.calls.get('../.env')).toBeUndefined()
  expect(log.calls.delete('../.env')).toBe(false)
})

test('a waiting list request answers as soon as a call changes', async () => {
  using log = scratch()
  const { calls } = log
  const seen = calls.version
  const changed = calls.changes(seen, 5000)
  calls.save(record('a', '2026-10-13T01:00:00.000Z'))
  await changed
  expect(calls.version).toBeGreaterThan(seen)
  expect(calls.delete('a')).toBe(true)
  expect(calls.list()).toEqual([])
})

test('a list request from before a restart answers right away', async () => {
  using log = scratch()
  const started = Date.now()
  await log.calls.changes(log.calls.version - 1, 5000)
  expect(Date.now() - started).toBeLessThan(100)
})
