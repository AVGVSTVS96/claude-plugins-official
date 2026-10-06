import { createServer, type Socket } from 'net'
import { execFile, spawn } from 'child_process'
import { readFileSync, writeFileSync, renameSync, rmSync, watch, type FSWatcher } from 'fs'
import { homedir } from 'os'
import { join } from 'path'

export type Message = { content: string; meta: Record<string, string> }
export type Call = (thread: string, tool: string, args: Record<string, unknown>) => Promise<string>
export type State = (thread: string, busy: boolean) => void
export type Failed = (thread: string, reason: string) => void
type Thread = { name: string; session?: string }
type Agent = { sessionId: string; pid?: number; status?: string }
export type Hub = ReturnType<typeof startHub>

// Every client running in this process, so a thread can move between them.
// place() opens an empty thread on the client and returns its id and a link to it.
export const clients = new Map<string, { hub: Hub; place: (name: string, where?: string) => Promise<{ thread: string; link: string }> }>()

const HEX = join(homedir(), 'hex')
const JOBS = join(process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), '.claude'), 'jobs')
const IDLE_STOP = 30 * 60_000

export function startHub({ stateDir, channel, main, call, state, failed, idleStop = IDLE_STOP, jobsDir = JOBS, hexDir = HEX }: {
  stateDir: string
  channel: string
  main?: string
  call: Call
  state: State
  failed: Failed
  idleStop?: number
  jobsDir?: string
  hexDir?: string
}) {
  const registry = join(stateDir, 'threads.json')
  const socketPath = join(stateDir, 'hub.sock')
  const threads: Record<string, Thread> = read()
  const live = new Map<string, Socket>()
  const queued = new Map<string, Message[]>()
  const launching = new Map<string, FSWatcher | undefined>()
  const idle = new Map<string, ReturnType<typeof setTimeout>>()
  const busy = new Set<string>()
  const retiring = new Set<string>()
  const leaving = new Map<string, (session: string) => void>()
  const plugin = channel.replace(/^plugin:/, '')

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

  function settings() {
    return JSON.parse(readFileSync(join(hexDir, '.claude', 'thread.json'), 'utf8'))
  }

  function setState(thread: string, working: boolean) {
    state(thread, working)
    clearTimeout(idle.get(thread))
    idle.delete(thread)
    if (working) busy.add(thread)
    else busy.delete(thread)
    if (working || thread === main || !live.has(thread)) return
    if (retiring.has(thread)) stop(thread)
    else idle.set(thread, setTimeout(() => stopIfIdle(thread), idleStop))
  }

  // The Stop hook ends a turn, but background tasks keep a session busy past it,
  // so Claude's own status decides; a busy session reports idle again when it's done.
  function stopIfIdle(thread: string) {
    idle.delete(thread)
    const session = threads[thread]?.session
    if (!session) return
    agent(session, running => {
      if (!busy.has(thread) && running?.status !== 'busy') stop(thread)
    })
  }

  function stop(thread: string) {
    idle.delete(thread)
    retiring.delete(thread)
    const session = threads[thread]?.session
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

  function adopt(thread: string, name: string, session: string, prompt: string) {
    threads[thread] = { name, session }
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

  function launch(thread: string, name: string, prompt?: string, fork?: string) {
    if (thread === main || launching.has(thread)) return
    retiring.delete(thread)
    const known = threads[thread] ?? (threads[thread] = { name })
    setState(thread, true)
    launching.set(thread, undefined)
    if (fork) return start(known, thread, prompt, fork)
    if (!known.session) return start(known, thread, prompt)
    const session = known.session
    agent(session, running => {
      if (running) return
      // `claude --bg --resume` copies the conversation to a new id while the old
      // session's job record exists, even once stopped; `claude rm` keeps the conversation.
      execFile('claude', ['rm', session.slice(0, 8)], () => start(known, thread, prompt))
    })
  }

  function agent(session: string, then: (running?: Agent) => void) {
    execFile('claude', ['agents', '--json'], (_, stdout) => {
      let agents: Agent[] = []
      try {
        agents = JSON.parse(stdout)
      } catch {}
      then(agents.find(agent => agent.sessionId === session && agent.pid))
    })
  }

  function start(known: Thread, thread: string, prompt?: string, fork?: string) {
    let launcher
    try {
      launcher = spawn('claude', [
        '--bg',
        '--channels', channel,
        '--name', known.name,
        ...(fork ? ['--resume', fork, '--fork-session'] : known.session ? ['--resume', known.session] : []),
        '--settings', JSON.stringify({ ...settings(), enabledPlugins: { [plugin]: true }, env: { HEX_THREAD: thread, HEX_HUB: socketPath } }),
        ...(prompt ? [prompt] : []),
      ], { cwd: hexDir, stdio: ['ignore', 'pipe', 'pipe'] })
    } catch (error) {
      return fail(thread, String(error))
    }
    let output = ''
    launcher.stdout.on('data', chunk => (output += chunk))
    launcher.stderr.on('data', chunk => (output += chunk))
    launcher.on('error', error => fail(thread, error.message))
    launcher.on('close', code => {
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
    setState(thread, false)
    failed(thread, reason)
  }

  function deliver(thread: string, name: string, message: Message) {
    const socket = live.get(thread)
    if (socket) return send(socket, { type: 'inbound', ...message })
    queued.set(thread, [...(queued.get(thread) ?? []), message])
    launch(thread, name)
  }

  function welcome(thread: string, session: string, socket: Socket) {
    live.set(thread, socket)
    settle(thread)
    const known = threads[thread] ?? (threads[thread] = { name: thread })
    if (session && known.session !== session) {
      known.session = session
      save()
    }
    for (const message of queued.get(thread) ?? []) send(socket, { type: 'inbound', ...message })
    queued.delete(thread)
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
      if (request.type === 'state') setState(request.thread, request.busy)
      if (request.type === 'open') launch(request.thread, request.name, request.prompt)
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
      setState(thread, false)
      if (leaving.has(thread)) forget(thread)
    })
    socket.on('error', () => {})
  }).listen(socketPath)

  return {
    deliver,
    open: (thread: string, name: string, prompt: string) => launch(thread, name, prompt),
    fork: (thread: string, name: string, session: string, prompt: string) => launch(thread, name, prompt, session),
    main,
    session: (thread: string) => threads[thread]?.session,
    release,
    adopt,
    retire,
    find,
    rename,
    close: () => server.close(),
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
  if (thread === from.main) target.hub.fork(dest, name, session, prompt)
  else void from.release(thread).then(session => target.hub.adopt(dest, name, session, prompt))
  return link
}
