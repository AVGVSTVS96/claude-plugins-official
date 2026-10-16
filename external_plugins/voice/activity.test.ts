import { afterAll, expect, test } from 'bun:test'
import { appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

const home = mkdtempSync(join(tmpdir(), 'voice-activity-'))
process.env.CLAUDE_CONFIG_DIR = join(home, 'claude')
const { findThread, followAgent, followThread, followTranscript, headline, stepOf } = await import('./activity.ts')
afterAll(() => rmSync(home, { recursive: true }))

const hex = '/home/someone/hex'
const project = join(home, 'claude', 'projects', '-home-someone-hex')
const state = join(home, 'state')

function tool(name: string, input: object) {
  return { type: 'assistant', message: { id: `msg_${name}`, content: [{ type: 'tool_use', id: `toolu_${name}_${Math.random()}`, name, input }] } }
}
const said = (text: string, extra = {}) => ({ type: 'assistant', message: { id: 'msg_text', content: [{ type: 'text', text }] }, ...extra })
const ended = { type: 'system', subtype: 'turn_duration' }

function write(path: string, ...entries: object[]) {
  appendFileSync(path, entries.map(entry => JSON.stringify(entry) + '\n').join(''))
}

async function until(check: () => boolean) {
  for (let i = 0; i < 100 && !check(); i++) await Bun.sleep(20)
  expect(check()).toBe(true)
}

function threads(app: string, all: object) {
  mkdirSync(join(state, app), { recursive: true })
  writeFileSync(join(state, app, 'threads.json'), JSON.stringify(all))
}

test('each kind of step reads as a few plain words', () => {
  const steps = [
    tool('Bash', { command: 'git log --oneline', description: 'Show recent commits' }),
    tool('Bash', { command: 'uptime\nfree -g' }),
    tool('Read', { file_path: '/home/someone/hex/projects/notes/transcript.md' }),
    tool('Edit', { file_path: '/repo/src/live-screen.tsx', old_string: 'a', new_string: 'b' }),
    tool('Write', { file_path: '/repo/README.md', content: 'hi' }),
    tool('Grep', { pattern: 'activity' }),
    tool('WebSearch', { query: 'expo sdk 57 widgets' }),
    tool('WebFetch', { url: 'https://docs.expo.dev/versions/v57.0.0/', prompt: 'read' }),
    tool('Agent', { description: 'Fresh read of the transcript', prompt: 'go' }),
    tool('mcp__plugin_telegram_telegram__reply', { text: 'done' }),
    tool('mcp__claude_ai_Gmail__search_threads', { query: 'invoice' }),
    tool('ToolSearch', { query: 'select:Monitor' }),
  ]
  const path = join(home, 'steps.jsonl')
  write(path, ...steps)
  const lines: (string | undefined)[] = []
  followTranscript(path, 0, (_: unknown, updates: () => any[]) => lines.push(...updates().map(headline)))()
  expect(lines).toEqual([
    'Show recent commits',
    'Running uptime',
    'Reading transcript.md',
    'Editing live-screen.tsx',
    'Writing README.md',
    'Searching for activity',
    'Searching the web for expo sdk 57 widgets',
    'Reading docs.expo.dev',
    'Started an agent: Fresh read of the transcript',
    'Telegram: reply',
    'Gmail: search threads',
    undefined,
  ])
})

test('each step says what kind it is, and a thought keeps its own words where the agent line says Thinking', () => {
  const path = join(home, 'kinds.jsonl')
  write(
    path,
    tool('Bash', { command: 'npm run check' }),
    tool('Read', { file_path: '/repo/a.ts' }),
    tool('Edit', { file_path: '/repo/a.ts', old_string: 'a', new_string: 'b' }),
    tool('Grep', { pattern: 'lane' }),
    tool('WebFetch', { url: 'https://ui.shadcn.com/docs', prompt: 'read' }),
    tool('Agent', { description: 'Judge the restyles', prompt: 'go' }),
    tool('mcp__plugin_telegram_telegram__reply', { text: 'done' }),
    said('Sent it.'),
  )
  const kinds: string[] = []
  followTranscript(path, 0, (_: unknown, updates: () => any[]) => kinds.push(...updates().map(update => stepOf(update)?.kind)))()
  expect(kinds).toEqual(['run', 'read', 'edit', 'search', 'web', 'agent', 'tool', 'say'])
  const thought = { sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: 'The **lane** first.\n\nThen rows.' } } as const
  expect(stepOf(thought)).toEqual({ kind: 'think', text: 'The lane first. Then rows.' })
  expect(headline(thought)).toBe('Thinking')
})

test("an agent's own words read as their first line, without markdown, and its plan as the step in progress", () => {
  expect(headline({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: '**Found it.** The hub drops\nthe rest' } })).toBe('Found it. The hub drops')
  expect(headline({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: '  \n' } })).toBeUndefined()
  expect(
    headline({
      sessionUpdate: 'plan',
      entries: [
        { content: 'Read the hub', status: 'completed', priority: 'medium' },
        { content: 'Wire the line', status: 'in_progress', priority: 'medium' },
      ],
    }),
  ).toBe('Wire the line')
})

