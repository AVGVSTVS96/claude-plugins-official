import { createServer } from 'net'
import { createHash, randomBytes } from 'crypto'
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync, type FSWatcher } from 'fs'
import { basename, join } from 'path'
import * as claude from './claude.ts'
import { endpoint, type ChannelServer, type Line } from './mcp.ts'

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
export type Hub = ReturnType<typeof startHub>

// idleStop: how long a quiet session stays warm before it stops. cacheWarm: how long the main
// thread rests before it compacts, while its cache is still warm. compactAbove: the context above
// which a session compacts before it rests. reconnect: how long a running session's channel may be
// gone before the session restarts to get it back. capacity: how much context a fresh thread's
// session holds before a new one takes over; with 0, every message that finds it done goes to a new one.
export type Limits = { idleStop: number; cacheWarm: number; compactAbove: number; reconnect: number; capacity: number }

type Saved = Settings & { name: string; session?: string; cwd?: string; launched?: string }
type Timer = ReturnType<typeof setTimeout>

// Where a thread's session stands. launching: the hub started or restarted it and waits for its
// channel, so one that ends first failed to start. recovering: it runs without its channel, which
// Claude Code may still bring back. Either wait ends at its deadline.
type Phase =
  | { is: 'stopped' }
  | { is: 'launching'; job?: string; watch?: FSWatcher; deadline?: Timer; respawned?: boolean }
  | { is: 'recovering'; deadline?: Timer }
  | { is: 'live'; line: Line }

// Everything the hub keeps on a thread while it runs; threads.json keeps what outlives the hub.
type Run = {
  phase: Phase
  queue: Message[]
  // From the session's hooks; background: its turn ended with agents still working.
  turn: 'busy' | 'background' | 'done'
  // asked: the session asked to start over (a call ended). stale: it started with what the hub no
  // longer gives a session. underway: it's starting over, and its renewal waits for the new session.
  renew?: 'asked' | 'stale' | 'underway'
  rest?: Timer
  leaving?: (session: string) => void
  // A new session whose conversation Claude hasn't saved yet.
  unsaved?: string
  held: (() => void)[]
}

// Every client running in this process, so a thread can move between them.
// place() opens a thread on the client, led by its about line if given, and returns its id and a link to it.
export const clients = new Map<string, { hub: Hub; place: (name: string, where?: string, about?: string) => Promise<{ thread: string; link: string }> }>()

export const PORT = Number(process.env.HEX_PORT ?? 8789)

// Each hub's channel under its plugin's name, behind the one HTTP listener serve.ts opens.
const channels = new Map<string, (request: Request) => Promise<Response>>()

export function route(request: Request): Promise<Response> {
  return channels.get(new URL(request.url).pathname)?.(request) ?? Promise.resolve(new Response('Not Found', { status: 404 }))
}

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

// Claude Code keeps a conversation in the prompt cache for an hour after its last request, and
// compacts a background session only when told to. It retries a dropped HTTP server at about 0, 1,
// 3, 7 and 15 seconds, then gives up for good, and never restarts a stdio one
// (anthropics/claude-code#43177).
const LIMITS: Limits = { idleStop: 30 * 60_000, cacheWarm: 54 * 60_000, compactAbove: 150_000, reconnect: 20_000, capacity: capacity(process.env.HEX_CHAT_CAPACITY) }
const PRIVATE = /_BOT_TOKEN$|^HEX_|^BUZZ_/

function capacity(tokens?: string) {
  if (!tokens) return 350_000
  if (!/^\d+$/.test(tokens)) throw new Error(`HEX_CHAT_CAPACITY must be a number of tokens, got "${tokens}"`)
  return Number(tokens)
}

// What a session reads only as it starts: its launch arguments and its channel's instructions and
// tools. threads.json keeps a digest of what each thread's session started with.
export function stamp(args: string[], server?: ChannelServer) {
  return createHash('sha256').update(JSON.stringify([args, server ?? null])).digest('hex').slice(0, 16)
}

// A voice call passes through this process (its page and phone line go through the hub's
// door), so a restart waits for every thread on a call to hang up.
const onCall = new Set<Run>()
const hungUp: (() => void)[] = []

export function free(): Promise<void> {
  return new Promise(resolve => (onCall.size ? hungUp.push(resolve) : resolve()))
}

