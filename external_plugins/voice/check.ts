import { spawn } from 'child_process'
import { createHash } from 'crypto'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'fs'
import { homedir, tmpdir } from 'os'
import { dirname, join } from 'path'
import type { Ask as Asked } from '../../hub/ledger.ts'
import type { CheckResult, Curated, Ref, Source } from './asks.ts'
import { relay } from './relay.ts'
import { T3, type Stuck } from './t3.ts'

type Verdict = Pick<CheckResult, 'asks' | 'fixed' | 'flagged' | 'stuck'> & { settle: (Ref & { note: string })[] }
type Known = { threads: Record<string, string>; calls: { id: string }[] }

const MODEL = process.env.HEX_CHECK_MODEL ?? 'claude-opus-5-5'
const CALLS = join(homedir(), '.claude', 'channels', 'voice', 'calls')
const RECENT = 3 * 24 * 60 * 60_000
const LONG = 2400

// hex's check: an Opus pass over everything waiting on the owner, started by real events (a pinned
// post changed, a T3 run ended, a call ended, Tasks opened after a change). It rewrites the raw
// questions into one list (repeats merged, its pick, what each unblocks), settles the questions the
// records show are already decided or done, and flags what it can't settle. It answers nothing for
// him. One runs at a time in a process of its own, so it outlives the voice session that started
// it. Events that land while it runs leave one mark, so a burst of them costs one more pass at
// most, and a pass whose records haven't changed since the last one skips Opus.
export class Check {
  private dir: string

  constructor(private state: string) {
    this.dir = join(state, 'voice', 'check')
    mkdirSync(this.dir, { recursive: true })
  }

  get running() {
    const pid = Number(read(join(this.dir, 'lock')))
    return !!pid && alive(pid)
  }

  start(why: string) {
    writeFileSync(join(this.dir, 'next'), why)
    if (!this.running) spawn(process.execPath, [import.meta.path, this.state], { detached: true, stdio: 'ignore' }).unref()
  }
}

// Whoever holds the lock runs a pass per mark until none is left; a mark left in the moment the
// lock is let go is picked up again, by this process or the one that took the lock.
async function run(state: string) {
  const dir = join(state, 'voice', 'check')
  while (existsSync(join(dir, 'next')) && hold(join(dir, 'lock'))) {
    try {
      for (let why = take(join(dir, 'next')); why; why = take(join(dir, 'next'))) {
        await pass(state, why).then(
          () => rmSync(join(dir, 'error'), { force: true }),
          error => writeFileSync(join(dir, 'error'), `${new Date().toISOString()} ${why}: ${error instanceof Error ? error.message : error}\n`),
        )
      }
    } finally {
      rmSync(join(dir, 'lock'), { force: true })
    }
  }
}

function hold(lock: string): boolean {
  try {
    writeFileSync(lock, String(process.pid), { flag: 'wx' })
    return true
  } catch {
    if (alive(Number(read(lock)))) return false
    rmSync(lock, { force: true })
    return hold(lock)
  }
}

async function pass(state: string, why: string) {
  const started = new Date().toISOString()
  const records = gather(state)
  const inputs = digest(records)
  if (records.previous?.inputs === inputs) return
  const verdict = vet(await claude(prompt(records), dirname(state)), records.ledgers, { threads: records.threads, calls: records.calls })
  for (const ref of verdict.settle) await relay(state, ref.app, { type: 'settle', thread: ref.thread, message: ref.message, note: ref.note }).catch(error => process.stderr.write(`voice: check: ${error}\n`))
  const result: CheckResult = {
    at: started,
    why,
    read: {
      'pinned posts': records.pins.length,
      questions: records.open.length,
      'T3 items': records.t3.stuck.length + records.t3.fresh.length,
      calls: records.calls.length,
    },
    asks: verdict.asks,
    fixed: verdict.fixed,
    flagged: verdict.flagged,
    stuck: verdict.stuck,
    inputs,
  }
  const file = join(state, 'voice', 'check.json')
  writeFileSync(`${file}.tmp`, JSON.stringify(result, null, 1) + '\n')
  renameSync(`${file}.tmp`, file)
}

