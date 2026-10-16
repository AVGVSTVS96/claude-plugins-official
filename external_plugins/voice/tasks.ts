import { closeSync, fstatSync, mkdirSync, openSync, readdirSync, readFileSync, readSync, watch, type FSWatcher } from 'fs'
import { homedir } from 'os'
import { join } from 'path'
import { followTranscript, sizeOf, stepOf, type Did } from './activity.ts'
import { Changes } from './changes.ts'
import { Links } from './links.ts'

export type State = 'working' | 'needs' | 'done' | 'failed' | 'idle'
export type Step = Did & { at: string }
export type Planned = { text: string; state: 'done' | 'running' | 'pending' }
export type Agent = { id: string; label: string; state: 'working' | 'done'; line?: string; steps: Step[] }
export type Moment = { at: string; state: State; text: string }
export type Turn = { at: string; state: State }
export type Row = Omit<HexTask, 'needs' | 'lately' | 'steps' | 'plan' | 'agents'> & { agents: Omit<Agent, 'steps'>[] }
export type Summary = { needs: number; working: number }
export type HexTask = {
  id: string
  app: string
  thread: string
  name: string
  where: string
  place: string
  state: State
  line: string
  needs?: string
  since: string
  at: string
  agents: Agent[]
  steps: Step[]
  plan: Planned[]
  lately: Moment[]
  track: Turn[]
  link?: string
}

type Thread = { app: string; id: string; name: string; session?: string; cwd?: string; link?: string; title?: string }
type Session = { id: string; pid: number; status: string; name?: string; cwd?: string; started: number; at: number; parent?: string }
type Job = {
  state?: string
  detail?: string
  needs?: string
  cwd?: string
  updatedAt?: string
  fan?: { id: string; kind: string; label: string; doneAt?: number }[]
}
type Entry = { at: string; state: string; detail?: string; text?: string }
type Follower = { stop: () => void; steps: Step[]; plan: Planned[] }

const CLAUDE = process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), '.claude')
const TAIL = 256 * 1024
const LATELY = 5
const STEPS = 12
const KEEP = 7 * 24 * 60 * 60_000
const TRACK = 12 * 60 * 60_000
const ORDER: State[] = ['needs', 'working', 'done', 'failed', 'idle']
const RECORDS = new Set(['threads.json', 'guild.json', 'bot.json', 'channels.json'])
const STATES: Record<string, State> = { working: 'working', blocked: 'needs', done: 'done', failed: 'failed' }
const PLANNED: Record<string, Planned['state']> = { completed: 'done', in_progress: 'running', pending: 'pending' }
const APPS: Record<string, string> = { telegram: 'Telegram', discord: 'Discord', buzz: 'Buzz', t3: 'T3 Code', voice: 'Voice', claude: 'Claude Code' }
const WORK = new Set(['agent', 'workflow'])
const BUSY = new Set(['busy', 'shell'])