function hangUp(run: Run) {
  if (onCall.delete(run) && !onCall.size) for (const resolve of hungUp.splice(0)) resolve()
}

export function title(text: string): string {
  const title = text.trim()
  if (!/^[^\s_-]+$/.test(title)) throw new Error(`title must be one word, got "${title}"`)
  return title
}

// A hub's sessions show it this in a header, since any local user can reach its port.
function tokenOf(stateDir: string) {
  const file = join(stateDir, 'token')
  if (!existsSync(file)) writeFileSync(file, randomBytes(32).toString('hex'), { mode: 0o600 })
  return readFileSync(file, 'utf8').trim()
}

export function startHub({ stateDir, channel, server, port = PORT, main, mainName = 'main', general = false, call, state, failed, permission, asks, args = () => [], bind = () => ({}), fresh = () => false, limits, hexDir = process.cwd(), launcher = 'claude' }: {
  stateDir: string
  channel: string
  // What the channel serves its sessions over HTTP; a client without one serves them through its
  // plugin's own process, on hub.sock.
  server?: ChannelServer
  // Where serve.ts listens for every hub's sessions.
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
  limits?: Partial<Limits>
  hexDir?: string
  launcher?: string
}) {
  const { idleStop, cacheWarm, compactAbove, reconnect, capacity } = { ...LIMITS, ...limits }
  const registry = join(stateDir, 'threads.json')
  const socketPath = join(stateDir, 'hub.sock')
  // Each thread's session reads its settings, binding and token from here, so none of it shows in
  // a process's arguments, and a respawn reads the thread's current ones.
  const sessionsDir = join(stateDir, 'sessions')
  const threads: Record<string, Saved> = read()
  const runs = new Map<string, Run>()
  const plugin = channel.replace(/^plugin:/, '')
  const path = `/${plugin.split('@')[0]}`
  const token = server && tokenOf(stateDir)
  const inherited = Object.fromEntries(Object.entries(process.env).filter(([name]) => !PRIVATE.test(name)))
  let closed = false
  mkdirSync(sessionsDir, { recursive: true, mode: 0o700 })

  function read(): Record<string, Saved> {
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
      return Object.fromEntries(kept) as Record<string, Saved>
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

  function runOf(thread: string): Run {
    let run = runs.get(thread)
    if (!run) runs.set(thread, (run = { phase: { is: 'stopped' }, queue: [], turn: 'done', held: [] }))
    return run
  }

  function become(run: Run, phase: Phase) {
    const was = run.phase
    if (was.is === 'launching') was.watch?.close()
    if (was.is === 'launching' || was.is === 'recovering') clearTimeout(was.deadline)
    run.phase = phase
  }

  function underway(run: Run) {
    return run.phase.is === 'launching' || run.phase.is === 'live'
  }

  function setState(thread: string, working: boolean, background = false) {
    const run = runOf(thread)
    state(thread, working, background)
    claim(thread)
    run.turn = working ? 'busy' : background ? 'background' : 'done'
    if (run.turn === 'done' && (run.renew === 'asked' || run.renew === 'stale')) void renew(thread, run.renew === 'asked')
    rest(thread, run.turn === 'done')
    letGo(thread)
  }

  // A thread renews at its next rest: the main thread and a fresh thread start over as soon as
  // the process exits, any other when its next message resumes it. A keep (a call started) cancels
  // it. When the session asked for it, a rest the Stop hook reported with no agents working is
  // taken as it is: Claude's own status lags the hook and counts a running shell as busy, so
  // checking it could put the renew off for good, and a session that asked is done with what its
  // shells were for.
  async function renew(thread: string, rested = false) {
    const run = runOf(thread)
    const session = current(thread)
    if (!session) return
    const running = await claude.agent(session)
    if (!(run.renew === 'asked' || run.renew === 'stale') || run.turn === 'busy' || onCall.has(run) || (!rested && running?.status === 'busy')) return
    run.renew = running && (thread === main || fresh(thread)) ? 'underway' : undefined
    if (run.renew) void cycle(thread, running)
    else stop(thread)
    letGo(thread)
  }

  // A renew is on its way while the thread's session winds down its turn or restarts, but not
  // while it waits on background agents, which can take as long as they like.
  function pending(run: Run) {
    return run.renew === 'underway' || (!!run.renew && run.turn !== 'background')
  }

  // Resolves once the thread's renew is through (its new session connected) or off, right
  // away when none is on its way, so a voice call can wait for the new session.
  function renewal(thread: string): Promise<void> {
    const run = runOf(thread)
    if (!pending(run)) return Promise.resolve()
    return new Promise(resolve => run.held.push(resolve))
  }

  function letGo(thread: string) {
    const run = runOf(thread)
    if (pending(run)) return
    for (const resolve of run.held.splice(0)) resolve()
  }

  // A running session that isn't busy stops after a while; its next message resumes it.
  // The main thread keeps running, and compacts before its cache goes cold.
  function rest(thread: string, rested = false) {
    const run = runOf(thread)
    clearTimeout(run.rest)
    run.rest = undefined
    if (run.turn === 'busy' || run.phase.is !== 'live') return
    if (thread === main) run.rest = setTimeout(stopIfIdle, cacheWarm, thread)
    else if (run.leaving) stop(thread)
    else if (fresh(thread)) {
      const left = warmFor(thread)
      if (left === 0 && rested) void handOff(thread, true)
      else if (left !== undefined) run.rest = setTimeout(handOff, left, thread)
    } else run.rest = setTimeout(stopIfIdle, idleStop, thread)
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
    const { sent, at, short } = session ? claude.usage(cwdOf(thread), session) : { sent: 0 }
    if (!sent) return
    return sent >= capacity ? 0 : Math.max(0, (at ?? Date.now()) + (short ? cacheWarm / 12 : cacheWarm) - Date.now())
  }

  function spent(thread: string) {
    return fresh(thread) && warmFor(thread) === 0
  }

  // At a rest the Stop hook reported with no agents working, Claude's own status still says busy
  // for about a second, so a session that filled up on that turn hands over without asking it.
  async function handOff(thread: string, rested = false) {
    const run = runOf(thread)
    run.rest = undefined
    const running = await claude.agent(current(thread) ?? '')
    if (running && run.turn !== 'busy' && (rested || running.status === 'idle') && spent(thread)) void cycle(thread, running)
  }

  // The Stop hook ends a turn, but background tasks keep a session busy past it,
  // so Claude's own status decides; a busy session reports idle again when it's done.
  // A big conversation compacts first, while its cache is warm: resumed after the cache
  // expires, it would be written to the cache whole again.
  async function stopIfIdle(thread: string) {
    const run = runOf(thread)
    run.rest = undefined
    const session = current(thread)
    if (!session) return
    const running = await claude.agent(session)
    if (run.turn === 'busy' || running?.status === 'busy') return
    if (running && !run.leaving && !fresh(thread) && !onCall.has(run) && claude.usage(cwdOf(thread), session).sent > compactAbove) void cycle(thread, running, '/compact', true)
    else if (thread !== main) stop(thread)
  }

  function stop(thread: string) {
    const run = runOf(thread)
    clearTimeout(run.rest)
    run.rest = undefined
    const session = current(thread)
    if (session) void claude.stop(session)
  }

  // Resolves with the thread's session once it has stopped and the thread is forgotten.
  function retire(thread: string): Promise<string> {
    if (thread === main) throw new Error('the main thread stays open')
    return new Promise(resolve => {
      const run = runOf(thread)
      run.leaving = resolve
      if (run.phase.is !== 'live') return forget(thread)
      void stopIfIdle(thread)
    })
  }

  // Like retire, for a thread whose session another client resumes.
  function release(thread: string) {
    if (thread === main) throw new Error('the main thread stays here')
    if (!threads[thread]?.session) throw new Error('this thread has no session yet')
    return retire(thread)
  }

  function forget(thread: string) {
    const run = runOf(thread)
    const session = threads[thread]?.session ?? ''
    delete threads[thread]
    save()
    become(run, { is: 'stopped' })
    clearTimeout(run.rest)
    runs.delete(thread)
    rmSync(settingsOf(thread), { force: true })
    run.leaving!(session)
  }

  function adopt(thread: string, name: string, session: string, prompt: string, cwd?: string) {
    threads[thread] = { name, session, ...(cwd && { cwd }) }
    save()
    void launch(thread, name, { prompt })
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

  // quiet: the prompt is the hub's own (a compaction), so the thread doesn't show as working.
  async function launch(thread: string, name: string, { prompt, fork, cwd, quiet = false }: { prompt?: string; fork?: string; cwd?: string; quiet?: boolean } = {}) {
    const run = runOf(thread)
    if (closed || underway(run)) return
    const known = register(thread, name, cwd)
    claim(thread)
    if ((prompt && !quiet) || run.queue.length) setState(thread, true)
    const phase: Phase = { is: 'launching' }
    become(run, phase)
    if (fork) return start(thread, prompt, fork)
    const running = await sessionOf(thread)
    if (run.phase !== phase) return
    if (running) {
      become(run, { is: 'recovering' })
      return recover(thread)
    }
    if (known.session && !fresh(thread)) await claude.rm(known.session)
    if (run.phase === phase) await start(thread, prompt)
  }

  // The running session serving a thread: its current one, or one started for it whose
  // conversation isn't saved yet.
  async function sessionOf(thread: string) {
    const running = await claude.agents()
    return running.find(agent => agent.sessionId === current(thread)) ?? running.find(agent => boundTo(agent) === thread)
  }

  function boundTo(agent: claude.Agent) {
    const env = claude.envOf(agent)
    return env?.HEX_CHANNEL === channel ? env.HEX_THREAD : undefined
  }

  function extra(thread: string) {
    const { model, effort } = threads[thread]!
    return [...(model ? ['--model', model] : []), ...(effort ? ['--effort', effort] : []), ...args(thread)]
  }

  // A session that started with other arguments or another channel starts over: with its next
  // message for a changed model or effort, and at its next rest after an update, so a crash or a
  // plain restart of the hub leaves every session running. A thread with no record started its
  // session with none of its own arguments, before the hub kept one.
  function stale(thread: string) {
    return (threads[thread]?.launched ?? stamp([], server)) !== stamp(extra(thread), server)
  }

  function configure(thread: string, settings: Settings) {
    const known = threads[thread]!
    for (const [key, value] of Object.entries(settings) as [keyof Settings, string | undefined][]) {
      if (value) known[key] = value
      else delete known[key]
    }
    save()
  }

  function settingsOf(thread: string) {
    return join(sessionsDir, `${encodeURIComponent(thread)}.json`)
  }

  async function start(thread: string, prompt?: string, fork?: string) {
    const known = threads[thread]!
    const env = {
      ...bind(thread),
      HEX_CHANNEL: channel,
      HEX_THREAD: thread,
      HEX_HUB: socketPath,
      ...(token ? { HEX_PORT: String(port), HEX_TOKEN: token } : {}),
      ...(general && thread === main ? { HEX_MAIN: '1' } : {}),
      ...(fresh(thread) ? { HEX_FRESH: '1' } : {}),
    }
    writeFileSync(settingsOf(thread), JSON.stringify({ enabledPlugins: { [plugin]: true }, env }), { mode: 0o600 })
    const launchArgs = extra(thread)
    const launched = stamp(launchArgs, server)
    if (known.launched !== launched) {
      known.launched = launched
      save()
    }
    const resume = fork ? ['--resume', fork, '--fork-session'] : known.session && !fresh(thread) ? ['--resume', known.session] : []
    try {
      watchJob(thread, await claude.start(launcher, ['--channels', channel, '--name', known.name, ...resume, ...launchArgs, '--settings', settingsOf(thread), ...(prompt ? [prompt] : [])], { cwd: known.cwd ?? hexDir, env: inherited }))
    } catch (error) {
      fail(thread, error instanceof Error ? error.message : String(error))
    }
  }

  function watchJob(thread: string, job: string) {
    const phase = runOf(thread).phase
    if (phase.is !== 'launching') return
    phase.job = job
    recover(thread)
    const check = () => {
      const { state: status, detail } = claude.record(job)
      if (status === 'failed') fail(thread, detail || 'the session failed to start')
    }
    try {
      phase.watch = claude.watchJob(job, check)
      check()
    } catch {
      process.stderr.write(`hub: no job record for ${job}, so a failed start of ${thread} can't be seen\n`)
    }
  }

  function fail(thread: string, reason: string) {
    const run = runOf(thread)
    if (run.phase.is !== 'launching') return
    become(run, { is: 'stopped' })
    if (run.renew === 'underway') run.renew = undefined
    failed(thread, reason)
    setState(thread, false)
  }

  function deliver(thread: string, name: string, message: Message) {
    const run = runOf(thread)
    if (run.phase.is === 'live') return stale(thread) || spent(thread) ? void refresh(thread, message) : run.phase.line.send({ type: 'inbound', ...message })
    run.queue.push(message)
    void launch(thread, name)
  }

  // Claude Code runs a slash command like /compact only as a session's first prompt,
  // and reads its launch arguments only at start, so a running session stops and
  // resumes for either.
  async function restart(thread: string, prompt?: string) {
    const session = current(thread)
    if (!session) return launch(thread, threads[thread]!.name, { prompt })
    void cycle(thread, await claude.agent(session), prompt)
  }

  // Delivers a message to a fresh start of the thread's session, so it gets new launch
  // arguments or, in a fresh thread, a new session; a session still working, on its turn
  // or on background agents, keeps running and takes it as it is, unless earlier messages
  // already wait for the new start.
  // A session that took over while Claude was asked gets the message as any message would.
  async function refresh(thread: string, message: Message) {
    const run = runOf(thread)
    const phase = run.phase
    const running = await claude.agent(current(thread) ?? '')
    if (run.phase !== phase || phase.is !== 'live') return deliver(thread, threads[thread]!.name, message)
    const working = fresh(thread) ? run.turn === 'busy' || (running && running.status !== 'idle') : running?.status === 'busy'
    if (working && !run.queue.length) return phase.line.send({ type: 'inbound', ...message })
    run.queue.push(message)
    void cycle(thread, running)
  }

  // `claude stop` returns before the process exits, and resuming before then starts a copy, so it
  // waits for the exit. The stopped session's stream can close after that, so it isn't waited for.
  async function cycle(thread: string, running?: claude.Agent, prompt?: string, quiet = false) {
    const run = runOf(thread)
    if (running) {
      stop(thread)
      await claude.exited(running.pid)
    }
    if (run.phase.is === 'live' || run.phase.is === 'recovering') {
      hangUp(run)
      become(run, { is: 'stopped' })
    }
    void launch(thread, threads[thread]!.name, { prompt, quiet })
  }

  // A session's channel connected: over HTTP (its session is the one the hub started, or the one
  // Claude reports running for the thread), or through its plugin's hello, which names it.
  function welcome(thread: string, line: Line, session?: string) {
    const run = runOf(thread)
    const job = run.phase.is === 'launching' ? run.phase.job : undefined
    become(run, { is: 'live', line })
    run.renew = undefined
    threads[thread] ??= { name: thread }
    const id = session ?? (job && claude.record(job).sessionId)
    if (id) note(thread, id)
    for (const message of run.queue.splice(0)) line.send({ type: 'inbound', ...message })
    rest(thread)
    letGo(thread)
    if (stale(thread)) {
      run.renew = 'stale'
      void renew(thread)
    }
    void sessionOf(thread).then(running => {
      if (running && run.phase.is === 'live' && run.phase.line === line) note(thread, running.sessionId)
    })
  }

  function note(thread: string, session: string) {
    runOf(thread).unsaved = threads[thread]?.session !== session ? session : undefined
    claim(thread)
  }

  function drop(thread: string, line: Line) {
    const run = runs.get(thread)
    if (run?.phase.is !== 'live' || run.phase.line !== line) return
    become(run, { is: 'recovering' })
    hangUp(run)
    setState(thread, false)
    if (run.leaving) return forget(thread)
    recover(thread)
  }

  // A session without its channel gets Claude Code's reconnect window to come back. After that, one
  // still running restarts in place (a turn it was on runs again) if it started before the wait
  // did, or else gets another window; a start that ended is reported, a gone main thread starts
  // again, and a thread whose messages waited on a session that has since ended resumes.
  function recover(thread: string, since = Date.now()) {
    const run = runOf(thread)
    const phase = run.phase
    if (closed || phase.is === 'stopped' || phase.is === 'live' || phase.deadline) return
    phase.deadline = setTimeout(async () => {
      phase.deadline = undefined
      const running = await sessionOf(thread)
      if (run.phase !== phase) return
      if (!running) return gone(thread)
      if ((running.startedAt ?? 0) >= since) return recover(thread)
      // A respawn starts from the flags the session started with, which read the thread's current
      // settings file only for a session the hub started that way.
      if (claude.envOf(running)) return respawn(thread, running)
      void cycle(thread, running)
    }, reconnect)
  }

  function gone(thread: string) {
    const run = runOf(thread)
    const started = run.phase.is === 'launching'
    if (started) fail(thread, 'its session ended before its channel connected')
    else become(run, { is: 'stopped' })
    if (thread === main) revive()
    else if (!started && run.queue.length) void launch(thread, threads[thread]?.name ?? thread)
  }

  async function respawn(thread: string, running: claude.Agent) {
    const run = runOf(thread)
    const id = running.id ?? running.sessionId.slice(0, 8)
    if (run.phase.is === 'launching' && run.phase.respawned) {
      process.stderr.write(`hub: ${thread}'s session ${id} restarted and still has no channel\n`)
      return fail(thread, 'its session runs, but its channel never connects')
    }
    process.stderr.write(`hub: ${thread}'s session ${id} runs without its channel, so it restarts in place\n`)
    if (run.phase.is === 'launching') run.phase.respawned = true
    else become(run, { is: 'launching', respawned: true })
    const phase = run.phase
    await claude.respawn(running)
    if (run.phase === phase) recover(thread)
  }

  // A session that dies before Claude saves its conversation can't be resumed, so the
  // thread keeps its last saved session until the new one has a conversation on disk.
  function claim(thread: string) {
    const run = runOf(thread)
    const known = threads[thread]
    if (!run.unsaved || !known || !existsSync(claude.transcript(cwdOf(thread), run.unsaved))) return
    known.session = run.unsaved
    run.unsaved = undefined
    save()
  }

  function cwdOf(thread: string) {
    return threads[thread]?.cwd ?? hexDir
  }

  function current(thread: string) {
    return runs.get(thread)?.unsaved ?? threads[thread]?.session
  }

  rmSync(socketPath, { force: true })
  const serve = server && endpoint(path.slice(1), channel, token!, server, {
      call,
      permission: (thread, request) => permission?.(thread, request),
      open: (thread, line) => welcome(thread, line),
      close: drop,
    })
  if (serve) channels.set(path, serve)

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
        const run = runOf(request.thread)
        if (run.renew !== 'underway') run.renew = 'asked'
        hangUp(run)
      }
      if (request.type === 'keep') {
        const run = runOf(request.thread)
        if (run.renew !== 'underway') run.renew = undefined
        onCall.add(run)
        letGo(request.thread)
      }
      if (request.type === 'open') void launch(request.thread, request.name, { prompt: request.prompt })
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
    if (!main || closed || runOf(main).phase.is === 'live') return
    rename(main, mainName)
    void launch(main, mainName)
  }
  // Sessions that outlived the hub (a hub restart) reconnect, or recover. A fresh main thread's
  // launch never resumes, so one still running waits for its session instead of starting another.
  if (main || Object.keys(threads).length) {
    void claude.agents().then(running => {
      const serving = new Set(Object.keys(threads).filter(thread => running.some(agent => agent.sessionId === current(thread) || boundTo(agent) === thread)))
      for (const thread of serving) {
        const run = runOf(thread)
        if (run.phase.is !== 'stopped') continue
        become(run, { is: 'recovering' })
        recover(thread)
      }
      if (main && !(fresh(main) && serving.has(main))) revive()
    })
  }

  return {
    deliver,
    command: restart,
    configure,
    settings: (thread: string): Settings => ({ model: threads[thread]?.model, effort: threads[thread]?.effort }),
    register: (thread: string, name: string, cwd?: string) => void register(thread, name, cwd),
    open: (thread: string, name: string, prompt?: string, cwd?: string) => void launch(thread, name, { prompt, cwd }),
    fork: (thread: string, name: string, session: string, prompt: string, cwd?: string) => void launch(thread, name, { prompt, fork: session, cwd }),
    main,
    renewal,
    session: current,
    threads: () => Object.keys(threads),
    name: (thread: string) => threads[thread]?.name,
    cwd: (thread: string) => threads[thread]?.cwd,
    stop,
    answer: (thread: string, request_id: string, behavior: 'allow' | 'deny') => {
      const { phase } = runOf(thread)
      if (phase.is === 'live') phase.line.send({ type: 'permission', request_id, behavior })
    },
    release,
    adopt,
    retire,
    find,
    rename,
    close: () => {
      closed = true
      sock.close()
      if (serve && channels.get(path) === serve) channels.delete(path)
      for (const run of runs.values()) {
        become(run, { is: 'stopped' })
        clearTimeout(run.rest)
        hangUp(run)
      }
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