function gather(state: string) {
  const now = Date.now()
  const recent = new Date(now - RECENT).toISOString()
  const names: Record<string, string> = {}
  const ledgers: Record<string, Asked[]> = {}
  const pins: { pin: Ref; topic: string; text: string }[] = []
  for (const app of readdirSync(state).filter(app => app !== 'voice')) {
    for (const [thread, known] of Object.entries<any>(json(join(state, app, 'threads.json')) ?? {})) names[`${app}:${thread}`] = known.name ?? thread
    const book = json(join(state, app, 'ledger.json'))
    ledgers[app] = book?.asks ?? []
    for (const [thread, pin] of Object.entries<any>(book?.pins ?? {})) if (pin.text) pins.push({ pin: { app, thread, message: pin.message }, topic: names[`${app}:${thread}`] ?? thread, text: clip(pin.text, LONG) })
  }
  const shown = (app: string, ask: Asked) => ({
    ref: { app, thread: ask.thread, message: ask.message },
    topic: names[`${app}:${ask.thread}`] ?? ask.thread,
    at: ask.at,
    text: clip(ask.text, 700),
    options: ask.options,
    ...(ask.poll && { poll: true }),
    ...(ask.answer && { answer: ask.answer }),
    ...(ask.settled && { settled: ask.settled }),
  })
  const open = Object.entries(ledgers).flatMap(([app, asks]) => asks.filter(ask => !ask.answer && !ask.settled).map(ask => shown(app, ask)))
  const closed = Object.entries(ledgers).flatMap(([app, asks]) => asks.filter(ask => (ask.answer || ask.settled) && ask.at > recent).map(ask => shown(app, ask)))
  const t3 = new T3(() => {})
  const t3Now = t3.query(now)
  t3.close()
  const calls = list(CALLS)
    .filter(file => file.endsWith('.json') && statSync(join(CALLS, file)).mtimeMs > now - RECENT)
    .map(file => json(join(CALLS, file)))
    .filter(call => call?.ended && (call.summary || call.waiting?.length))
    .map(call => ({ id: call.id, title: call.title, ended: call.ended, summary: call.summary, waiting: call.waiting ?? [] }))
  return { now: new Date(now).toISOString(), threads: names, open, closed, pins, calls, t3: t3Now, previous: json(join(state, 'voice', 'check.json')), ledgers }
}

// What a pass reads, as one fingerprint: the same records give the same verdict.
export function digest({ open, closed, pins, calls, t3 }: ReturnType<typeof gather>) {
  return createHash('sha256').update(JSON.stringify({ open, closed, pins, calls, t3 })).digest('hex')
}

