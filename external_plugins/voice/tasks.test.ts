import { afterAll, expect, test } from 'bun:test'
import { appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { Tasks, opener } from './tasks.ts'

const home = mkdtempSync(join(tmpdir(), 'voice-tasks-'))
const claude = join(home, 'claude')
const state = join(home, 'hex', 'state')
const hex = join(home, 'hex')
const project = join(claude, 'projects', hex.replace(/[^a-zA-Z0-9]/g, '-'))
afterAll(() => rmSync(home, { recursive: true }))

const ago = (minutes: number) => new Date(Date.now() - minutes * 60_000).toISOString()

function threads(app: string, all: object) {
  mkdirSync(join(state, app), { recursive: true })
  writeFileSync(join(state, app, 'threads.json'), JSON.stringify(all))
}

function job(session: string, record: object, timeline: object[] = []) {
  const dir = join(claude, 'jobs', session.slice(0, 8))
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'timeline.jsonl'), timeline.map(entry => JSON.stringify(entry) + '\n').join(''))
  writeFileSync(join(dir, 'state.json'), JSON.stringify(record))
}

function running(session: string, status: 'busy' | 'idle', pid = process.pid) {
  mkdirSync(join(claude, 'sessions'), { recursive: true })
  writeFileSync(join(claude, 'sessions', `${session.slice(0, 8)}.json`), JSON.stringify({ pid, sessionId: session, status }))
}

function step(path: string, name: string, input: object) {
  mkdirSync(join(path, '..'), { recursive: true })
  appendFileSync(path, JSON.stringify({ type: 'assistant', message: { id: `msg_${Math.random()}`, content: [{ type: 'tool_use', id: `toolu_${Math.random()}`, name, input }] } }) + '\n')
}

async function until(check: () => boolean) {
  for (let i = 0; i < 100 && !check(); i++) await Bun.sleep(20)
  expect(check()).toBe(true)
}

mkdirSync(join(claude, 'jobs'), { recursive: true })
mkdirSync(join(claude, 'sessions'), { recursive: true })
threads('telegram', {
  '-1004422245734': { name: 'hex', session: 'aaaaaaaa-general' },
  '-1004422245734:908': { name: 'autofork', session: 'bbbbbbbb-autofork' },
  '-1004422245734:2583': { name: 'voiceapp', session: 'cccccccc-voiceapp' },
  '-1004422245734:65': { name: 'Theo clips', session: 'dddddddd-theo' },
  '-1004422245734:72': { name: 'Leisure time', session: 'eeeeeeee-leisure' },
})
threads('buzz', { b1: { name: 'Old news', session: 'ffffffff-old' } })
job('aaaaaaaa-general', { state: 'done', detail: 'heartbeat ran', updatedAt: ago(5) })
const asked = ago(40)
job('bbbbbbbb-autofork', { state: 'blocked', detail: 'needs music', needs: 'Pick a music style, and run `claude setup-token`', updatedAt: ago(20) }, [
  { at: ago(90), state: 'working', detail: 'Publishing', text: '' },
  { at: ago(60), state: 'done', detail: '**Published** autofork 0.1.2', text: 'npm is live' },
  { at: asked, state: 'blocked', detail: 'needs music', text: 'Your call' },
  { at: ago(20), state: 'blocked', detail: 'still needs music', text: 'Still yours' },
])
job('cccccccc-voiceapp', { state: 'working', detail: 'building', updatedAt: ago(1), fan: [{ id: 'old', kind: 'agent', label: 'Earlier', doneAt: 1 }, { id: 'agent2', kind: 'agent', label: 'Check the server', doneAt: Date.now() - 60_000 }, { id: 'agent1', kind: 'agent', label: 'Build the Tasks view' }, { id: 'sh', kind: 'shell', label: 'sleep' }] }, [
  { at: ago(14), state: 'working', detail: '', text: '' },
])
job('dddddddd-theo', { state: 'stopped', detail: 'stopped', updatedAt: ago(30) }, [{ at: ago(100), state: 'done', detail: 'clips posted', text: 'done' }])
job('eeeeeeee-leisure', { state: 'working', detail: 'was working', updatedAt: ago(29) })
job('ffffffff-old', { state: 'done', detail: 'long ago', updatedAt: ago(8 * 24 * 60) })
running('aaaaaaaa-general', 'idle')
running('cccccccc-voiceapp', 'busy')
running('eeeeeeee-leisure', 'busy', 2 ** 22 + 12345)

const tasks = new Tasks(state, hex, claude)
afterAll(() => tasks.close())

