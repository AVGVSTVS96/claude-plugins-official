import { createServer } from 'net'
import { execFile, spawn } from 'child_process'
import { createHash } from 'crypto'
import { closeSync, existsSync, fstatSync, openSync, readFileSync, readSync, writeFileSync, renameSync, rmSync, watch, type FSWatcher } from 'fs'
import { homedir } from 'os'
import { basename, join } from 'path'
import { endpoint, serve, type ChannelServer, type Line } from './mcp.ts'

export type { ChannelServer, Tool } from './mcp.ts'

export type Message = { content: string; meta: Record<string, string> }
export type Call = (thread: string, tool: string, args: Record<string, unknown>) => Promise<string>
// background: the session's turn ended with background agents still working.
export type State = (thread: string, busy: boolean, background: boolean) => void
export type Failed = (thread: string, reason: string) => void
export type Permission = { request_id: string; tool_name: string; description: string; input_preview: string }
export type Settings = { model?: string; effort?: string }
// What another process (the voice app, hex's check) can do with a question the client asked
// with buttons: answer it for the owner, settle it as no longer asked, or take an answer back.
export type Asks = {
  answer: (thread: string, message: number, label: string, via: string) => void
  settle: (thread: string, message: number, note: string) => void
  reopen: (thread: string, message: number, via: string) => void
}
type Thread = Settings & { name: string; session?: string; cwd?: string; launched?: string }
type Agent = { sessionId: string; id?: string; pid?: number; status?: string; name?: string; cwd?: string; startedAt?: number }
export type Hub = ReturnType<typeof startHub>

// Every client running in this process, so a thread can move between them.
// place() opens a thread on the client, led by its about line if given, and returns its id and a link to it.
export const clients = new Map<string, { hub: Hub; place: (name: string, where?: string, about?: string) => Promise<{ thread: string; link: string }> }>()

// Chat apps only link web addresses, so a buzz:// link goes through a page on hex's site that opens it.
export function tappable(text: string): string {
  return text.replace(/buzz:\/\/[^\s)>\]\\]*[^\s)>\]\\.,;:!?'"]/g, url => `https://hex-sand.vercel.app/open.html#${encodeURIComponent(url)}`)
}

// TRANSCRIBE_URL is any OpenAI-compatible /audio/transcriptions endpoint.
export async function transcribe(recording: () => Promise<string>): Promise<string | undefined> {
  const { TRANSCRIBE_URL: url, TRANSCRIBE_MODEL: model, TRANSCRIBE_API_KEY: key } = process.env
  if (!url || !model) return
  const path = await recording()
  const form = new FormData()
  form.append('file', Bun.file(path), basename(path))
  form.append('model', model)
  const res = await fetch(url, { method: 'POST', body: form, headers: key ? { authorization: `Bearer ${key}` } : {} })
  if (!res.ok) throw new Error(`transcription failed: HTTP ${res.status}`)
  return ((await res.json()) as { text?: string }).text?.trim() || undefined
}

const CLAUDE = process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), '.claude')
const JOBS = join(CLAUDE, 'jobs')
const IDLE_STOP = 30 * 60_000
// Claude Code retries a dropped HTTP server at about 0, 1, 3, 7 and 15 seconds, then gives up for
// good, and never restarts a stdio one (anthropics/claude-code#43177): a session still running
// without its channel after this long has lost it.
const RECONNECT = 20_000
const PORT = Number(process.env.HEX_PORT ?? 8789)
// Claude Code keeps a conversation in the prompt cache for an hour after its last request,
// and compacts a background session only when told to.
const CACHE_WARM = 54 * 60_000
const COMPACT_ABOVE = 150_000
const CAPACITY = 350_000
const PRIVATE = /_BOT_TOKEN$|^HEX_|^BUZZ_/

// A voice call passes through this process (its page and phone line go through the hub's
// door), so a restart waits for every thread on a call to hang up.
const onCall = new Set<string>()
const hungUp: (() => void)[] = []