function prompt({ ledgers, ...records }: ReturnType<typeof gather>) {
  return `You're hex's check. hex is Bassim's personal assistant: it works for him in many threads at once (Telegram topics, Discord threads, T3 Code threads, calls with its voice app), and each thread asks him things: questions with buttons, polls, the "waiting on you" part of its pinned status post, and the waiting lines of a call's wrap-up. They pile up in dozens of places and many go stale. Your pass turns them into one honest list in his voice app, where he answers each in place.

What he asked for, in his words: "the ability to better manage my tasks with hex ... we could give an even better idea for things that need to get done. And this could all be done by looking through the transcript, gathering, auditing, analyzing, figuring out, and also checking on any work that was done by other agents ... that might be waiting for other things ... older work from yesterday or two days ago, that might not have been done ... such that I can help ship more and get unblocked".

The records are below as JSON: every open question asked with buttons or a poll (open, each with its ref), the ones answered or settled lately (closed), each thread's pinned post (pins, each with its own ref), calls' wrap-ups (calls, each with its id), what T3 Code shows as stuck or newly finished (t3; the app lists those already), and your previous pass (previous). To confirm something before you settle it, read his records: conversations in ~/hex/log/ (one markdown file per day and session; rg them), threads in ~/hex/state/*/threads.json, session transcripts under ~/.claude/projects/, project notes under ~/hex/projects/. In a transcript, his messages arrive as <channel source="..." chat_id="..." message_id="..."> and hex's own replies come back as "sent (id: N)", so a question asked in plain words has a message id there.

Return:
- asks: one entry per decision or action that is still his, however many places asked it. from lists every place that asked it, so he can open each one: an open question (copy its ref), a pinned post (copy the pin's ref), a plain message you found ({app, thread, message} with its id, or {app, thread} when you can't find the id), or a call ({app: "voice", call: its id}); thread is a key of threads without its "<app>:" prefix. Leave none out: an ask from a pinned post and a call has both. id is "check:" plus a short slug, the same slug as in your previous pass for the same thing. task is the thread it belongs to ("<app>:<thread id>", from threads). question is one short plain line (60 characters at most). context is one or two plain sentences on what it unblocks or costs. options are his possible answers, as short labels, each one telling the thread something; mark the thread's own pick with pick (one at most, only where the thread made one); when an option stands for a button, value is that button's exact text from the first open question in from. links are the pages it points to, never answers: label names the page in one to three words without a verb ("Apple Store", "PR #2", "Paper file"), url opens it. kind is pick (one of several), yesno (two ways), do (only his hands can do it, like a sign-in, a purchase, a recording: options like Done and Later, its page in links) or look (something to watch or read: options like Seen and Later, its page in links). tag is "money" when an option spends money, or "unblocks N" when N other things wait on it. Order: what unblocks the most first, even when it costs money, then the quickest; other money and anything sent in his name last. An ask's task is the thread it belongs to, even when only a pinned post or a call asked it.
- settle: open questions the records show are already decided or done: decided in a conversation or a call, replaced by a later question, or the thing already happened. note is what the question's buttons in Telegram or Discord will say instead, like "Settled: Pro is on" (40 characters at most). Settle only what the records show; anything you're unsure of stays an ask.
- fixed: what you settled or merged, the way he'd read it: title (the thing), text (the evidence, with message numbers), did (what you did, in a few words).
- flagged: what he should look at that you can't settle yourself, like the same thing asked with different options, or a question days old whose work has stalled: title and text.
- stuck: work stopped with nobody moving it that the t3 list doesn't already show, like a failing service a pinned post mentions: id (a short slug), title, why (one sentence), action (one or two words, like Restore or Look), mark (paused or failed), at, and request: what hex should do when he taps the action, as a message to hex.

Every answer is his: an ask stays open until he answers it. Leave health details and phone numbers out of everything you write.

${JSON.stringify(records)}`
}

const NOTE = { type: 'object', properties: { title: { type: 'string' }, text: { type: 'string' }, did: { type: 'string' } }, required: ['title', 'text'] }
const REF = { type: 'object', properties: { app: { type: 'string' }, thread: { type: 'string' }, message: { type: ['number', 'string'] } }, required: ['app', 'thread', 'message'] }
const SOURCE = { type: 'object', properties: { ...REF.properties, call: { type: 'string' } }, required: ['app'] }
const SCHEMA = {
  type: 'object',
  properties: {
    asks: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          id: { type: 'string' },
          kind: { enum: ['pick', 'yesno', 'do', 'look'] },
          task: { type: 'string' },
          at: { type: 'string' },
          question: { type: 'string' },
          context: { type: 'string' },
          options: {
            type: 'array',
            items: { type: 'object', properties: { label: { type: 'string' }, value: { type: 'string' }, pick: { type: 'boolean' } }, required: ['label'] },
          },
          links: { type: 'array', items: { type: 'object', properties: { label: { type: 'string' }, url: { type: 'string' } }, required: ['label', 'url'] } },
          tag: { type: 'string' },
          from: { type: 'array', items: SOURCE },
        },
        required: ['id', 'kind', 'task', 'at', 'question', 'options', 'from'],
      },
    },
    settle: { type: 'array', items: { ...REF, properties: { ...REF.properties, note: { type: 'string' } }, required: [...REF.required, 'note'] } },
    fixed: { type: 'array', items: NOTE },
    flagged: { type: 'array', items: NOTE },
    stuck: {
      type: 'array',
      items: {
        type: 'object',
        properties: { id: { type: 'string' }, title: { type: 'string' }, why: { type: 'string' }, action: { type: 'string' }, mark: { enum: ['paused', 'failed'] }, at: { type: 'string' }, request: { type: 'string' } },
        required: ['id', 'title', 'why', 'action', 'mark', 'at'],
      },
    },
  },
  required: ['asks', 'settle', 'fixed', 'flagged', 'stuck'],
}

