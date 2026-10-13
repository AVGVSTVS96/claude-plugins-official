import { closeSync, fstatSync, openSync, readdirSync, readFileSync, readSync, watch, type FSWatcher } from 'fs'
import { homedir } from 'os'
import { join } from 'path'
import { followTranscript, headline, sizeOf } from './activity.ts'
import { Changes } from './changes.ts'

export type State = 'working' | 'needs' | 'done' | 'failed' | 'idle'
export type Agent = { id: string; label: string; line?: string }
export type Moment = { at: string; state: State; text: string }
export type Row = Omit<HexTask, 'needs' | 'lately'>
export type Summary = { needs: number; working: number }
export type HexTask = {
  id: string
  app: string
  thread: string
  name: string
  where: string
  state: State
  line: string
  needs?: string
  since: string
  at: string
  agents: Agent[]
  lately: Moment[]
  link?: string
}

type Thread = { app: string; id: string; name: string; session?: string; cwd?: string }
type Job = {
  state?: string
  detail?: string
  needs?: string
  cwd?: string
  updatedAt?: string
  fan?: { id: string; kind: string; label: string; doneAt?: number }[]
}
type Entry = { at: string; state: string; detail?: string; text?: string }
type Follower = { stop: () => void; line?: string }

const CLAUDE = process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), '.claude')
const TAIL = 256 * 1024
const LATELY = 5
const KEEP = 7 * 24 * 60 * 60_000
const ORDER: State[] = ['needs', 'working', 'done', 'failed', 'idle']
const STATES: Record<string, State> = { working: 'working', blocked: 'needs', done: 'done', failed: 'failed' }
const APPS: Record<string, string> = { telegram: 'Telegram', discord: 'Discord', buzz: 'Buzz', t3: 'T3 Code', voice: 'Voice' }

// Every hex thread as a task, from the records Claude Code already keeps (the same ones
// `claude agents --json` prints): each session's job state and timeline, which sessions are
// running, and each app's threads.json for its name. It wakes when one of those files changes,
// follows a working thread's transcript for its newest step, and bumps a version on any change.
// The counts behind the app's Tasks button keep their own version, so it hears only when one moves.
export class Tasks extends Changes {
  tasks: HexTask[] = []
  summary: Summary = { needs: 0, working: 0 }
  counts = new Changes()
  private threads: Thread[] = []
  private jobs = new Map<string, { job?: Job; timeline: Entry[] }>()
  private sessions = new Map<string, string>()
  private watchers = new Map<string, FSWatcher>()
  private appWatchers = new Map<string, () => void>()
  private followers = new Map<string, Follower>()
  private pending?: ReturnType<typeof setTimeout>
  private stale = { threads: true, sessions: true }
  private stops: (() => void)[] = []

  constructor(
    private state: string,
    private hexDir: string,
    private claude = CLAUDE,
  ) {
    super()
    this.stops.push(watchDir(state, file => file && APPS[file] && this.mark('threads')))
    this.stops.push(watchDir(join(claude, 'sessions'), () => this.mark('sessions')))
    this.stops.push(watchDir(join(claude, 'jobs'), file => this.jobChanged(file)))
    this.build()
  }

  get(id: string) {
    return this.tasks.find(task => task.id === id)
  }

  rows(): Row[] {
    return this.tasks.map(({ needs, lately, ...row }) => row)
  }

  close() {
    clearTimeout(this.pending)
    for (const stop of [...this.stops, ...this.appWatchers.values()]) stop()
    for (const watcher of this.watchers.values()) watcher.close()
    for (const follower of this.followers.values()) follower.stop()
  }

  private mark(what: 'threads' | 'sessions') {
    this.stale[what] = true
    this.schedule()
  }

  private jobChanged(short: string | null) {
    if (!short || !this.threads.some(thread => thread.session?.startsWith(short))) return
    this.jobs.delete(short)
    this.watchJob(short)
    this.schedule()
  }

  // A burst of writes (a state, its timeline, a session file) lands as one rebuild.
  private schedule() {
    clearTimeout(this.pending)
    this.pending = setTimeout(() => this.build(), 30)
  }

