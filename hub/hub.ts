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

const ASSISTANT = join(homedir(), 'assistant')
const JOBS = join(process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), '.claude'), 'jobs')
const IDLE_STOP = 30 * 60_000

export function startHub({ stateDir, channel, main, call, state, failed, idleStop = IDLE_STOP, jobsDir = JOBS, assistantDir = ASSISTANT }: {
  stateDir: string
  channel: string
  main?: string
  call: Call
  state: State
  failed: Failed
  idleStop?: number
  jobsDir?: string
  assistantDir?: string
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

  function read() {
    try {
      return JSON.parse(readFileSync(registry, 'utf8'))
    } catch {
      return {}
    }
  }

  function save() {
    writeFileSync(`${registry}.tmp`, JSON.stringify(threads, null, 2) + '\n')
    renameSync(`${registry}.tmp`, registry)
  }

  function settings() {
    return JSON.parse(readFileSync(join(assistantDir, '.claude', 'thread.json'), 'utf8'))
  }

  function setState(thread: string, working: boolean) {
    state(thread, working)
    clearTimeout(idle.get(thread))
    idle.delete(thread)
    if (working) busy.add(thread)
    else busy.delete(thread)
    if (working || thread === main || !live.has(thread)) return
    if (retiring.has(thread)) stop(thread)
    else idle.set(thread, setTimeout(() => stop(thread), idleStop))
  }

  function stop(thread: string) {
    idle.delete(thread)
    retiring.delete(thread)
    const session = threads[thread]?.session
    if (session) execFile('claude', ['stop', session.slice(0, 8)], () => {})
  }

  function retire(thread: string) {
    if (thread === main) throw new Error('the main thread stays open')
    retiring.add(thread)
    if (!busy.has(thread)) stop(thread)
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

  function launch(thread: string, name: string, prompt?: string) {
    if (thread === main || launching.has(thread)) return
    retiring.delete(thread)
    const known = threads[thread] ?? (threads[thread] = { name })
    setState(thread, true)
    launching.set(thread, undefined)
    if (!known.session) return start(known, thread, prompt)
    const session = known.session
    execFile('claude', ['agents', '--json'], (_, stdout) => {
      const running = parse(stdout).some(agent => agent.sessionId === session && agent.pid)
      if (running) return
      // `claude --bg --resume` copies the conversation to a new id while the old
      // session's job record exists, even once stopped; `claude rm` keeps the conversation.
      execFile('claude', ['rm', session.slice(0, 8)], () => start(known, thread, prompt))
    })
  }

  function parse(json: string): { sessionId: string; pid?: number }[] {
    try {
      return JSON.parse(json)
    } catch {
      return []
    }
  }

  function start(known: Thread, thread: string, prompt?: string) {
    const launcher = spawn('claude', [
      '--bg',
      '--channels', channel,
      '--name', known.name,
      ...(known.session ? ['--resume', known.session] : []),
      '--settings', JSON.stringify({ ...settings(), env: { ASSISTANT_THREAD: thread, ASSISTANT_HUB: socketPath } }),
      ...(prompt ? [prompt] : []),
    ], { cwd: assistantDir, stdio: ['ignore', 'pipe', 'pipe'] })
    let output = ''
    launcher.stdout.on('data', chunk => (output += chunk))
    launcher.stderr.on('data', chunk => (output += chunk))
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
        const request = JSON.parse(buffer.slice(0, end))
        buffer = buffer.slice(end + 1)
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
    })
    socket.on('close', () => {
      if (live.get(thread) !== socket) return
      live.delete(thread)
      setState(thread, false)
    })
    socket.on('error', () => {})
  }).listen(socketPath)

  return { deliver, open: launch, retire, find, rename, close: () => server.close() }
}
