import { closeSync, fstatSync, mkdirSync, openSync, readFileSync, readSync, readdirSync, statSync, watch } from 'fs'
import { homedir } from 'os'
import { basename, dirname, join } from 'path'
import { toAcpNotifications } from '@agentclientprotocol/claude-agent-acp'
import type { SessionNotification, ToolCall } from '@agentclientprotocol/sdk'

export type Update = SessionNotification['update']
export type Step = { line?: string; end?: 'done' | 'failed' }
export type Thread = { app: string; id: string; name: string; cwd?: string; threads: string }

const PROJECTS = join(process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), '.claude'), 'projects')
const client = { sessionUpdate: async () => {} } as unknown as Parameters<typeof toAcpNotifications>[4]
const logger = { log: () => {}, error: (...args: unknown[]) => process.stderr.write(`voice: activity: ${args.join(' ')}\n`) }
const ID = /^[\w-]+$/

// What an agent is doing right now, in a few words, from one ACP session/update.
export function headline(update: Update): string | undefined {
  switch (update.sessionUpdate) {
    case 'tool_call':
      return step(update)
    case 'agent_message_chunk':
      return update.content.type === 'text' ? firstLine(update.content.text) : undefined
    case 'agent_thought_chunk':
      return 'Thinking'
    case 'plan':
      return update.entries.find(entry => entry.status === 'in_progress')?.content
  }
}

function step({ title, kind, rawInput, locations, _meta }: ToolCall) {
  const input = (rawInput ?? {}) as Record<string, string | undefined>
  const tool: string = (_meta as any)?.claudeCode?.toolName ?? title
  const file = locations?.[0]?.path ?? input.file_path ?? input.notebook_path
  switch (kind) {
    case 'execute':
      return input.description || `Running ${firstLine(input.command ?? title)}`
    case 'read':
      return file ? `Reading ${basename(file)}` : title
    case 'edit':
      return `${tool === 'Write' ? 'Writing' : 'Editing'} ${basename(file ?? title)}`
    case 'search':
      return input.pattern ? `Searching for ${input.pattern}` : title
    case 'fetch':
      return input.query ? `Searching the web for ${input.query}` : input.url ? `Reading ${new URL(input.url).host}` : title
    case 'think':
      return input.description && `Started an agent: ${input.description}`
  }
  const mcp = tool.match(/^mcp__(.+?)__(.+)$/)
  if (mcp) return `${mcp[1].split('_').at(-1)!.replace(/^./, letter => letter.toUpperCase())}: ${mcp[2].replaceAll('_', ' ')}`
  if (input.skill) return `Using the ${input.skill} skill`
  return title === tool ? undefined : title
}