  private build() {
    if (this.stale.threads) this.readThreads()
    if (this.stale.sessions) this.readSessions()
    this.stale = { threads: false, sessions: false }
    const since = new Date(Date.now() - KEEP).toISOString()
    const tasks = this.threads.map(thread => this.task(thread)).filter(task => task.state === 'needs' || task.state === 'working' || task.at > since)
    this.follow(tasks)
    tasks.sort((a, b) => ORDER.indexOf(a.state) - ORDER.indexOf(b.state) || b.at.localeCompare(a.at))
    if (JSON.stringify(tasks) === JSON.stringify(this.tasks)) return
    this.tasks = tasks
    this.changed()
    const summary = { needs: count(tasks, 'needs'), working: count(tasks, 'working') }
    if (summary.needs === this.summary.needs && summary.working === this.summary.working) return
    this.summary = summary
    this.counts.changed()
  }

  private readThreads() {
    for (const app of apps(this.state))
      if (!this.appWatchers.has(app)) this.appWatchers.set(app, watchDir(join(this.state, app), file => file === 'threads.json' && this.mark('threads')))
    this.threads = apps(this.state).flatMap(app =>
      Object.entries(readJson(join(this.state, app, 'threads.json')) ?? {}).map(([id, thread]: [string, any]) => ({
        app,
        id,
        name: thread.name ?? id,
        session: typeof thread.session === 'string' ? thread.session : undefined,
        cwd: thread.cwd,
      })),
    )
    const wanted = new Set(this.threads.flatMap(thread => (thread.session ? [short(thread.session)] : [])))
    for (const [id, watcher] of this.watchers) {
      if (wanted.has(id)) continue
      watcher.close()
      this.watchers.delete(id)
    }
    for (const id of this.jobs.keys()) if (!wanted.has(id)) this.jobs.delete(id)
    for (const id of wanted) this.watchJob(id)
  }

  private watchJob(id: string) {
    if (this.watchers.has(id)) return
    try {
      this.watchers.set(id, watch(join(this.claude, 'jobs', id), () => this.jobChanged(id)))
    } catch {}
  }

  // Running sessions by id, with Claude Code's busy or idle; a file whose process is gone doesn't count.
  private readSessions() {
    this.sessions.clear()
    const dir = join(this.claude, 'sessions')
    for (const name of list(dir)) {
      if (!name.endsWith('.json')) continue
      const session = readJson(join(dir, name))
      if (session?.sessionId && alive(session.pid)) this.sessions.set(session.sessionId, session.status ?? 'idle')
    }
  }

  private job(session: string) {
    const id = short(session)
    let cached = this.jobs.get(id)
    if (!cached) {
      const dir = join(this.claude, 'jobs', id)
      cached = { job: readJson(join(dir, 'state.json')), timeline: tail(join(dir, 'timeline.jsonl')) }
      this.jobs.set(id, cached)
    }
    return cached
  }

  private task(thread: Thread): HexTask {
    const { job, timeline } = thread.session ? this.job(thread.session) : { job: undefined, timeline: [] }
    const status = thread.session && this.sessions.get(thread.session)
    const running = !!status
    let state: State = (job?.state && STATES[job.state]) ?? (status === 'busy' ? 'working' : 'idle')
    if ((state === 'working' && !running) || job?.detail?.startsWith('(idle')) state = 'idle'
    const lately = timeline
      .filter(entry => entry.text && entry.detail)
      .slice(-LATELY)
      .reverse()
      .map(entry => ({ at: entry.at, state: STATES[entry.state] ?? 'idle', text: plain(entry.detail!) }))
    const at = job?.updatedAt ?? timeline.at(-1)?.at ?? new Date(0).toISOString()
    const needs = state === 'needs' ? plain(job?.needs ?? job?.detail ?? '') || undefined : undefined
    const detail = job?.state === 'stopped' ? undefined : job?.detail && plain(job.detail)
    const step = this.followers.get(thread.session ?? '')?.line
    const line = (state === 'working' ? step : undefined) ?? needs ?? detail ?? lately[0]?.text ?? ''
    const agents = (running ? (job?.fan ?? []) : [])
      .filter(fan => fan.kind === 'agent' && !fan.doneAt)
      .map(({ id, label }) => {
        const line = this.followers.get(`${thread.session} ${id}`)?.line
        return { id, label, ...(line && { line }) }
      })
    return {
      id: `${thread.app}:${thread.id}`,
      app: thread.app,
      thread: thread.id,
      name: thread.name,
      where: where(thread),
      state,
      line: oneLine(line),
      ...(needs && { needs }),
      since: state === 'working' || state === 'needs' ? streak(timeline, job?.state) ?? at : at,
      at,
      agents,
      lately: state === 'idle' ? [] : lately,
      ...(link(thread) && { link: link(thread) }),
    }
  }