// A read-only pass: it reads files and searches, and its only effect is the JSON it returns.
function claude(input: string, hexDir: string) {
  const args = ['-p', '--model', MODEL, '--effort', 'medium', '--output-format', 'json', '--json-schema', JSON.stringify(SCHEMA), '--tools', 'Read,Grep,Glob', '--strict-mcp-config', '--setting-sources', 'project', '--no-session-persistence', '--add-dir', hexDir, join(homedir(), '.claude', 'projects')]
  const cwd = mkdtempSync(join(tmpdir(), 'hex-check-'))
  return new Promise<Verdict>((resolve, reject) => {
    const child = spawn('claude', args, { cwd, stdio: ['pipe', 'pipe', 'pipe'] })
    let out = ''
    let err = ''
    child.stdout.on('data', chunk => (out += chunk))
    child.stderr.on('data', chunk => (err += chunk))
    child.on('error', reject)
    child.on('close', code => {
      rmSync(cwd, { recursive: true, force: true })
      try {
        const result = JSON.parse(out)
        if (result.is_error || !result.structured_output) throw new Error(result.result ?? 'no result')
        resolve(result.structured_output)
      } catch (error) {
        reject(new Error(`the check's claude exited ${code}: ${error} ${err.slice(-500)}`))
      }
    })
    child.stdin.end(input)
  })
}

// What the pass returned, held to the records: its places are real threads and calls, the open
// questions among them are the ask's refs, a value is a real button, and a question it settles isn't
// also one it lists.
export function vet(verdict: Verdict, ledgers: Record<string, Asked[]>, { threads, calls }: Known): Verdict {
  const find = (ref: Ref) => ledgers[ref.app]?.find(ask => ask.thread === ref.thread && String(ask.message) === String(ref.message))
  const open = (ref: Ref) => {
    const ask = find(ref)
    return !!ask && !ask.answer && !ask.settled
  }
  const real = (source: Source) => (source.call ? calls.some(call => call.id === source.call) : !!source.thread && `${source.app}:${source.thread}` in threads)
  const asks: Curated[] = verdict.asks.map(({ from = [], ...ask }) => {
    const places: Source[] = from.filter(real).map(({ app, thread, message, call }) => (call ? { app: 'voice', call } : { app, thread, ...(message !== undefined && { message }) }))
    const refs: Ref[] = places.flatMap(({ app, thread, message }) => (thread && message !== undefined && open({ app, thread, message }) ? [{ app, thread, message }] : []))
    const buttons = refs[0] ? find(refs[0])!.options : []
    return {
      ...ask,
      id: ask.id.startsWith('check:') ? ask.id : `check:${ask.id}`,
      options: ask.options.map(({ value, ...option }) => ({ ...option, ...(value && buttons.includes(value) && { value }) })),
      from: places,
      refs,
    }
  })
  const listed = new Set(asks.flatMap(ask => ask.refs ?? []).map(ref => `${ref.app} ${ref.thread} ${ref.message}`))
  return {
    asks,
    settle: verdict.settle.filter(ref => open(ref) && !listed.has(`${ref.app} ${ref.thread} ${ref.message}`)).map(ref => ({ ...ref, note: ref.note.slice(0, 60) })),
    fixed: verdict.fixed,
    flagged: verdict.flagged,
    stuck: verdict.stuck.map((item: Omit<Stuck, 'app'>) => ({ ...item, id: item.id.startsWith('check-') ? item.id : `check-${item.id}` })),
  }
}

function take(file: string) {
  const why = read(file)
  rmSync(file, { force: true })
  return why || undefined
}

function read(file: string) {
  try {
    return readFileSync(file, 'utf8').trim()
  } catch {
    return ''
  }
}

function json(file: string) {
  try {
    return JSON.parse(readFileSync(file, 'utf8'))
  } catch {}
}

function list(dir: string) {
  return existsSync(dir) ? readdirSync(dir) : []
}

function clip(text: string, max: number) {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text
}

function alive(pid: number) {
  try {
    return process.kill(pid, 0)
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM'
  }
}

if (import.meta.main) await run(process.argv[2]!)
