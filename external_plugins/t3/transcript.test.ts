import { afterEach, beforeEach, expect, test } from 'bun:test'
import { appendFileSync, mkdtempSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import type { SessionNotification } from '@agentclientprotocol/sdk'
import { follow } from './transcript.ts'

let dir: string
let path: string
let updates: SessionNotification['update'][]
let ended: number
let reader: ReturnType<typeof follow> | undefined
let stopped: boolean

const prompt = { type: 'user', origin: { kind: 'channel' }, isMeta: true, message: { content: '<channel source="t3">hi</channel>' } }
const text = (id: string, words: string) => ({ type: 'assistant', message: { id, content: [{ type: 'text', text: words }] } })
const bash = { type: 'assistant', message: { id: 'm2', content: [{ type: 'tool_use', id: 'tool1', name: 'Bash', input: { command: 'pwd' } }] } }
const result = { type: 'user', uuid: 'u1', message: { content: [{ type: 'tool_result', tool_use_id: 'tool1', content: '/work' }] } }
const done = { type: 'system', subtype: 'turn_duration' }

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 't3-transcript-'))
  path = join(dir, 'session.jsonl')
  updates = []
  ended = 0
  stopped = true
})

afterEach(() => reader?.close())

function write(...entries: object[]) {
  appendFileSync(path, entries.map(entry => JSON.stringify(entry) + '\n').join(''))
}

function start(fresh: boolean) {
  reader = follow({ path, sessionId: 'thread', cwd: '/work', fresh, done: () => stopped, emit: n => void updates.push(n.update), end: () => void ended++ })
}

async function until(check: () => unknown, timeout = 3000) {
  for (const end = Date.now() + timeout; Date.now() < end; await Bun.sleep(20)) if (check()) return
  throw new Error('timed out')
}

test('a turn streams from where the transcript ends, without the channel prompt, and ends at its turn_duration', async () => {
  write(prompt, text('m0', 'an earlier turn'), done)
  start(false)
  write(prompt, bash, result, text('m3', 'you are in /work'), done, text('m4', 'a later turn'))
  await until(() => ended)
  expect(updates.map(update => update.sessionUpdate)).toEqual(['tool_call', 'tool_call_update', 'agent_message_chunk'])
  expect(updates.at(-1)).toMatchObject({ content: { type: 'text', text: 'you are in /work' } })
  expect(ended).toBe(1)
})

test('a new session streams from its start, once its transcript appears', async () => {
  start(true)
  write(prompt, text('m1', 'hello'))
  await until(() => updates.length)
  expect(ended).toBe(0)
  write(done)
  await until(() => ended)
  expect(updates).toEqual([expect.objectContaining({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'hello' } })])
})

test('a turn_duration before the prompt is an earlier turn ending, not this one', async () => {
  start(true)
  write(done, prompt, text('m1', 'still going'))
  await until(() => updates.length)
  expect(ended).toBe(0)
})

test('a line written in two pieces is read once it is whole', async () => {
  start(true)
  const line = JSON.stringify(text('m1', 'whole')) + '\n'
  writeFileSync(path, JSON.stringify(prompt) + '\n' + line.slice(0, 20))
  await Bun.sleep(100)
  expect(updates).toEqual([])
  appendFileSync(path, line.slice(20))
  await until(() => updates.length)
  expect(updates[0]).toMatchObject({ content: { text: 'whole' } })
})

test('a turn whose session is still working past its turn_duration ends once the session stops with no turn after it', async () => {
  stopped = false
  start(true)
  write(prompt, text('m1', 'started a background agent'), done)
  await until(() => updates.length)
  write({ type: 'user', origin: { kind: 'task-notification' }, message: { content: '<task-notification>ok</task-notification>' } })
  await Bun.sleep(100)
  stopped = true
  reader!.settle()
  await Bun.sleep(100)
  expect(ended).toBe(0)
  write(text('m2', 'the agent says ok'), done)
  await until(() => ended)
  expect(updates.at(-1)).toMatchObject({ content: { text: 'the agent says ok' } })
})