export function free(): Promise<void> {
  return new Promise(resolve => (onCall.size ? hungUp.push(resolve) : resolve()))
}

function hangUp(call: string) {
  if (onCall.delete(call) && !onCall.size) for (const resolve of hungUp.splice(0)) resolve()
}

export function title(text: string): string {
  const title = text.trim()
  if (!/^[^\s_-]+$/.test(title)) throw new Error(`title must be one word, got "${title}"`)
  return title
}

export function startHub({ stateDir, channel, server, port = PORT, main, mainName = 'main', general = false, call, state, failed, permission, asks, args = () => [], bind = () => ({}), fresh = () => false, capacity = Number(process.env.HEX_CHAT_CAPACITY) || CAPACITY, idleStop = IDLE_STOP, cacheWarm = CACHE_WARM, compactAbove = COMPACT_ABOVE, reconnect = RECONNECT, listening, jobsDir = JOBS, hexDir = process.cwd(), projectsDir = join(CLAUDE, 'projects'), launcher = 'claude' }: {
  stateDir: string
  channel: string
  // What the channel serves its sessions over HTTP; a client without one serves them through its
  // plugin's own process, on hub.sock.
  server?: ChannelServer
  port?: number
  main?: string
  mainName?: string
  // The main thread is hex's General: its settings env says HEX_MAIN.
  general?: boolean
  call: Call
  state: State
  failed: Failed
  permission?: (thread: string, request: Permission) => void
  asks?: Asks
  args?: (thread: string) => string[]
  // More of the thread's binding for its session's settings env, like where its plugin serves.
  bind?: (thread: string) => Record<string, string>
  // A fresh thread's session is never compacted: its launcher builds what a new session knows
  // of the chat, and a new one takes over once the old one's context or cache is spent.
  fresh?: (thread: string) => boolean
  // How much context a fresh thread's session holds before a new one takes over; with 0, every
  // message that finds its session done goes to a new one.
  capacity?: number
  idleStop?: number
  // How long the main thread rests before it compacts, while its cache is still warm.
  cacheWarm?: number
  // A session whose context is bigger than this compacts before it rests.
  compactAbove?: number
  // How long a running session's channel may be gone before the session restarts to get it back.
  reconnect?: number
  listening?: number
  jobsDir?: string
  hexDir?: string
  projectsDir?: string
  launcher?: string
}) {
  const registry = join(stateDir, 'threads.json')
  const socketPath = join(stateDir, 'hub.sock')
  const threads: Record<string, Thread> = read()
  const live = new Map<string, Line>()
  const queued = new Map<string, Message[]>()
  const launching = new Map<string, FSWatcher | undefined>()
  const idle = new Map<string, ReturnType<typeof setTimeout>>()
  const busy = new Set<string>()
  const renewing = new Set<string>()
  const asked = new Set<string>()
  const renewed = new Set<string>()
  const waiting = new Set<string>()
  const held = new Map<string, (() => void)[]>()
  const retiring = new Set<string>()
  const compacting = new Set<string>()
  const leaving = new Map<string, (session: string) => void>()
  const unsaved = new Map<string, string>()
  const jobs = new Map<string, string>()
  const recovering = new Map<string, ReturnType<typeof setTimeout>>()
  const awaited = new Set<string>()
  const respawned = new Set<string>()
  const born = Date.now()
  const callOf = (thread: string) => `${socketPath}:${thread}`
  const plugin = channel.replace(/^plugin:/, '')
  const env = Object.fromEntries(Object.entries(process.env).filter(([name]) => !PRIVATE.test(name)))
  let closed = false

  function read(): Record<string, Thread> {
    let text: string
    try {
      text = readFileSync(registry, 'utf8')
    } catch {
      return {}
    }
    try {
      const entries = Object.entries(JSON.parse(text) ?? {})
      const kept = entries.filter(([, known]: [string, any]) => typeof known?.name === 'string')
      for (const [thread] of entries.filter(entry => !kept.includes(entry))) process.stderr.write(`hub: dropped malformed thread ${thread} from ${registry}\n`)
      return Object.fromEntries(kept)
    } catch (error) {
      const aside = `${registry}.corrupt-${Date.now()}`
      renameSync(registry, aside)
      process.stderr.write(`hub: ${registry} is unreadable (${error}), moved it to ${aside} and started with no threads\n`)
      return {}
    }
  }

  function save() {
    writeFileSync(`${registry}.tmp`, JSON.stringify(threads, null, 2) + '\n')
    renameSync(`${registry}.tmp`, registry)
  }

  function setState(thread: string, working: boolean, background = false) {
    state(thread, working, background)
    claim(thread)
    if (working) busy.add(thread)
    else busy.delete(thread)
    if (!working) background ? waiting.add(thread) : waiting.delete(thread)
    if (!working && !background && renewing.has(thread)) renew(thread, asked.has(thread))
    rest(thread, !working && !background)
    letGo(thread)
  }

  // A thread that asked to renew (a voice call ended), or whose session is older than this hub and so
  // may run older code (an update restarts the hub), starts over at its next rest: the main thread as
  // soon as its process exits, any other when its next message resumes it. A keep (a call started)
  // cancels it. When the session asked for it, a rest the Stop hook reported with no agents working is
  // taken as it is: Claude's own status lags the hook and counts a running shell as busy, so checking
  // it could put the renew off for good, and a session that asked is done with what its shells were
  // for.
  function renew(thread: string, rested = false) {
    const session = current(thread)
    if (!session) return
    agent(session, running => {
      if (!renewing.has(thread) || busy.has(thread) || onCall.has(callOf(thread)) || (!rested && running?.status === 'busy')) return
      renewing.delete(thread)
      asked.delete(thread)
      if (running && (thread === main || fresh(thread))) {
        renewed.add(thread)
        cycle(thread, running)
      } else stop(thread)
      letGo(thread)
    })
  }

  // A renew is on its way while the thread's session winds down its turn or restarts, but not
  // while it waits on background agents, which can take as long as they like.
  function pending(thread: string) {
    return renewed.has(thread) || (renewing.has(thread) && !waiting.has(thread))
  }

  // Resolves once the thread's renew is through (its new session said hello) or off, right
  // away when none is on its way, so a voice call can wait for the new session.
  function renewal(thread: string): Promise<void> {
    if (!pending(thread)) return Promise.resolve()
    return new Promise(resolve => held.set(thread, [...(held.get(thread) ?? []), resolve]))
  }

  function letGo(thread: string) {
    if (pending(thread)) return
    for (const resolve of held.get(thread) ?? []) resolve()
    held.delete(thread)
  }

  // A running session that isn't busy stops after a while; its next message resumes it.
  // The main thread keeps running, and compacts before its cache goes cold.
  function rest(thread: string, rested = false) {
    clearTimeout(idle.get(thread))
    idle.delete(thread)
    if (busy.has(thread) || !live.has(thread)) return
    if (thread === main) idle.set(thread, setTimeout(() => stopIfIdle(thread), cacheWarm))
    else if (retiring.has(thread)) stop(thread)
    else if (fresh(thread)) {
      const left = warmFor(thread)
      if (left === 0 && rested) handOff(thread, true)
      else if (left !== undefined) idle.set(thread, setTimeout(() => handOff(thread), left))
    } else idle.set(thread, setTimeout(() => stopIfIdle(thread), idleStop))
  }

  // A fresh thread keeps one session running, which takes its messages while its context has
  // room and its cache is warm. Once either is spent, a new session built from the chat takes
  // over at the old one's rest, so the next message finds it running: after the cache expires,
  // the old session would send its whole context uncached, and a new one costs no more.
  // warmFor is how long a session stays worth its messages, undefined before its first request.
  // Its cache lives an hour on a Claude subscription and five minutes by default on an API key;
  // the transcript records which.
  function warmFor(thread: string) {
    const session = current(thread)
    const { sent, at, short } = session ? last(thread, session) : { sent: 0 }
    if (!sent) return
    return sent >= capacity ? 0 : Math.max(0, (at ?? Date.now()) + (short ? cacheWarm / 12 : cacheWarm) - Date.now())
  }

  function spent(thread: string) {
    return fresh(thread) && warmFor(thread) === 0
  }

  // At a rest the Stop hook reported with no agents working, Claude's own status still says busy
  // for about a second, so a session that filled up on that turn hands over without asking it.
  function handOff(thread: string, rested = false) {
    idle.delete(thread)
    agent(current(thread) ?? '', running => {
      if (running && !busy.has(thread) && (rested || running.status === 'idle') && spent(thread)) cycle(thread, running)
    })
  }

  // The Stop hook ends a turn, but background tasks keep a session busy past it,
  // so Claude's own status decides; a busy session reports idle again when it's done.
  // A big conversation compacts first, while its cache is warm: resumed after the cache
  // expires, it would be written to the cache whole again.
  function stopIfIdle(thread: string) {
    idle.delete(thread)
    const session = current(thread)
    if (!session) return
    agent(session, running => {
      if (busy.has(thread) || running?.status === 'busy') return
      if (running && !retiring.has(thread) && !fresh(thread) && !onCall.has(callOf(thread)) && last(thread, session).sent > compactAbove) {
        compacting.add(thread)
        cycle(thread, running, '/compact')
      } else if (thread !== main) stop(thread)
    })
  }

  // The context a session's last request sent and when, from the newest usage or compaction in its transcript.
  function last(thread: string, session: string): { sent: number; at?: number; short?: boolean } {
    let file: number
    try {
      file = openSync(transcript(thread, session), 'r')
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

  function stop(thread: string) {
    idle.delete(thread)
    retiring.delete(thread)
    const session = current(thread)
    if (session) execFile('claude', ['stop', session.slice(0, 8)], () => {})
  }

  // Resolves with the thread's session once it has stopped and the thread is forgotten.
  function retire(thread: string): Promise<string> {
    if (thread === main) throw new Error('the main thread stays open')
    return new Promise(resolve => {
      leaving.set(thread, resolve)
      if (!live.has(thread)) return forget(thread)
      retiring.add(thread)
      stopIfIdle(thread)
    })
  }

  // Like retire, for a thread whose session another client resumes.
  function release(thread: string) {
    if (thread === main) throw new Error('the main thread stays here')
    if (!threads[thread]?.session) throw new Error('this thread has no session yet')
    return retire(thread)
  }

  function forget(thread: string) {
    const session = threads[thread]?.session ?? ''
    delete threads[thread]
    save()
    leaving.get(thread)!(session)
    leaving.delete(thread)
  }

  function adopt(thread: string, name: string, session: string, prompt: string, cwd?: string) {
    threads[thread] = { name, session, ...(cwd && { cwd }) }
    save()
    launch(thread, name, prompt)
  }

  function find(nameOrThread: string) {
    if (threads[nameOrThread]) return nameOrThread
    const wanted = nameOrThread.trim().toLowerCase()
    const matches = Object.keys(threads).filter(thread => threads[thread]!.name.toLowerCase() === wanted)
    if (matches.length !== 1) throw new Error(matches.length ? `more than one thread is named "${nameOrThread}"` : `no thread named "${nameOrThread}"`)
    return matches[0]!
  }

  function rename(thread: string, name: string) {
    const known = threads[thread]
    if (!known || known.name === name) return
    known.name = name
    save()
  }

  function register(thread: string, name: string, cwd?: string) {
    return (threads[thread] ??= { name, ...(cwd && { cwd }) })
  }

  function launch(thread: string, name: string, prompt?: string, fork?: string, cwd?: string) {
    const quiet = compacting.delete(thread)
    if (launching.has(thread)) return
    retiring.delete(thread)
    const known = register(thread, name, cwd)
    claim(thread)
    if ((prompt && !quiet) || queued.has(thread)) setState(thread, true)
    launching.set(thread, undefined)
    if (fork) return start(known, thread, prompt, fork)
    sessionOf(thread, running => {
      if (running && live.has(thread)) return settle(thread)
      if (running) {
        awaited.add(thread)
        return recover(thread)
      }
      const session = known.session
      if (!session || fresh(thread)) return start(known, thread, prompt)
      // `claude --bg --resume` copies the conversation to a new id while the old
      // session's job record exists, even once stopped; `claude rm` keeps the conversation.
      execFile('claude', ['rm', session.slice(0, 8)], () => start(known, thread, prompt))
    })
  }

  function agents(then: (running: Agent[]) => void) {
    execFile('claude', ['agents', '--json'], (_, stdout) => {
      let agents: Agent[] = []
      try {
        agents = JSON.parse(stdout)
      } catch {}
      then(agents.filter(agent => agent.pid))
    })
  }

  function agent(session: string, then: (running?: Agent) => void) {
    agents(running => then(running.find(agent => agent.sessionId === session)))
  }

  // The running session serving a thread: its current one, or one started for it whose
  // conversation isn't saved yet.
  function sessionOf(thread: string, then: (running?: Agent) => void) {
    agents(running => then(running.find(agent => agent.sessionId === current(thread)) ?? running.find(agent => boundTo(agent) === thread)))
  }

  // Claude Code's job record keeps the flags a session started with, since it respawns from them,
  // so its settings env names the thread it serves.
  function boundTo(agent: Agent) {
    try {
      const flags: string[] = JSON.parse(readFileSync(join(jobsDir, agent.id ?? agent.sessionId.slice(0, 8), 'state.json'), 'utf8')).respawnFlags
      const { env } = JSON.parse(flags[flags.lastIndexOf('--settings') + 1]!)
      return env.HEX_CHANNEL === channel ? env.HEX_THREAD : undefined
    } catch {
      return undefined
    }
  }

  function started(thread: string) {
    try {
      return JSON.parse(readFileSync(join(jobsDir, jobs.get(thread)!, 'state.json'), 'utf8')).sessionId as string | undefined
    } catch {
      return undefined
    }
  }

  // What a thread's session starts with besides the basics. A session reads it only as it
  // starts, so threads.json keeps a digest of what it started with to tell when it's stale.
  function extra(thread: string) {
    const { model, effort } = threads[thread]!
    return [...(model ? ['--model', model] : []), ...(effort ? ['--effort', effort] : []), ...args(thread)]
  }

  function digest(list: string[]) {
    return createHash('sha256').update(JSON.stringify(list)).digest('hex').slice(0, 16)
  }

  function stale(thread: string) {
    const list = extra(thread)
    return threads[thread]?.launched !== (list.length ? digest(list) : undefined)
  }

  function configure(thread: string, settings: Settings) {
    const known = threads[thread]!
    for (const [key, value] of Object.entries(settings) as [keyof Settings, string | undefined][]) {
      if (value) known[key] = value
      else delete known[key]
    }
    save()
  }

  function start(known: Thread, thread: string, prompt?: string, fork?: string) {
    const bound = { ...bind(thread), HEX_CHANNEL: channel, HEX_THREAD: thread, HEX_HUB: socketPath, ...(http && { HEX_PORT: String(http.port) }), ...(general && thread === main ? { HEX_MAIN: '1' } : {}), ...(fresh(thread) ? { HEX_FRESH: '1' } : {}) }
    const launchArgs = extra(thread)
    const launched = launchArgs.length ? digest(launchArgs) : undefined
    if (known.launched !== launched) {
      known.launched = launched
      save()
    }
    let child
    try {
      child = spawn(launcher, [
        '--bg',
        '--channels', channel,
        '--name', known.name,
        ...(fork ? ['--resume', fork, '--fork-session'] : known.session && !fresh(thread) ? ['--resume', known.session] : []),
        ...launchArgs,
        '--settings', JSON.stringify({ enabledPlugins: { [plugin]: true }, env: bound }),
        ...(prompt ? [prompt] : []),
      ], { cwd: known.cwd ?? hexDir, env, stdio: ['ignore', 'pipe', 'pipe'] })
    } catch (error) {
      return fail(thread, String(error))
    }
    let output = ''
    child.stdout.on('data', chunk => (output += chunk))
    child.stderr.on('data', chunk => (output += chunk))
    child.on('error', error => fail(thread, error.message))
    child.on('close', code => {
      const job = output.match(/backgrounded · (\w+)/)?.[1]
      if (job) watchJob(thread, job)
      else fail(thread, output.trim() || `claude --bg exited with code ${code}`)
    })
  }

  function watchJob(thread: string, job: string) {
    if (!launching.has(thread)) return
    jobs.set(thread, job)
    recover(thread)
    const dir = join(jobsDir, job)
    const check = () => {
      try {
        const { state: status, detail } = JSON.parse(readFileSync(join(dir, 'state.json'), 'utf8'))
        if (status === 'failed') fail(thread, detail || 'the session failed to start')
      } catch {}
    }
    try {
      launching.set(thread, watch(dir, check))
      check()
    } catch {
      process.stderr.write(`hub: no job record at ${dir}, so a failed start of ${thread} can't be seen\n`)
    }
  }

  function settle(thread: string) {
    launching.get(thread)?.close()
    launching.delete(thread)
  }

  function fail(thread: string, reason: string) {
    if (!launching.has(thread) || live.has(thread)) return
    settle(thread)
    jobs.delete(thread)
    awaited.delete(thread)
    renewed.delete(thread)
    failed(thread, reason)
    setState(thread, false)
  }

  function deliver(thread: string, name: string, message: Message) {
    const line = live.get(thread)
    if (line && !stale(thread) && !spent(thread)) return line.send({ type: 'inbound', ...message })
    if (line) return refresh(thread, message)
    queued.set(thread, [...(queued.get(thread) ?? []), message])
    launch(thread, name)
  }

  // Claude Code runs a slash command like /compact only as a session's first prompt,
  // and reads its launch arguments only at start, so a running session stops and
  // resumes for either. `claude stop` returns before the process exits, and resuming
  // before then starts a copy, so it waits for the exit.
  function restart(thread: string, prompt?: string) {
    const session = current(thread)
    if (!session) return launch(thread, threads[thread]!.name, prompt)
    agent(session, running => cycle(thread, running, prompt))
  }

  // Delivers a message to a fresh start of the thread's session, so it gets new launch
  // arguments or, in a fresh thread, a new session; a session still working, on its turn
  // or on background agents, keeps running and takes it as it is, unless earlier messages
  // already wait for the new start.
  // A session that took over while Claude was asked gets the message as any message would.
  function refresh(thread: string, message: Message) {
    const line = live.get(thread)
    agent(current(thread) ?? '', running => {
      if (live.get(thread) !== line) return deliver(thread, threads[thread]!.name, message)
      const working = fresh(thread) ? busy.has(thread) || (running && running.status !== 'idle') : running?.status === 'busy'
      if (line && working && !queued.has(thread)) return line.send({ type: 'inbound', ...message })
      queued.set(thread, [...(queued.get(thread) ?? []), message])
      cycle(thread, running)
    })
  }

  function cycle(thread: string, running?: Agent, prompt?: string) {
    const name = threads[thread]!.name
    if (!running) return launch(thread, name, prompt)
    stop(thread)
    exited(running.pid!, () => launch(thread, name, prompt))
  }

  // Node can't wait on a process it didn't start, and pidwait isn't on every system
  // (macOS has none), so the process is checked until it's gone.
  function exited(pid: number, then: () => void) {
    try {
      process.kill(pid, 0)
      setTimeout(exited, 100, pid, then)
    } catch {
      then()
    }
  }

  // A session's channel connected: over HTTP (its session is the one the hub started, or the one
  // Claude reports running for the thread), or through its plugin's hello, which names it.
  function welcome(thread: string, line: Line, session = started(thread)) {
    live.set(thread, line)
    renewing.delete(thread)
    asked.delete(thread)
    renewed.delete(thread)
    awaited.delete(thread)
    respawned.delete(thread)
    jobs.delete(thread)
    settle(thread)
    threads[thread] ??= { name: thread }
    if (session) note(thread, session)
    for (const message of queued.get(thread) ?? []) line.send({ type: 'inbound', ...message })
    queued.delete(thread)
    rest(thread)
    sessionOf(thread, running => {
      if (live.get(thread) !== line || !running) return
      note(thread, running.sessionId)
      if (!running.startedAt || running.startedAt >= born) return
      renewing.add(thread)
      renew(thread)
    })
    letGo(thread)
  }

  function note(thread: string, session: string) {
    if (threads[thread]?.session !== session) unsaved.set(thread, session)
    else unsaved.delete(thread)
    claim(thread)
  }

  function drop(thread: string, line: Line) {
    if (live.get(thread) !== line) return
    live.delete(thread)
    hangUp(callOf(thread))
    setState(thread, false)
    if (leaving.has(thread)) forget(thread)
    recover(thread)
  }

  // A session whose channel is gone comes back on its own while Claude Code reconnects it. After
  // that, one still running restarts in place (a turn it was on runs again), a gone main thread
  // starts again, and a thread whose messages waited on a session that has since ended resumes.
  function recover(thread: string, since = Date.now()) {
    if (recovering.has(thread) || closed) return
    recovering.set(thread, setTimeout(() => {
      recovering.delete(thread)
      if (live.has(thread) || closed) return
      sessionOf(thread, running => {
        if (live.has(thread)) return
        if (running) return (running.startedAt ?? 0) < since ? respawn(thread, running) : recover(thread)
        if (thread === main) return revive()
        if (!awaited.delete(thread)) return
        settle(thread)
        launch(thread, threads[thread]!.name)
      })
    }, reconnect))
  }

  function respawn(thread: string, running: Agent) {
    const id = running.id ?? running.sessionId.slice(0, 8)
    if (respawned.delete(thread)) {
      process.stderr.write(`hub: ${thread}'s session ${id} restarted and still has no channel\n`)
      return fail(thread, 'its session runs, but its channel never connects')
    }
    respawned.add(thread)
    process.stderr.write(`hub: ${thread}'s session ${id} runs without its channel, so it restarts in place\n`)
    if (!launching.has(thread)) launching.set(thread, undefined)
    execFile('claude', ['respawn', id], () => recover(thread))
  }

  // A session that dies before Claude saves its conversation can't be resumed, so the
  // thread keeps its last saved session until the new one has a conversation on disk.
  function claim(thread: string) {
    const session = unsaved.get(thread)
    const known = threads[thread]
    if (!session || !known || !existsSync(transcript(thread, session))) return
    unsaved.delete(thread)
    known.session = session
    save()
  }

  function transcript(thread: string, session: string) {
    return join(projectsDir, (threads[thread]?.cwd ?? hexDir).replace(/[^a-zA-Z0-9]/g, '-'), `${session}.jsonl`)
  }

  function current(thread: string) {
    return unsaved.get(thread) ?? threads[thread]?.session
  }

  rmSync(socketPath, { force: true })
  const http = server && serve(port, `/${plugin.split('@')[0]}`, endpoint(plugin.split('@')[0]!, channel, server, {
    call,
    permission: (thread, request) => permission?.(thread, request),
    open: (thread, line) => welcome(thread, line),
    close: drop,
  }, listening))

  const sock = createServer(socket => {
    let thread = ''
    let buffer = ''
    const reply = (payload: object) => socket.write(JSON.stringify(payload) + '\n')
    const line: Line = { send: reply }
    socket.setEncoding('utf8')
    socket.on('data', (chunk: string) => {
      buffer += chunk
      for (let end = buffer.indexOf('\n'); end >= 0; end = buffer.indexOf('\n')) {
        const line = buffer.slice(0, end)
        buffer = buffer.slice(end + 1)
        try {
          handle(JSON.parse(line))
        } catch (error) {
          process.stderr.write(`hub: dropped a bad line from ${thread || 'a session'}: ${error}\n`)
        }
      }
    })
    function handle(request: any) {
      if (request.type === 'hello') welcome((thread = request.thread), line, request.session)
      if (request.type === 'state') setState(request.thread, request.busy, request.background === true)
      if (request.type === 'renew') {
        renewing.add(request.thread)
        asked.add(request.thread)
        hangUp(callOf(request.thread))
      }
      if (request.type === 'keep') {
        renewing.delete(request.thread)
        asked.delete(request.thread)
        onCall.add(callOf(request.thread))
        letGo(request.thread)
      }
      if (request.type === 'open') launch(request.thread, request.name, request.prompt)
      if (request.type === 'permission_request') permission?.(thread, request)
      if (request.type === 'answer') asks?.answer(request.thread, request.message, request.label, request.via)
      if (request.type === 'settle') asks?.settle(request.thread, request.message, request.note)
      if (request.type === 'reopen') asks?.reopen(request.thread, request.message, request.via)
      if (request.type === 'inbound') deliver(request.thread, threads[request.thread]?.name ?? request.thread, { content: request.content, meta: request.meta })
      if (request.type === 'call') {
        call(thread, request.tool, request.args ?? {}).then(
          text => reply({ type: 'result', id: request.id, text }),
          error => reply({ type: 'result', id: request.id, error: error instanceof Error ? error.message : String(error) }),
        )
      }
    }
    socket.on('close', () => drop(thread, line))
    socket.on('error', () => {})
  }).listen(socketPath)

  // The main thread is always running: started with the hub, and started again when its session
  // is gone.
  function revive() {
    if (!main || closed || live.has(main)) return
    rename(main, mainName)
    launch(main, mainName)
  }
  // Sessions that outlived the hub (a hub restart) reconnect, or recover. A fresh main thread's
  // launch never resumes, so one still running waits for its session instead of starting another.
  if (main || Object.keys(threads).length) agents(running => {
    const serving = new Set(Object.keys(threads).filter(thread => running.some(agent => agent.sessionId === current(thread) || boundTo(agent) === thread)))
    for (const thread of serving) recover(thread, born)
    if (main && !(fresh(main) && serving.has(main))) revive()
  })

  return {
    deliver,
    command: restart,
    configure,
    settings: (thread: string): Settings => ({ model: threads[thread]?.model, effort: threads[thread]?.effort }),
    register: (thread: string, name: string, cwd?: string) => void register(thread, name, cwd),
    open: (thread: string, name: string, prompt?: string, cwd?: string) => launch(thread, name, prompt, undefined, cwd),
    fork: (thread: string, name: string, session: string, prompt: string, cwd?: string) => launch(thread, name, prompt, session, cwd),
    main,
    port: http?.port,
    renewal,
    session: current,
    threads: () => Object.keys(threads),
    name: (thread: string) => threads[thread]?.name,
    cwd: (thread: string) => threads[thread]?.cwd,
    stop,
    answer: (thread: string, request_id: string, behavior: 'allow' | 'deny') => {
      live.get(thread)?.send({ type: 'permission', request_id, behavior })
    },
    release,
    adopt,
    retire,
    find,
    rename,
    close: () => {
      closed = true
      sock.close()
      http?.close()
      for (const timer of recovering.values()) clearTimeout(timer)
    },
  }
}

// Moves a thread to another client: its session stops here and resumes there,
// memory intact. The main thread never leaves, so a copy of it continues instead.
export async function move(from: Hub, thread: string, to: string, name: string, where?: string) {
  const target = clients.get(to)
  if (!target) throw new Error(`${to} isn't connected`)
  const session = from.session(thread)
  if (!session) throw new Error('this thread has no session yet')
  const { thread: dest, link } = await target.place(name, where)
  const prompt = `This conversation just moved to ${to}, into the thread "${name}". Your ${to} tools now post there. Carry on where you left off.`
  const cwd = from.cwd(thread)
  if (thread === from.main) target.hub.fork(dest, name, session, prompt, cwd)
  else void from.release(thread).then(session => target.hub.adopt(dest, name, session, prompt, cwd))
  return link
}
