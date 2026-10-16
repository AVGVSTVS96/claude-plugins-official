import { Database } from 'bun:sqlite'
import { afterAll, expect, test } from 'bun:test'
import { appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { Links } from './links.ts'
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

function running(session: string, status: 'busy' | 'idle' | 'shell', pid = process.pid, more: object = {}) {
  mkdirSync(join(claude, 'sessions'), { recursive: true })
  writeFileSync(join(claude, 'sessions', `${session.slice(0, 8)}.json`), JSON.stringify({ pid, sessionId: session, status, ...more }))
}

function step(path: string, name: string, input: object) {
  said(path, { type: 'tool_use', id: `toolu_${Math.random()}`, name, input })
}

function said(path: string, content: object) {
  mkdirSync(join(path, '..'), { recursive: true })
  appendFileSync(path, JSON.stringify({ type: 'assistant', message: { id: `msg_${Math.random()}`, content: [content] } }) + '\n')
}

async function until(check: () => boolean) {
  for (let i = 0; i < 100 && !check(); i++) await Bun.sleep(20)
  expect(check()).toBe(true)
}

mkdirSync(join(claude, 'jobs'), { recursive: true })
mkdirSync(join(claude, 'sessions'), { recursive: true })
const telegram = {
  '-1004422245734': { name: 'hex', session: 'aaaaaaaa-general' },
  '-1004422245734:908': { name: 'autofork', session: 'bbbbbbbb-autofork' },
  '-1004422245734:2583': { name: 'voiceapp', session: 'cccccccc-voiceapp' },
  '-1004422245734:65': { name: 'Theo clips', session: 'dddddddd-theo' },
  '-1004422245734:72': { name: 'Leisure time', session: 'eeeeeeee-leisure' },
}
threads('telegram', telegram)
threads('buzz', { b1: { name: 'Old news', session: 'ffffffff-old' } })
job('aaaaaaaa-general', { state: 'done', detail: 'heartbeat ran', updatedAt: ago(5) })
const [published, finished, asked] = [ago(90), ago(60), ago(40)]
job('bbbbbbbb-autofork', { state: 'blocked', detail: 'needs music', needs: 'Pick a music style, and run `claude setup-token`', updatedAt: ago(20) }, [
  { at: ago(13 * 60), state: 'done', detail: 'Overnight', text: '' },
  { at: ago(12.5 * 60), state: 'blocked', detail: 'Asked overnight', text: '' },
  { at: published, state: 'working', detail: 'Publishing', text: '' },
  { at: finished, state: 'done', detail: '**Published** autofork 0.1.2', text: 'npm is live' },
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

const t3 = join(home, 't3')
mkdirSync(t3)
writeFileSync(join(t3, 'environment-id'), 'env-1\n')
const t3db = new Database(join(t3, 'statev2.sqlite'))
t3db.run('create table orchestration_v2_projection_threads (thread_id text primary key, title text, deleted_at text)')
t3db.run('create table orchestration_v2_projection_provider_threads (provider_thread_id text primary key, driver text, updated_at text, payload_json text)')
afterAll(() => t3db.close())

function mapped(key: string, thread: string, { driver = 'acpRegistry', deleted = null as string | null, title = 'T3 thread' } = {}) {
  t3db.run('insert or replace into orchestration_v2_projection_threads values (?, ?, ?)', [thread, title, deleted])
  t3db.run('insert or replace into orchestration_v2_projection_provider_threads values (?, ?, ?, ?)', [
    `${driver}:${key}`,
    driver,
    new Date().toISOString(),
    JSON.stringify({ appThreadId: thread, nativeThreadRef: { driver, nativeId: key } }),
  ])
}

const tasks = new Tasks(state, hex, claude, t3)
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
    place: 'autofork',
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
  const window = autofork.track[0]!.at
  expect(Date.now() - Date.parse(window)).toBeGreaterThanOrEqual(12 * 60 * 60_000)
  expect(autofork.track).toEqual([
    { at: window, state: 'needs' },
    { at: published, state: 'working' },
    { at: finished, state: 'done' },
    { at: asked, state: 'needs' },
  ])
  expect(tasks.get('telegram:-1004422245734')).toMatchObject({ where: 'General', place: 'General', link: 'https://t.me/c/4422245734/1' })
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
  expect(voiceapp().steps.map(step => [step.kind, step.text])).toEqual([
    ['edit', 'Editing tasks.ts'],
    ['read', 'Reading tasks.ts'],
  ])
  step(join(project, 'cccccccc-voiceapp', 'subagents', 'agent-agent1.jsonl'), 'Read', { file_path: '/repo/README.md' })
  await until(() => voiceapp().agents[0].line === 'Reading README.md')
  const row = tasks.rows().find(row => row.name === 'voiceapp')!
  expect(row).not.toContainKey('steps')
  expect(row.agents[0]).toEqual({ id: 'agent1', label: 'Build the Tasks view', state: 'working', line: 'Reading README.md' })
})

test("a working thread's page has its thoughts in their own words and its plan as Claude Code's todo list stands", async () => {
  const voiceapp = () => tasks.get('telegram:-1004422245734:2583')!
  const transcript = join(project, 'cccccccc-voiceapp.jsonl')
  said(transcript, { type: 'thinking', thinking: 'The **list** needs a lane.\n\nThen the rows.', signature: 'x' })
  step(transcript, 'TodoWrite', {
    todos: [
      { content: 'Read the inbox', status: 'completed', activeForm: 'Reading the inbox' },
      { content: 'Draw the lanes', status: 'in_progress', activeForm: 'Drawing the lanes' },
      { content: 'Ship it', status: 'pending', activeForm: 'Shipping it' },
    ],
  })
  await until(() => voiceapp().plan.length === 3)
  expect(voiceapp().plan).toEqual([
    { text: 'Read the inbox', state: 'done' },
    { text: 'Drawing the lanes', state: 'running' },
    { text: 'Ship it', state: 'pending' },
  ])
  expect(voiceapp().steps.slice(0, 2).map(step => [step.kind, step.text])).toEqual([
    ['plan', 'Drawing the lanes'],
    ['think', 'The list needs a lane. Then the rows.'],
  ])
  expect(tasks.rows().find(row => row.name === 'voiceapp')).not.toContainKey('plan')
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

test('a new thread shows up when its app writes threads.json, once its session has records, and links once Discord has said which server it is in', async () => {
  threads('discord', { d1: { name: 'Latest Claude', session: '99999999-latest' } })
  job('99999999-latest', { state: 'failed', detail: "You've hit your weekly limit", updatedAt: ago(0) })
  await until(() => tasks.get('discord:d1')?.state === 'failed')
  expect(tasks.get('discord:d1')).toMatchObject({ where: 'Discord', line: "You've hit your weekly limit" })
  expect(tasks.get('discord:d1')!.link).toBeUndefined()
  writeFileSync(join(state, 'discord', 'guild.json'), JSON.stringify({ id: '3000' }))
  await until(() => tasks.get('discord:d1')?.link === 'https://discord.com/channels/3000/d1')
})

test("a Buzz thread links to its message in the channel the bot recorded, a DM to its channel, and a thread with no channel to nothing", async () => {
  const [anchors, lost, dm, channel] = ['a'.repeat(64), 'b'.repeat(64), '5c0f9a6e-3b1d-4e7a-9c2f-7d8e1a4b6c30', '0d6f2c1e-5a4b-4c3d-8e9f-123456789abc']
  threads('buzz', {
    [anchors]: { name: 'Anchors', session: 'b0000001-anchors' },
    [lost]: { name: 'Lost', session: 'b0000002-lost' },
    [dm]: { name: 'bassim', session: 'b0000003-dm' },
  })
  for (const session of ['b0000001-anchors', 'b0000002-lost', 'b0000003-dm']) job(session, { state: 'done', detail: 'ok', updatedAt: ago(1) })
  await until(() => [anchors, lost, dm].every(thread => tasks.get(`buzz:${thread}`)))
  expect(tasks.get(`buzz:${anchors}`)!.link).toBeUndefined()
  writeFileSync(join(state, 'buzz', 'channels.json'), JSON.stringify({ [anchors]: channel }))
  await until(() => tasks.get(`buzz:${anchors}`)?.link === `buzz://message?channel=${channel}&id=${anchors}`)
  expect(tasks.get(`buzz:${dm}`)!.link).toBe(`buzz://channel/${dm}`)
  expect(tasks.get(`buzz:${lost}`)!.link).toBeUndefined()
})

test("a Telegram DM links to the bot once the bot has said its name", async () => {
  threads('telegram', { ...telegram, '2000100': { name: 'DM', session: '20001000-dm' } })
  job('20001000-dm', { state: 'done', detail: 'ok', updatedAt: ago(1) })
  await until(() => !!tasks.get('telegram:2000100'))
  expect(tasks.get('telegram:2000100')).toMatchObject({ where: 'DM' })
  expect(tasks.get('telegram:2000100')!.link).toBeUndefined()
  writeFileSync(join(state, 'telegram', 'bot.json'), JSON.stringify({ username: 'hex_bot' }))
  await until(() => tasks.get('telegram:2000100')?.link === 'https://t.me/hex_bot')
})

test("a T3 Code thread links to T3's own thread for it, once T3 has one, and the app's environment; deleted threads and other drivers give no link", async () => {
  threads('t3', {
    mapped: { name: 'Voice app', session: 'd3000001-mapped' },
    later: { name: 'Later', session: 'd3000002-later' },
    gone: { name: 'Gone', session: 'd3000003-gone' },
    other: { name: 'Other', session: 'd3000004-other' },
    unmapped: { name: 'Unmapped', session: 'd3000005-unmapped' },
  })
  for (const session of ['d3000001-mapped', 'd3000002-later', 'd3000003-gone', 'd3000004-other', 'd3000005-unmapped']) job(session, { state: 'done', detail: 'ok', updatedAt: ago(1) })
  mapped('mapped', '4a1e7c52-9b3d-4f60-8a2e-5d6c7b8e9f01', { title: 'Voice app restyle' })
  mapped('gone', 'thread-gone', { deleted: ago(5) })
  mapped('other', 'thread-other', { driver: 'claudeAgent' })
  await until(() => !!tasks.get('t3:mapped')?.link)
  expect(tasks.get('t3:mapped')).toMatchObject({ link: 't3code://threads/env-1/4a1e7c52-9b3d-4f60-8a2e-5d6c7b8e9f01', place: 'Voice app restyle', name: 'Voice app' })
  expect(tasks.get('t3:unmapped')!.place).toBe('Unmapped')
  for (const key of ['later', 'gone', 'other', 'unmapped']) expect(tasks.get(`t3:${key}`)!.link).toBeUndefined()
  mapped('later', 'thread:delegated task')
  await until(() => !!tasks.get('t3:later')?.link)
  expect(tasks.get('t3:later')!.link).toBe('t3code://threads/env-1/thread%3Adelegated%20task')
})

test('the T3 Code app scheme is a setting, and without T3 Code there are no T3 links', () => {
  process.env.T3_APP_SCHEME = 't3code-preview'
  const links = new Links(state, () => {}, t3)
  delete process.env.T3_APP_SCHEME
  links.load()
  expect(links.of('t3', 'mapped')).toBe('t3code-preview://threads/env-1/4a1e7c52-9b3d-4f60-8a2e-5d6c7b8e9f01')
  links.close()
  const without = new Links(state, () => {}, join(home, 'no-t3'))
  expect(without.of('t3', 'mapped')).toBeUndefined()
  without.close()
})

test("a thread whose turn ended stays working while its workflow runs, each workflow agent with its own steps", async () => {
  threads('telegram', { ...telegram, '-1004422245734:513': { name: 'antibody', session: '51351351-antibody' } })
  job('51351351-antibody', { state: 'working', detail: 'Phase 1 resumed', updatedAt: ago(0), fan: [{ id: 'wfbills', kind: 'workflow', label: 'build:bills' }, { id: 'sh', kind: 'shell', label: 'sleep' }], inFlight: { tasks: 1, kinds: ['local_workflow'] } }, [
    { at: ago(3), state: 'working', detail: 'Phase 1 resumed', text: 'Resumed Phase 1' },
  ])
  running('51351351-antibody', 'idle')
  const antibody = () => tasks.get('telegram:-1004422245734:513')
  await until(() => antibody()?.state === 'working')
  expect(antibody()!.agents.map(agent => [agent.label, agent.state])).toEqual([['build:bills', 'working']])
  step(join(project, '51351351-antibody', 'subagents', 'workflows', 'wf_1', 'agent-wfbills.jsonl'), 'Read', { file_path: '/repo/bills.ts' })
  await until(() => antibody()?.agents[0].line === 'Reading bills.ts')
})

test('a running session no thread holds is a task of its own while it works', async () => {
  job('12121212-review', { state: 'working', detail: 'reviewing autofork', updatedAt: ago(0) })
  job('34343434-probe', { state: 'done', detail: 'probe ran', updatedAt: ago(0) })
  running('12121212-review', 'busy', process.pid, { kind: 'bg', name: 'autofork-review', cwd: '/repo' })
  running('34343434-probe', 'idle', process.pid, { kind: 'bg', name: 'probe' })
  running('56565656-terminal', 'busy', process.pid, { kind: 'interactive', name: 'bassim-1' })
  await until(() => tasks.get('claude:12121212')?.state === 'working')
  expect(tasks.get('claude:12121212')).toMatchObject({ name: 'autofork-review', where: 'Claude Code', line: 'reviewing autofork' })
  expect(tasks.tasks.filter(task => task.app === 'claude').map(task => task.name)).toEqual(['autofork-review', 'bassim-1'])
  job('12121212-review', { state: 'done', detail: 'reviewed', updatedAt: ago(0) })
  running('12121212-review', 'idle', process.pid, { kind: 'bg', name: 'autofork-review', cwd: '/repo' })
  rmSync(join(claude, 'sessions', '56565656.json'))
  await until(() => !tasks.get('claude:12121212') && !tasks.get('claude:56565656'))
})

test("a thread stays working while a session it started runs, that session one of its agents, and while its own shells run", async () => {
  const shell = Bun.spawn(['sh', '-c', 'sleep 30 >/dev/null & echo $!; wait'], { stdout: 'pipe' })
  const { value } = await shell.stdout.getReader().read()
  const build = Number(new TextDecoder().decode(value))
  afterAll(() => {
    process.kill(build)
    shell.kill()
  })
  threads('telegram', { ...telegram, '-1004422245734:3275': { name: 'lab', session: '32753275-lab' } })
  job('32753275-lab', { state: 'done', detail: 'started the build', updatedAt: ago(1) })
  running('32753275-lab', 'idle', shell.pid)
  const lab = () => tasks.get('telegram:-1004422245734:3275')
  await until(() => lab()?.state === 'done')
  running('78787878-build', 'busy', build, { kind: 'interactive', name: 'lab-build-c0', cwd: '/scratch/build', startedAt: Date.now() })
  await until(() => lab()?.state === 'working')
  expect(lab()!.agents.map(agent => [agent.id, agent.label, agent.state])).toEqual([['78787878-build', 'lab-build-c0', 'working']])
  expect(tasks.get('claude:78787878')).toBeUndefined()
  step(join(claude, 'projects', '-scratch-build', '78787878-build.jsonl'), 'Read', { file_path: '/scratch/build/plan.md' })
  await until(() => lab()?.agents[0]?.line === 'Reading plan.md')
  rmSync(join(claude, 'sessions', '78787878.json'))
  await until(() => lab()?.state === 'done')
  running('32753275-lab', 'shell', shell.pid)
  await until(() => lab()?.state === 'working')
})

test("a renewed session's new job folder still wakes the list", async () => {
  rmSync(join(claude, 'jobs', 'aaaaaaaa'), { recursive: true })
  job('aaaaaaaa-general', { state: 'done', detail: 'renewed', updatedAt: ago(0) })
  await until(() => tasks.get('telegram:-1004422245734')?.line === 'renewed')
  await Bun.sleep(100)
  job('aaaaaaaa-general', { state: 'done', detail: 'after the renew', updatedAt: ago(0) })
  await until(() => tasks.get('telegram:-1004422245734')?.line === 'after the renew')
})

test('talking a task through tells the voice which thread it is and where it stands', () => {
  expect(opener(tasks.get('telegram:-1004422245734:908')!)).toBe(
    "The task is the hex thread autofork (Telegram, thread id -1004422245734:908). It's waiting on the caller: Pick a music style, and run claude setup-token",
  )
})