test("a background subagent's steps come from its transcript as it writes them", async () => {
  const dir = join(project, 'brain-session', 'subagents')
  mkdirSync(dir, { recursive: true })
  const path = join(dir, 'agent-a1b2.jsonl')
  write(path, { type: 'user', isSidechain: true, message: { role: 'user', content: 'You are a subagent.' } }, tool('Read', { file_path: '/x/plan.md' }))
  const lines: string[] = []
  const stop = followAgent('a1b2', 'brain-session', step => step.line && lines.push(step.line))!
  expect(lines).toEqual(['Reading plan.md'])
  write(path, said('Read it; checking the hub next.'))
  await until(() => lines.length === 2)
  expect(lines[1]).toBe('Read it; checking the hub next.')
  stop()
  expect(followAgent('nobody', 'brain-session', () => {})).toBeUndefined()
  expect(followAgent('../x', 'brain-session', () => {})).toBeUndefined()
})

test('a thread is found by its id or its name, in any app but voice', () => {
  threads('telegram', { '-100:452': { name: 'voiceapp', session: 's1' } })
  threads('voice', { voice: { name: 'voice', session: 'v' } })
  threads('t3', { 't3-id': { name: 'commonplace', cwd: '/home/someone/Developer/commonplace' } })
  expect(findThread(state, 'VoiceApp')).toMatchObject({ app: 'telegram', id: '-100:452', name: 'voiceapp' })
  expect(findThread(state, 't3-id')).toMatchObject({ app: 't3', cwd: '/home/someone/Developer/commonplace' })
  expect(findThread(state, 'voice')).toBeUndefined()
})

test("a message sent to a thread shows that thread's steps once it takes the message in, its agents' too, and is done when a turn ends with no agent out", async () => {
  mkdirSync(project, { recursive: true })
  const path = join(project, 's1.jsonl')
  write(path, tool('Bash', { command: 'ls', description: 'Earlier work' }), ended)
  const steps: object[] = []
  const stop = followThread(findThread(state, 'voiceapp')!, hex, 'tag42', false, step => steps.push(step))
  write(path, tool('Bash', { command: 'ls', description: 'Work on something else' }))
  write(path, { type: 'user', origin: { kind: 'channel' }, message: { role: 'user', content: '<channel source="telegram" user="hex voice" voice_task="tag42">the orb bounces</channel>' } })
  write(path, tool('Agent', { description: 'Tune the glide', prompt: 'go' }))
  write(path, { type: 'user', message: { role: 'user', content: [] }, toolUseResult: { isAsync: true, agentId: 'agent7' } }, ended)
  await until(() => steps.length === 1)
  expect(steps).toEqual([{ line: 'Started an agent: Tune the glide' }])

  const agent = join(project, 's1', 'subagents', 'agent-agent7.jsonl')
  mkdirSync(join(project, 's1', 'subagents'), { recursive: true })
  write(agent, tool('Edit', { file_path: '/repo/src/motion.ts', old_string: 'a', new_string: 'b' }))
  await until(() => steps.length === 2)
  expect(steps[1]).toEqual({ line: 'Editing motion.ts' })

  write(path, { type: 'user', origin: { kind: 'task-notification' }, message: { role: 'user', content: '<task-notification>\n<task-id>agent7</task-id>\n<status>completed</status>' } })
  write(path, said('The glide no longer overshoots.'), ended)
  await until(() => steps.length === 4)
  expect(steps.slice(2)).toEqual([{ line: 'The glide no longer overshoots.' }, { end: 'done' }])
  stop()
})

test("a thread's new session is followed from its start, and a turn that ends on an API error fails", async () => {
  threads('discord', { d1: { name: 'Latest Claude', session: 'old' } })
  const steps: object[] = []
  followThread(findThread(state, 'latest claude')!, hex, 'tag7', false, step => steps.push(step))
  write(join(project, 'new.jsonl'), { type: 'user', origin: { kind: 'channel' }, message: { role: 'user', content: 'voice_task="tag7"' } })
  threads('discord', { d1: { name: 'Latest Claude', session: 'new' } })
  await Bun.sleep(50)
  write(join(project, 'new.jsonl'), said("You've hit your weekly limit", { isApiErrorMessage: true }), ended)
  await until(() => steps.length === 2)
  expect(steps).toEqual([{ line: "You've hit your weekly limit" }, { end: 'failed' }])
})

test('following a message sent before a restart reads its thread from the start, and ends at once when the thread already finished', () => {
  threads('buzz', { b1: { name: 'Context check', session: 'done-already' } })
  write(join(project, 'done-already.jsonl'), { type: 'user', origin: { kind: 'channel' }, message: { role: 'user', content: 'voice_task="call:id"' } }, said('All set.'), ended)
  const steps: object[] = []
  followThread(findThread(state, 'context check')!, hex, 'call:id', true, step => steps.push(step))
  expect(steps).toEqual([{ line: 'All set.' }, { end: 'done' }])
})