  // A working thread's transcript, and its running subagents', give its newest step.
  private follow(tasks: HexTask[]) {
    const wanted = new Map<string, string>()
    for (const task of tasks) {
      if (task.state !== 'working') continue
      const thread = this.threads.find(thread => `${thread.app}:${thread.id}` === task.id)!
      const project = join(this.claude, 'projects', (this.job(thread.session!).job?.cwd ?? thread.cwd ?? this.hexDir).replace(/[^a-zA-Z0-9]/g, '-'))
      wanted.set(thread.session!, join(project, `${thread.session}.jsonl`))
      for (const agent of task.agents) wanted.set(`${thread.session} ${agent.id}`, join(project, thread.session!, 'subagents', `agent-${agent.id}.jsonl`))
    }
    for (const [key, follower] of this.followers) {
      if (wanted.has(key)) continue
      follower.stop()
      this.followers.delete(key)
    }
    for (const [key, path] of wanted) {
      if (this.followers.has(key)) continue
      const follower: Follower = { stop: () => {} }
      this.followers.set(key, follower)
      follower.stop = followTranscript(path, Math.max(0, sizeOf(path) - TAIL), (_, updates) => {
        for (const update of updates()) {
          const line = headline(update)
          if (line) follower.line = line
        }
        this.schedule()
      })
    }
  }
}

// What the voice and Claude hear about a task when the caller wants to talk it through.
export function opener(task: HexTask) {
  const state = {
    needs: `It's waiting on the caller: ${task.needs ?? task.line}`,
    working: `It's working: ${task.line}`,
    done: `It finished: ${task.line}`,
    failed: `It failed: ${task.line}`,
    idle: `It's idle${task.line ? `; last: ${task.line}` : ''}`,
  }[task.state]
  return `The task is the hex thread ${task.name} (${task.where}, thread id ${task.thread}). ${state}`
}

function count(tasks: HexTask[], state: State) {
  return tasks.filter(task => task.state === state).length
}

function apps(state: string) {
  return list(state).filter(app => APPS[app])
}

function where(thread: Thread) {
  if (thread.app === 'telegram' && !thread.id.includes(':')) return thread.id.startsWith('-') ? 'General' : 'DM'
  return APPS[thread.app]
}

function link(thread: Thread) {
  if (thread.app !== 'telegram' || !thread.id.startsWith('-100')) return
  const [chat, topic = '1'] = thread.id.slice(4).split(':')
  return `https://t.me/c/${chat}/${topic}`
}

// When the job's current state began: the oldest of the newest run of timeline entries in it.
function streak(timeline: Entry[], state?: string) {
  let since: string | undefined
  for (let i = timeline.length - 1; i >= 0 && timeline[i].state === state; i--) since = timeline[i].at
  return since
}

function short(session: string) {
  return session.slice(0, 8)
}

function plain(text: string) {
  return text.replace(/\*\*|__|`/g, '').replace(/\s+/g, ' ').trim()
}

function oneLine(text: string) {
  return text.length > 240 ? `${text.slice(0, 239)}…` : text
}

function tail(path: string): Entry[] {
  let fd
  try {
    fd = openSync(path, 'r')
  } catch {
    return []
  }
  try {
    const size = fstatSync(fd).size
    const start = Math.max(0, size - TAIL)
    const chunk = Buffer.alloc(size - start)
    readSync(fd, chunk, 0, chunk.length, start)
    const lines = chunk.toString('utf8').split('\n')
    return (start ? lines.slice(1) : lines).flatMap(line => {
      try {
        return [JSON.parse(line)]
      } catch {
        return []
      }
    })
  } finally {
    closeSync(fd)
  }
}

function watchDir(dir: string, changed: (file: string | null) => void) {
  try {
    const watcher = watch(dir, (_, file) => changed(file))
    return () => watcher.close()
  } catch {
    return () => {}
  }
}

function alive(pid: unknown) {
  try {
    return typeof pid === 'number' && process.kill(pid, 0)
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM'
  }
}

function list(dir: string) {
  try {
    return readdirSync(dir)
  } catch {
    return []
  }
}

function readJson(path: string) {
  try {
    return JSON.parse(readFileSync(path, 'utf8'))
  } catch {}
}