function firstLine(text: string) {
  const line = text
    .trim()
    .split('\n')[0]
    .replace(/^(#+|[-*>]|\d+\.)\s+/, '')
    .replace(/\*\*|__|`/g, '')
    .trim()
  return line ? line.slice(0, 160) : undefined
}

// Follows one Claude Code transcript as Claude Code writes it (a file change, not a timer), from
// a byte offset or its end: every new line, and the ACP updates its assistant content makes,
// converted when asked for. A line cut in half by the offset is skipped.
export function followTranscript(path: string, from: number | 'end', onEntry: (entry: any, updates: () => Update[]) => void) {
  const tools = {}
  const tasks = new Map()
  let offset = from === 'end' ? sizeOf(path) : from
  let rest = Buffer.alloc(0)
  let closed = false
  mkdirSync(dirname(path), { recursive: true })
  const watcher = watch(dirname(path), (_, file) => file === basename(path) && read())
  read()

  function read() {
    if (closed) return
    let fd
    try {
      fd = openSync(path, 'r')
    } catch {
      return
    }
    try {
      const size = fstatSync(fd).size
      if (size <= offset) return
      const chunk = Buffer.alloc(size - offset)
      readSync(fd, chunk, 0, chunk.length, offset)
      offset = size
      const data = Buffer.concat([rest, chunk])
      const last = data.lastIndexOf(10)
      rest = data.subarray(last + 1)
      if (last >= 0) for (const line of data.subarray(0, last).toString('utf8').split('\n')) if (!closed) take(line)
    } finally {
      closeSync(fd)
    }
  }

  function take(line: string) {
    let entry
    try {
      entry = JSON.parse(line)
    } catch {
      return
    }
    const content = entry.type === 'assistant' ? entry.message?.content : undefined
    onEntry(entry, () =>
      content
        ? toAcpNotifications(content, 'assistant', entry.sessionId ?? '', tools, client, logger, {
            registerHooks: false,
            replay: true,
            cwd: entry.cwd ?? '',
            taskState: tasks,
            messageId: entry.message.id,
          }).map(notification => notification.update)
        : [],
    )
  }

  return () => {
    closed = true
    watcher.close()
  }
}

// A background subagent's live steps, by the agentId its Agent call returned. Its own session's
// subagents come first; any session's will do.
export function followAgent(agent: string, session: string | undefined, onStep: (step: Step) => void) {
  if (!ID.test(agent)) return
  const patterns = [...(session && ID.test(session) ? [`*/${session}/subagents/agent-${agent}.jsonl`] : []), `*/*/subagents/agent-${agent}.jsonl`]
  for (const pattern of patterns)
    for (const path of new Bun.Glob(pattern).scanSync({ cwd: PROJECTS, absolute: true }))
      return followTranscript(path, 0, (_, updates) => lines(updates(), onStep))
}

// hex threads (Telegram topics, Discord, Buzz and T3 Code threads), from each app's threads.json.
export function findThread(state: string, wanted: string): Thread | undefined {
  const lower = wanted.toLowerCase()
  for (const app of readdirSync(state)) {
    if (app === 'voice') continue
    const threads = join(state, app, 'threads.json')
    const all: Record<string, { name?: string; cwd?: string }> = readJson(threads) ?? {}
    const id = all[wanted] ? wanted : Object.keys(all).find(id => all[id].name?.toLowerCase() === lower)
    if (id) return { app, id, name: all[id].name ?? id, cwd: all[id].cwd, threads }
  }
}

// One message sent to a hex thread, followed through its session's transcript: it waits until the
// session takes in the message carrying `tag`, shows each step after that (its background agents'
// steps too), and ends when a turn ends with none of those agents still out. A new session for the
// thread (a renewal or a restart) shows up in threads.json and is followed from its start; so is
// the first one when following resumes a message sent earlier.
export function followThread(thread: Thread, hexDir: string, tag: string, resumed: boolean, onStep: (step: Step) => void) {
  const agents = new Map<string, () => void>()
  let session: string | undefined
  let project = ''
  let stopSession = () => {}
  let picked = false
  let failed = false
  let ended = false

  const stopState = watchFile(thread.threads, locate)
  locate()

  function locate() {
    const next = readJson(thread.threads)?.[thread.id]?.session
    if (ended || !next || next === session || !ID.test(next)) return
    const fresh = resumed || session !== undefined
    stopSession()
    session = next
    project = join(PROJECTS, (thread.cwd ?? hexDir).replace(/[^a-zA-Z0-9]/g, '-'))
    stopSession = followTranscript(join(project, `${session}.jsonl`), fresh ? 0 : 'end', take)
  }

  function take(entry: any, updates: () => Update[]) {
    if (!picked) {
      const content = entry.message?.content
      picked = entry.type === 'user' && entry.origin?.kind === 'channel' && (typeof content === 'string' ? content : JSON.stringify(content)).includes(tag)
      return
    }
    const launched = entry.toolUseResult?.isAsync && entry.toolUseResult.agentId
    if (launched && ID.test(launched) && !agents.has(launched))
      agents.set(launched, followTranscript(join(project, session!, 'subagents', `agent-${launched}.jsonl`), 0, (_, updates) => lines(updates(), onStep)))
    const back = entry.origin?.kind === 'task-notification' && JSON.stringify(entry.message?.content).match(/<task-id>([\w-]+)<\/task-id>/)?.[1]
    if (back) {
      agents.get(back)?.()
      agents.delete(back)
    }
    if (entry.type === 'assistant') failed = entry.isApiErrorMessage === true
    lines(updates(), onStep)
    if (entry.type === 'system' && entry.subtype === 'turn_duration' && !agents.size) {
      close()
      onStep({ end: failed ? 'failed' : 'done' })
    }
  }

  function close() {
    ended = true
    stopState()
    stopSession()
    for (const stop of agents.values()) stop()
    agents.clear()
  }

  return close
}

function lines(updates: Update[], onStep: (step: Step) => void) {
  for (const update of updates) {
    const line = headline(update)
    if (line) onStep({ line })
  }
}

function watchFile(path: string, changed: () => void) {
  const watcher = watch(dirname(path), (_, file) => file === basename(path) && changed())
  return () => watcher.close()
}

function readJson(path: string) {
  try {
    return JSON.parse(readFileSync(path, 'utf8'))
  } catch {}
}

export function sizeOf(path: string) {
  try {
    return statSync(path).size
  } catch {
    return 0
  }
}