test("each thread is a task from its session's own records, what needs you first, then what's working, then what finished", () => {
  expect(tasks.tasks.map(task => [task.name, task.state])).toEqual([
    ['autofork', 'needs'],
    ['voiceapp', 'working'],
    ['hex', 'done'],
    ['Leisure time', 'idle'],
    ['Theo clips', 'idle'],
  ])
  const autofork = tasks.get('telegram:-1004422245734:908')!
  expect(autofork).toMatchObject({
    where: 'Telegram',
    line: 'Pick a music style, and run claude setup-token',
    needs: 'Pick a music style, and run claude setup-token',
    since: asked,
    link: 'https://t.me/c/4422245734/908',
  })
  expect(autofork.lately.map(moment => [moment.state, moment.text])).toEqual([
    ['needs', 'still needs music'],
    ['needs', 'needs music'],
    ['done', 'Published autofork 0.1.2'],
  ])
  expect(tasks.get('telegram:-1004422245734')).toMatchObject({ where: 'General', link: 'https://t.me/c/4422245734/1' })
  expect(tasks.get('telegram:-1004422245734:65')).toMatchObject({ line: 'clips posted', lately: [] })
  expect(tasks.get('buzz:b1')).toBeUndefined()
  expect(tasks.summary).toEqual({ needs: 1, working: 1 })
  expect(tasks.rows()[0]).not.toContainKeys(['needs', 'lately', 'steps'])
})

test("a working thread's line is its newest step, and each of its agents from this stretch of work shows its own, running ones first", async () => {
  const voiceapp = () => tasks.get('telegram:-1004422245734:2583')!
  expect(voiceapp().agents).toEqual([
    { id: 'agent1', label: 'Build the Tasks view', state: 'working', steps: [] },
    { id: 'agent2', label: 'Check the server', state: 'done', steps: [] },
  ])
  step(join(project, 'cccccccc-voiceapp.jsonl'), 'Read', { file_path: '/repo/src/tasks.ts' })
  step(join(project, 'cccccccc-voiceapp.jsonl'), 'Edit', { file_path: '/repo/src/tasks.ts', old_string: 'a', new_string: 'b' })
  await until(() => voiceapp().line === 'Editing tasks.ts')
  expect(voiceapp().steps.map(step => step.text)).toEqual(['Editing tasks.ts', 'Reading tasks.ts'])
  step(join(project, 'cccccccc-voiceapp', 'subagents', 'agent-agent1.jsonl'), 'Read', { file_path: '/repo/README.md' })
  await until(() => voiceapp().agents[0].line === 'Reading README.md')
  const row = tasks.rows().find(row => row.name === 'voiceapp')!
  expect(row).not.toContainKey('steps')
  expect(row.agents[0]).toEqual({ id: 'agent1', label: 'Build the Tasks view', state: 'working', line: 'Reading README.md' })
})

test('a change to a session wakes the list, and the counts move only when a count does', async () => {
  const { version } = tasks
  const counted = tasks.counts.version
  const woke = tasks.changes(version, 2000)
  job('aaaaaaaa-general', { state: 'done', detail: 'heartbeat ran again', updatedAt: ago(0) })
  await woke
  await until(() => tasks.get('telegram:-1004422245734')?.line === 'heartbeat ran again')
  expect(tasks.counts.version).toBe(counted)
  job('aaaaaaaa-general', { state: 'blocked', detail: 'Your call: ship it?', updatedAt: ago(0) })
  await until(() => tasks.summary.needs === 2)
  expect(tasks.counts.version).toBeGreaterThan(counted)
  expect(tasks.tasks[0].name).toBe('hex')
})

test('a new thread shows up when its app writes threads.json, once its session has records', async () => {
  threads('discord', { d1: { name: 'Latest Claude', session: '99999999-latest' } })
  job('99999999-latest', { state: 'failed', detail: "You've hit your weekly limit", updatedAt: ago(0) })
  await until(() => tasks.get('discord:d1')?.state === 'failed')
  expect(tasks.get('discord:d1')).toMatchObject({ where: 'Discord', line: "You've hit your weekly limit" })
  expect(tasks.get('discord:d1')!.link).toBeUndefined()
})

test('talking a task through tells the voice which thread it is and where it stands', () => {
  expect(opener(tasks.get('telegram:-1004422245734:908')!)).toBe(
    "The task is the hex thread autofork (Telegram, thread id -1004422245734:908). It's waiting on the caller: Pick a music style, and run claude setup-token",
  )
})