// Every hex thread as a task, from the records Claude Code already keeps (the same ones
// `claude agents --json` prints): each session's job state and timeline, which sessions are
// running, and each app's threads.json for its name and `links.ts` for where its app opens it.
// A session another one started (a topic's `claude -p` build) counts toward it as one of its
// agents; a running session nothing holds is a task of its own while it works. It wakes when one
// of those files changes, follows a working thread's transcript for its newest step, and bumps a
// version on any change.
// The counts behind the app's Tasks button keep their own version, so it hears only when one moves.
export class Tasks extends Changes {
  tasks: HexTask[] = []
  summary: Summary = { needs: 0, working: 0 }
  counts = new Changes()
  private threads: Thread[] = []
  private links: Links
  private jobs = new Map<string, { job?: Job; timeline: Entry[] }>()
  private sessions = new Map<string, Session>()
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
    t3?: string,
  ) {
    super()
    this.links = new Links(state, () => this.mark('threads'), t3)
    this.stops.push(watchDir(state, file => file && APPS[file] && this.mark('threads')))
    this.stops.push(watchDir(join(claude, 'sessions'), () => this.mark('sessions')))
    this.stops.push(watchDir(join(claude, 'jobs'), file => this.jobChanged(file, true)))
    this.build()
  }

  get(id: string) {
    return this.tasks.find(task => task.id === id)
  }

  rows(): Row[] {
    return this.tasks.map(({ needs, lately, steps, plan, agents, ...row }) => ({ ...row, agents: agents.map(({ steps, ...agent }) => agent) }))
  }

  close() {
    clearTimeout(this.pending)
    this.links.close()
    for (const stop of [...this.stops, ...this.appWatchers.values()]) stop()
    for (const watcher of this.watchers.values()) watcher.close()
    for (const follower of this.followers.values()) follower.stop()
  }

  private mark(what: 'threads' | 'sessions') {
    this.stale[what] = true
    this.schedule()
  }

  // A renewed session gets a new job folder, and a watch on the old one hears nothing more.
  private jobChanged(short: string | null, folder = false) {
    if (!short || !this.wanted().has(short)) return
    if (folder) this.unwatchJob(short)
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
    if (this.stale.threads || this.stale.sessions) this.watchJobs()
    this.stale = { threads: false, sessions: false }
    const since = new Date(Date.now() - KEEP).toISOString()
    const threads = this.threads.map(thread => this.task(thread)).filter(task => task.state === 'needs' || task.state === 'working' || task.at > since)
    const tasks = [...threads, ...this.loose().map(thread => this.task(thread)).filter(task => task.state === 'working')]
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
      if (!this.appWatchers.has(app)) this.appWatchers.set(app, watchDir(join(this.state, app), file => !!file && RECORDS.has(file) && this.mark('threads')))
    this.links.load()
    this.threads = apps(this.state).flatMap(app =>
      Object.entries(readJson(join(this.state, app, 'threads.json')) ?? {}).map(([id, thread]: [string, any]) => ({
        app,
        id,
        name: thread.name ?? id,
        session: typeof thread.session === 'string' ? thread.session : undefined,
        cwd: thread.cwd,
        link: this.links.of(app, id),
        title: this.links.title(app, id),
      })),
    )
  }

  private held() {
    return new Set(this.threads.map(thread => thread.session))
  }

  // Running sessions no thread holds and no other session started, named as Claude Code named them.
  private loose(): Thread[] {
    const held = this.held()
    return [...this.sessions.values()]
      .filter(session => !session.parent && !held.has(session.id))
      .map(session => ({ app: 'claude', id: short(session.id), name: session.name ?? short(session.id), session: session.id, cwd: session.cwd }))
  }

  // The busy sessions whose work counts toward this one: started below it, and not a thread's own.
  private started(id: string) {
    const held = this.held()
    const owner = (session?: Session): string | undefined => (session?.parent && !held.has(session.id) ? owner(this.sessions.get(session.parent)) : session?.id)
    return [...this.sessions.values()].filter(session => session.id !== id && busy(session) && owner(session) === id)
  }

  private wanted() {
    return new Set([...this.threads, ...this.loose()].flatMap(thread => (thread.session ? [short(thread.session)] : [])))
  }

  private watchJobs() {
    const wanted = this.wanted()
    for (const id of this.watchers.keys()) if (!wanted.has(id)) this.unwatchJob(id)
    for (const id of this.jobs.keys()) if (!wanted.has(id)) this.jobs.delete(id)
    for (const id of wanted) this.watchJob(id)
  }

  private watchJob(id: string) {
    if (this.watchers.has(id)) return
    try {
      this.watchers.set(id, watch(join(this.claude, 'jobs', id), () => this.jobChanged(id)))
    } catch {}
  }

  private unwatchJob(id: string) {
    this.watchers.get(id)?.close()
    this.watchers.delete(id)
  }

  // Running sessions by id, with Claude Code's status; a file whose process is gone doesn't count.
  // A session's parent is the nearest session above it in the process tree.
  private readSessions() {
    this.sessions.clear()
    const dir = join(this.claude, 'sessions')
    for (const name of list(dir)) {
      if (!name.endsWith('.json')) continue
      const record = readJson(join(dir, name))
      if (!record?.sessionId || !alive(record.pid) || busy(this.sessions.get(record.sessionId))) continue
      const { sessionId: id, pid, status = 'idle', name: title, cwd, startedAt = 0 } = record
      this.sessions.set(id, { id, pid, status, name: title, cwd, started: startedAt, at: record.statusUpdatedAt ?? startedAt })
    }
    const byPid = new Map([...this.sessions.values()].map(session => [session.pid, session.id]))
    const parents = processParents()
    for (const session of this.sessions.values())
      for (let pid = parents.get(session.pid); pid && pid > 1 && !session.parent; pid = parents.get(pid)) session.parent = byPid.get(pid)
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
    const session = thread.session ? this.sessions.get(thread.session) : undefined
    const started = thread.session ? this.started(thread.session) : []
    const known = job?.state ? STATES[job.state] : undefined
    const live = busy(session) || started.length > 0
    let state: State = live ? 'working' : (known ?? 'idle')
    if (!live && ((state === 'working' && !session) || job?.detail?.startsWith('(idle'))) state = 'idle'
    const lately = timeline
      .filter(entry => entry.text && entry.detail)
      .slice(-LATELY)
      .reverse()
      .map(entry => ({ at: entry.at, state: STATES[entry.state] ?? 'idle', text: plain(entry.detail!) }))
    const at = job?.updatedAt ?? timeline.at(-1)?.at ?? new Date(0).toISOString()
    const needs = state === 'needs' ? plain(job?.needs ?? job?.detail ?? '') || undefined : undefined
    const detail = job?.state === 'stopped' ? undefined : job?.detail && plain(job.detail)
    const began = Math.min(...started.map(one => one.started), busy(session) ? session!.at : Infinity)
    const since =
      state === 'working' && known !== 'working' ? new Date(began).toISOString() : state === 'working' || state === 'needs' ? (streak(timeline, job?.state) ?? at) : at
    const steps = state === 'working' ? this.steps(thread.session!) : []
    const plan = state === 'working' ? (this.followers.get(thread.session!)?.plan ?? []) : []
    const line = steps[0]?.text ?? needs ?? detail ?? lately[0]?.text ?? ''
    const agents = (
      state === 'working'
        ? [
            ...(job?.fan ?? [])
              .filter(fan => WORK.has(fan.kind) && (!fan.doneAt || fan.doneAt >= Date.parse(since)))
              .map(({ id, label, doneAt }) => this.agent(thread.session!, id, label, doneAt)),
            ...started.map(one => this.agent(thread.session!, one.id, one.name ?? short(one.id))),
          ]
        : []
    ).sort((a, b) => Number(a.state === 'done') - Number(b.state === 'done'))
    return {
      id: `${thread.app}:${thread.id}`,
      app: thread.app,
      thread: thread.id,
      name: thread.name,
      where: where(thread),
      place: thread.app === 'telegram' && !thread.id.includes(':') ? where(thread) : (thread.title ?? thread.name),
      state,
      line: oneLine(line),
      ...(needs && { needs }),
      since,
      at,
      agents,
      steps,
      plan,
      lately: state === 'idle' ? [] : lately,
      track: track(timeline, Date.now() - TRACK),
      ...(thread.link && { link: thread.link }),
    }
  }

  private agent(session: string, id: string, label: string, doneAt?: number): Agent {
    const steps = this.steps(`${session} ${id}`)
    return { id, label, state: doneAt ? 'done' : 'working', ...(steps[0] && { line: steps[0].text }), steps }
  }

  private project(cwd = this.hexDir) {
    return join(this.claude, 'projects', cwd.replace(/[^a-zA-Z0-9]/g, '-'))
  }

  // A followed transcript's newest steps, newest first.
  private steps(key: string) {
    return [...(this.followers.get(key)?.steps ?? [])].reverse()
  }

  // A working thread's transcript, and those of its subagents, workflow agents and the sessions it
  // started from this stretch of work, give its steps.
  private follow(tasks: HexTask[]) {
    const wanted = new Map<string, (path: (found: string) => () => void) => () => void>()
    const threads = [...this.threads, ...this.loose()]
    for (const task of tasks) {
      if (task.state !== 'working') continue
      const thread = threads.find(thread => `${thread.app}:${thread.id}` === task.id)!
      const session = thread.session!
      const job = this.job(session).job
      const project = this.project(job?.cwd ?? thread.cwd)
      const subagents = join(project, session, 'subagents')
      wanted.set(session, follow => follow(join(project, `${session}.jsonl`)))
      for (const agent of task.agents) {
        const started = this.sessions.get(agent.id)
        wanted.set(`${session} ${agent.id}`, follow =>
          started
            ? follow(join(this.project(started.cwd), `${agent.id}.jsonl`))
            : job?.fan?.find(one => one.id === agent.id)?.kind === 'workflow'
              ? inRun(join(subagents, 'workflows'), `agent-${agent.id}.jsonl`, follow)
              : follow(join(subagents, `agent-${agent.id}.jsonl`)),
        )
      }
    }
    for (const [key, follower] of this.followers) {
      if (wanted.has(key)) continue
      follower.stop()
      this.followers.delete(key)
    }
    for (const [key, start] of wanted) {
      if (this.followers.has(key)) continue
      const follower: Follower = { stop: () => {}, steps: [], plan: [] }
      this.followers.set(key, follower)
      follower.stop = start(path =>
        followTranscript(path, Math.max(0, sizeOf(path) - TAIL), (entry, updates) => {
          for (const update of updates()) {
            if (update.sessionUpdate === 'plan') follower.plan = update.entries.map(entry => ({ text: oneLine(entry.content), state: PLANNED[entry.status] ?? 'pending' }))
            const did = stepOf(update)
            if (!did?.text || did.text === follower.steps.at(-1)?.text) continue
            follower.steps.push({ at: entry.timestamp ?? new Date().toISOString(), kind: did.kind, text: oneLine(did.text) })
            if (follower.steps.length > STEPS) follower.steps.shift()
          }
          this.schedule()
        }),
      )
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

// When the job's current state began: the oldest of the newest run of timeline entries in it.
function streak(timeline: Entry[], state?: string) {
  let since: string | undefined
  for (let i = timeline.length - 1; i >= 0 && timeline[i].state === state; i--) since = timeline[i].at
  return since
}

// How the job's state moved since `from`, for its lane: the state it was in then, and each change after.
function track(timeline: Entry[], from: number) {
  const turns: Turn[] = []
  for (const entry of timeline) {
    const state = STATES[entry.state] ?? 'idle'
    const at = Date.parse(entry.at) < from ? new Date(from).toISOString() : entry.at
    if (turns.at(-1)?.at === at) turns.pop()
    if (turns.at(-1)?.state !== state) turns.push({ at, state })
  }
  return turns
}

// A workflow agent's transcript lands in its run's own folder, so it's followed once it's written there.
function inRun(runs: string, name: string, follow: (path: string) => () => void) {
  let stop: (() => void) | undefined
  mkdirSync(runs, { recursive: true })
  const watcher = watch(runs, { recursive: true }, (_, file) => file?.endsWith(name) && find())
  find()
  return () => {
    watcher.close()
    stop?.()
  }

  function find() {
    const path = !stop && new Bun.Glob(`*/${name}`).scanSync({ cwd: runs, absolute: true }).next().value
    if (!path) return
    watcher.close()
    stop = follow(path)
  }
}

function busy(session?: Session) {
  return !!session && BUSY.has(session.status)
}

function processParents() {
  try {
    const out = Bun.spawnSync(['ps', '-A', '-o', 'pid=,ppid=']).stdout.toString()
    return new Map(out.trim().split('\n').map(line => line.trim().split(/\s+/).map(Number) as [number, number]))
  } catch {
    return new Map<number, number>()
  }
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
