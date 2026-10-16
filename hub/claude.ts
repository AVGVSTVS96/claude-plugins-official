import { execFile, spawn } from 'child_process'
import { closeSync, fstatSync, openSync, readFileSync, readSync, watch } from 'fs'
import { homedir } from 'os'
import { join } from 'path'

// A background session as `claude agents --json` lists it.
export type Agent = { sessionId: string; id?: string; pid: number; status?: string; startedAt?: number }
// The context a session's last request sent and when; short: it wrote the five-minute cache.
export type Usage = { sent: number; at?: number; short?: boolean }

const home = () => process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), '.claude')
const short = (session: string) => session.slice(0, 8)

function run(args: string[]): Promise<string> {
  return new Promise(resolve => execFile('claude', args, (_, stdout) => resolve(stdout)))
}

export async function agents(): Promise<Agent[]> {
  try {
    return (JSON.parse(await run(['agents', '--json'])) as Agent[]).filter(agent => agent.pid)
  } catch {
    return []
  }
}

export async function agent(session: string): Promise<Agent | undefined> {
  return (await agents()).find(agent => agent.sessionId === session)
}

export const stop = (session: string) => run(['stop', short(session)])
// `claude --bg --resume` copies the conversation to a new id while the old session's job record
// exists, even once stopped; this clears the record and keeps the conversation.
export const rm = (session: string) => run(['rm', short(session)])
// Restarts a running session in place from the flags it started with, running a turn it was on again.
export const respawn = (agent: Agent) => run(['respawn', job(agent)])

// Resolves with the new session's job once Claude has put it in the background.
export function start(launcher: string, args: string[], options: { cwd: string; env: Record<string, string | undefined> }): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(launcher, ['--bg', ...args], { ...options, stdio: ['ignore', 'pipe', 'pipe'] })
    let output = ''
    child.stdout.on('data', chunk => (output += chunk))
    child.stderr.on('data', chunk => (output += chunk))
    child.on('error', reject)
    child.on('close', code => {
      const job = output.match(/backgrounded · (\w+)/)?.[1]
      if (job) resolve(job)
      else reject(new Error(output.trim() || `claude --bg exited with code ${code}`))
    })
  })
}

// Node can't wait on a process it didn't start, and pidwait isn't on every system (macOS has
// none), so the process is checked until it's gone.
export function exited(pid: number): Promise<void> {
  return new Promise(resolve => {
    const check = () => {
      try {
        process.kill(pid, 0)
        setTimeout(check, 100)
      } catch {
        resolve()
      }
    }
    check()
  })
}

function job(agent: Agent) {
  return agent.id ?? short(agent.sessionId)
}

export type Job = { state?: string; detail?: string; sessionId?: string; respawnFlags?: string[] }

export function record(id: string): Job {
  try {
    return JSON.parse(readFileSync(join(home(), 'jobs', id, 'state.json'), 'utf8'))
  } catch {
    return {}
  }
}

export function watchJob(id: string, change: () => void) {
  return watch(join(home(), 'jobs', id), change)
}

// Claude keeps the flags a session started with, since it respawns from them, so the settings
// file it was given says what it serves.
export function envOf(agent: Agent): Record<string, string> | undefined {
  const flags = record(job(agent)).respawnFlags ?? []
  try {
    return JSON.parse(readFileSync(flags[flags.lastIndexOf('--settings') + 1]!, 'utf8')).env
  } catch {
    return undefined
  }
}

export function transcript(cwd: string, session: string) {
  return join(home(), 'projects', cwd.replace(/[^a-zA-Z0-9]/g, '-'), `${session}.jsonl`)
}

// From the newest usage or compaction in the session's transcript.
export function usage(cwd: string, session: string): Usage {
  let file: number
  try {
    file = openSync(transcript(cwd, session), 'r')
  } catch {
    return { sent: 0 }
  }
  try {
    const size = fstatSync(file).size
    const tail = Buffer.alloc(Math.min(size, 1 << 20))
    readSync(file, tail, 0, tail.length, size - tail.length)
    for (const line of tail.toString('utf8').split('\n').reverse()) {
      if (!line.includes('"usage"') && !line.includes('"compact_boundary"')) continue
      let entry: any
      try {
        entry = JSON.parse(line)
      } catch {
        continue
      }
      const at = entry.timestamp ? Date.parse(entry.timestamp) : undefined
      if (entry.type === 'system' && entry.subtype === 'compact_boundary') return { sent: entry.compactMetadata?.postTokens ?? 0, at }
      const usage = entry.type === 'assistant' && !entry.isSidechain ? entry.message?.usage : undefined
      const sent = usage ? (usage.input_tokens ?? 0) + (usage.cache_creation_input_tokens ?? 0) + (usage.cache_read_input_tokens ?? 0) : 0
      if (sent) return { sent, at, short: !!usage.cache_creation?.ephemeral_5m_input_tokens && !usage.cache_creation?.ephemeral_1h_input_tokens }
    }
    return { sent: 0 }
  } finally {
    closeSync(file)
  }
}
