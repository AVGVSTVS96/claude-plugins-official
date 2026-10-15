import { createServer, type Socket } from 'net'
import { execFile, spawn } from 'child_process'
import { createHash } from 'crypto'
import { closeSync, existsSync, fstatSync, openSync, readFileSync, readSync, writeFileSync, renameSync, rmSync, watch, type FSWatcher } from 'fs'
import { homedir } from 'os'
import { basename, join } from 'path'

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
type Agent = { sessionId: string; pid?: number; status?: string; name?: string; cwd?: string; startedAt?: number }
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
const RELAUNCH = 30_000
// Claude Code keeps a conversation in the prompt cache for an hour after its last request,
// and compacts a background session only when told to.
const CACHE_WARM = 54 * 60_000
const COMPACT_ABOVE = 150_000
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

export function startHub({ stateDir, channel, main, mainName = 'main', general = false, call, state, failed, permission, asks, args = () => [], bind = () => ({}), fresh = () => false, idleStop = IDLE_STOP, cacheWarm = CACHE_WARM, compactAbove = COMPACT_ABOVE, relaunch = RELAUNCH, jobsDir = JOBS, hexDir = process.cwd(), projectsDir = join(CLAUDE, 'projects'), launcher = 'claude' }: {
  stateDir: string
  channel: string
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
  // A fresh thread starts a new session for each message that finds its session done,
  // instead of resuming it, and the launcher builds what that session knows of the chat.
  fresh?: (thread: string) => boolean
  idleStop?: number
  // How long the main thread rests before it compacts, while its cache is still warm.
  cacheWarm?: number
  // A session whose context is bigger than this compacts before it rests.
  compactAbove?: number
  relaunch?: number
  jobsDir?: string
  hexDir?: string
  projectsDir?: string
  launcher?: string
}) {
  const registry = join(stateDir, 'threads.json')
  const socketPath = join(stateDir, 'hub.sock')
  const threads: Record<string, Thread> = read()
  const live = new Map<string, Socket>()
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
    rest(thread)
    letGo(thread)
  }

  // A thread that asked to renew (a voice call ended), or whose session is older than this hub
  // and so may run older code (an update restarts the hub), starts over at its next rest: the
  // main thread as soon as its process exits rather than after its relaunch delay, any other
  // when its next message resumes it. A keep (a call started) cancels it. When the session asked
  // for it, a rest the Stop hook reported with no agents working is taken as it is: Claude's own
  // status lags the hook and counts a running shell as busy, so checking it could put the renew
  // off for good, and a session that asked is done with what its shells were for.
  function renew(thread: string, rested = false) {
    const session = current(thread)
    if (!session) return
    agent(session, running => {
      if (!renewing.has(thread) || busy.has(thread) || onCall.has(callOf(thread)) || (!rested && running?.status === 'busy')) return
      renewing.delete(thread)
      asked.delete(thread)
      if (running && thread === main) {
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
  function rest(thread: string) {
    clearTimeout(idle.get(thread))
    idle.delete(thread)
    if (busy.has(thread) || !live.has(thread)) return
    if (thread === main) idle.set(thread, setTimeout(() => stopIfIdle(thread), cacheWarm))
    else if (retiring.has(thread)) stop(thread)
    else idle.set(thread, setTimeout(() => stopIfIdle(thread), idleStop))
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
      if (running && !retiring.has(thread) && !fresh(thread) && !onCall.has(callOf(thread)) && context(thread, session) > compactAbove) {
        compacting.add(thread)
        cycle(thread, running, '/compact')
      } else if (thread !== main) stop(thread)
    })
  }

  // The context a session's last request sent, from the newest usage or compaction in its transcript.
  function context(thread: string, session: string): number {
    let file: number
    try {
      file = openSync(transcript(thread, session), 'r')
    } catch {
      return 0
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
        if (entry.type === 'system' && entry.subtype === 'compact_boundary') return entry.compactMetadata?.postTokens ?? 0
        const usage = entry.type === 'assistant' && !entry.isSidechain ? entry.message?.usage : undefined
        const sent = usage ? (usage.input_tokens ?? 0) + (usage.cache_creation_input_tokens ?? 0) + (usage.cache_read_input_tokens ?? 0) : 0
        if (sent) return sent
      }
      return 0
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

  function send(socket: Socket, payload: object) {
    socket.write(JSON.stringify(payload) + '\n')
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
    if (!known.session || fresh(thread)) return start(known, thread, prompt)
    const session = known.session
    agent(session, running => {
      if (running) return
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
    const bound = { ...bind(thread), HEX_CHANNEL: channel, HEX_THREAD: thread, HEX_HUB: socketPath, ...(general && thread === main ? { HEX_MAIN: '1' } : {}), ...(fresh(thread) ? { HEX_FRESH: '1' } : {}) }
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
    renewed.delete(thread)
    failed(thread, reason)
    setState(thread, false)
  }

  function deliver(thread: string, name: string, message: Message) {
    const socket = live.get(thread)
    if (socket && !stale(thread) && !fresh(thread)) return send(socket, { type: 'inbound', ...message })
    if (socket) return refresh(thread, message)
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
  function refresh(thread: string, message: Message) {
    agent(current(thread) ?? '', running => {
      const socket = live.get(thread)
      const working = fresh(thread) ? busy.has(thread) || (running && running.status !== 'idle') : running?.status === 'busy'
      if (socket && working && !queued.has(thread)) return send(socket, { type: 'inbound', ...message })
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

  function welcome(thread: string, session: string, socket: Socket) {
    live.set(thread, socket)
    renewing.delete(thread)
    asked.delete(thread)
    renewed.delete(thread)
    settle(thread)
    const known = threads[thread] ?? (threads[thread] = { name: thread })
    if (session && known.session !== session) unsaved.set(thread, session)
    else unsaved.delete(thread)
    claim(thread)
    for (const message of queued.get(thread) ?? []) send(socket, { type: 'inbound', ...message })
    queued.delete(thread)
    rest(thread)
    agent(current(thread) ?? '', running => {
      if (live.get(thread) !== socket || !running?.startedAt || running.startedAt >= born) return
      renewing.add(thread)
      renew(thread)
    })
    letGo(thread)
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
  const server = createServer(socket => {
    let thread = ''
    let buffer = ''
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
      if (request.type === 'hello') welcome(thread = request.thread, request.session, socket)
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
          text => send(socket, { type: 'result', id: request.id, text }),
          error => send(socket, { type: 'result', id: request.id, error: error instanceof Error ? error.message : String(error) }),
        )
      }
    }
    socket.on('close', () => {
      if (live.get(thread) !== socket) return
      live.delete(thread)
      hangUp(callOf(thread))
      setState(thread, false)
      if (leaving.has(thread)) forget(thread)
      if (thread === main) setTimeout(revive, relaunch)
    })
    socket.on('error', () => {})
  }).listen(socketPath)

  // The main thread is always running: started with the hub, and started again
  // when its session has been gone long enough that it isn't just reconnecting.
  function revive() {
    if (!main || closed || live.has(main)) return
    rename(main, mainName)
    launch(main, mainName)
  }
  // A fresh main thread's launch never resumes, so one whose session outlived the hub (a hub
  // restart) gets the same time to reconnect as a dropped one instead of a second session.
  // Its newest session may not be saved yet, so any running session under its name counts.
  if (main && fresh(main)) {
    const where = threads[main]?.cwd ?? hexDir
    agents(running => (running.some(agent => agent.sessionId === current(main) || (agent.name === mainName && agent.cwd === where)) ? setTimeout(revive, relaunch) : revive()))
  } else revive()

  return {
    deliver,
    command: restart,
    configure,
    settings: (thread: string): Settings => ({ model: threads[thread]?.model, effort: threads[thread]?.effort }),
    register: (thread: string, name: string, cwd?: string) => void register(thread, name, cwd),
    open: (thread: string, name: string, prompt?: string, cwd?: string) => launch(thread, name, prompt, undefined, cwd),
    fork: (thread: string, name: string, session: string, prompt: string, cwd?: string) => launch(thread, name, prompt, session, cwd),
    main,
    renewal,
    session: current,
    threads: () => Object.keys(threads),
    name: (thread: string) => threads[thread]?.name,
    cwd: (thread: string) => threads[thread]?.cwd,
    stop,
    answer: (thread: string, request_id: string, behavior: 'allow' | 'deny') => {
      const socket = live.get(thread)
      if (socket) send(socket, { type: 'permission', request_id, behavior })
    },
    release,
    adopt,
    retire,
    find,
    rename,
    close: () => {
      closed = true
      server.close()
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
