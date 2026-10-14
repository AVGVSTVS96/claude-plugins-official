import { readdirSync, readFileSync, renameSync, watch, writeFileSync } from 'fs'
import { join } from 'path'
import type { Ask as Asked } from '../../hub/ledger.ts'
import { Changes } from './changes.ts'
import { relay } from './relay.ts'
import { T3, type Fresh, type Stuck } from './t3.ts'

export type Kind = 'pick' | 'yesno' | 'do' | 'look'
// value: the button's own label, when the option stands for one; url: an option that opens a page.
export type Option = { label: string; value?: string; pick?: boolean; url?: string }
export type Answer = { label: string; at: string; via: string }
export type Ref = { app: string; thread: string; message: number }
export type Ask = {
  id: string
  kind: Kind
  task: string
  topic: string
  at: string
  question: string
  context?: string
  options: Option[]
  tag?: string
  places?: string[]
  link?: string
}
// hex's check rewrites the raw questions into these: one per decision, however many places asked
// it (refs), in the order that unblocks the most, with its pick and what it costs.
export type Curated = Omit<Ask, 'topic' | 'link'> & { refs?: Ref[] }
export type Note = { title: string; text: string; did?: string }
export type CheckResult = {
  at: string
  why: string
  read: Record<string, number>
  asks: Curated[]
  fixed: Note[]
  flagged: Note[]
  stuck: Stuck[]
}
export type View = {
  version: number
  asks: Ask[]
  stuck: (Stuck & { sent?: string })[]
  fresh: (Fresh & { read: boolean })[]
  check: { at: string; why: string; fixed: number; flagged: number } | null
}
type Marks = { answers: Record<string, Answer>; sent: Record<string, string>; dismissed: Record<string, string>; read: Record<string, string> }

const KEEP = 14 * 24 * 60 * 60_000
const WHERE: Record<string, string> = { app: 'in the app', call: 'on a call' }
const PICK = /\s*[(\[]?\s*(?:←\s*)?(?:(?:my|hex[’']s) pick)\s*[)\]]?/i

// Everything waiting on the owner, in one list: each question a hex thread asked with buttons or a
// poll and nobody has answered (from each app's ledger), as hex's check last rewrote them; what's
// stuck and what finished since he looked (T3 Code's own records, and what the check found). An
// answer goes back the way a tap in the chat app would, through that app's hub.
export class Asks extends Changes {
  view: Omit<View, 'version'> = { asks: [], stuck: [], fresh: [], check: null }
  counts = new Changes()
  private ledgers = new Map<string, Asked[]>()
  private names = new Map<string, string>()
  private result?: CheckResult
  private marks: Marks
  private pending?: ReturnType<typeof setTimeout>
  private stops: (() => void)[] = []
  private t3: T3

  constructor(
    private state: string,
    t3Database?: string,
  ) {
    super()
    this.marks = readMarks(join(state, 'voice', 'marks.json'))
    this.t3 = new T3(() => this.schedule(), t3Database)
    for (const app of apps(state)) this.stops.push(watchDir(join(state, app), file => (file === 'ledger.json' || file === 'threads.json') && this.schedule()))
    this.stops.push(watchDir(join(state, 'voice'), file => file === 'check.json' && this.schedule()))
    this.build()
  }

  get check() {
    return this.result
  }

  close() {
    clearTimeout(this.pending)
    this.t3.close()
    for (const stop of this.stops) stop()
  }

  find(id: string) {
    return this.view.asks.find(ask => ask.id === id)
  }

  // The thread's own questions, for its page.
  of(task: string) {
    return this.view.asks.filter(ask => ask.task === task)
  }

  async answer(id: string, label: string, via: string) {
    const ask = this.find(id)
    if (!ask) throw new Error('that question is already answered or settled')
    const option = ask.options.find(option => option.label === label)
    const refs = this.refs(id).filter(ref => this.open(ref))
    const where = WHERE[via] ?? via
    if (!refs.length) {
      this.marks.answers[id] = { label, at: now(), via }
      this.saveMarks()
      return this.tell(ask.task, `(answered ${where}) ${ask.question}: ${label}`, via)
    }
    const [first, ...rest] = refs
    const value = option?.value ?? label
    if (this.asked(first!)!.options.includes(value)) await relay(this.state, first!.app, { type: 'answer', thread: first!.thread, message: first!.message, label: value, via })
    else {
      await this.tell(`${first!.app}:${first!.thread}`, `(answered ${where}) ${ask.question}: ${label}`, via)
      rest.unshift(first!)
    }
    for (const ref of rest) await relay(this.state, ref.app, { type: 'settle', thread: ref.thread, message: ref.message, note: `✓ Answered ${where}: ${label}` })
  }

  // Takes back an answer given in the app or on a call: its buttons come back and its thread hears.
  async undo(id: string, via: string) {
    const answered = this.marks.answers[id]
    if (answered) {
      delete this.marks.answers[id]
      this.saveMarks()
      const curated = this.result?.asks.find(ask => ask.id === id)
      return curated && this.tell(curated.task, `(took back) ${curated.question}: ${answered.label}`, via)
    }
    for (const ref of this.refs(id)) {
      const asked = this.asked(ref)
      if (asked && (WHERE[asked.answer?.via ?? ''] || asked.settled?.note.startsWith('✓ Answered'))) await relay(this.state, ref.app, { type: 'reopen', thread: ref.thread, message: ref.message, via })
    }
  }

  // A stuck item's one action: hex's General is asked to do it, or it's put away until it changes.
  async act(id: string) {
    const item = this.view.stuck.find(item => item.id === id)
    if (!item) throw new Error('that is no longer stuck')
    if (item.request) {
      await this.tell(this.general(), item.request, 'app')
      this.marks.sent[id] = now()
    } else this.marks.dismissed[id] = now()
    this.saveMarks()
  }

  read(id: string) {
    this.marks.read[id] = now()
    this.saveMarks()
  }

  private refs(id: string): Ref[] {
    const curated = this.result?.asks.find(ask => ask.id === id)
    if (curated) return curated.refs ?? []
    const ref = parseRef(id)
    return ref ? [ref] : []
  }

  private asked(ref: Ref) {
    return this.ledgers.get(ref.app)?.find(ask => ask.thread === ref.thread && ask.message === ref.message)
  }

  private open(ref: Ref) {
    const asked = this.asked(ref)
    return !!asked && !asked.answer && !asked.settled
  }

  private tell(task: string, content: string, via: string) {
    const [app, ...thread] = task.split(':')
    return relay(this.state, app!, { type: 'inbound', thread: thread.join(':'), content, meta: { user: `hex ${via}` } })
  }

  private general() {
    const general = [...this.names.keys()].find(task => /^telegram:-\d+$/.test(task))
    if (!general) throw new Error('hex has no Telegram General to send this to')
    return general
  }

  private schedule() {
    clearTimeout(this.pending)
    this.pending = setTimeout(() => this.build(), 30)
  }

  private build() {
    this.names.clear()
    for (const app of apps(this.state)) {
      this.ledgers.set(app, readJson(join(this.state, app, 'ledger.json'))?.asks ?? [])
      for (const [thread, known] of Object.entries<any>(readJson(join(this.state, app, 'threads.json')) ?? {})) this.names.set(`${app}:${thread}`, known.name ?? thread)
    }
    this.result = readJson(join(this.state, 'voice', 'check.json'))
    const used = new Set<string>()
    const curated = (this.result?.asks ?? []).flatMap(ask => {
      for (const ref of ask.refs ?? []) used.add(refId(ref))
      const live = ask.refs?.length ? ask.refs.some(ref => this.open(ref)) : !this.marks.answers[ask.id]
      return live ? [this.dress(ask)] : []
    })
    const raw = [...this.ledgers].flatMap(([app, asks]) =>
      asks.filter(ask => !ask.answer && !ask.settled && !used.has(refId({ app, ...ask }))).map(ask => this.dress(fromLedger(app, ask))),
    )
    raw.sort((a, b) => b.at.localeCompare(a.at))
    const checked = this.result?.at ?? ''
    const stuck = [...this.t3.stuck, ...(this.result?.stuck ?? [])]
      .filter(item => !this.marks.dismissed[item.id])
      .map(item => ({ ...item, ...(this.marks.sent[item.id] && { sent: this.marks.sent[item.id] }) }))
    const view: Omit<View, 'version'> = {
      asks: [...raw.filter(ask => ask.at > checked), ...curated, ...raw.filter(ask => ask.at <= checked)],
      stuck,
      fresh: this.t3.fresh.map(item => ({ ...item, read: !!this.marks.read[item.id] })),
      check: this.result ? { at: this.result.at, why: this.result.why, fixed: this.result.fixed.length, flagged: this.result.flagged.length } : null,
    }
    if (JSON.stringify(view) === JSON.stringify(this.view)) return
    const moved = view.asks.length !== this.view.asks.length || view.stuck.length !== this.view.stuck.length
    this.view = view
    this.changed()
    if (moved) this.counts.changed()
  }

  private dress(ask: Curated): Ask {
    const { refs, ...rest } = ask
    const ref = refs?.[0]
    return {
      ...rest,
      topic: this.names.get(ask.task) ?? ask.task.split(':').at(-1)!,
      ...(ref && link(ref) && { link: link(ref) }),
    }
  }

  private saveMarks() {
    const since = new Date(Date.now() - KEEP).toISOString()
    for (const book of Object.values(this.marks) as Record<string, string | Answer>[])
      for (const [id, at] of Object.entries(book)) if ((typeof at === 'string' ? at : at.at) < since) delete book[id]
    const file = join(this.state, 'voice', 'marks.json')
    writeFileSync(`${file}.tmp`, JSON.stringify(this.marks, null, 1) + '\n')
    renameSync(`${file}.tmp`, file)
    this.schedule()
  }
}

// A question as its thread asked it: its first line is the question and the rest its context; the
// option the thread marked as its pick wears it.
export function fromLedger(app: string, asked: Asked): Curated {
  const lines = plain(asked.text)
    .split('\n')
    .map(line => line.trim())
    .filter(Boolean)
  const options = asked.options.map(value => {
    const label = value.replace(PICK, '').trim() || value
    return { label, value, ...(label !== value && { pick: true }) }
  })
  const context = lines.slice(1).join(' ')
  return {
    id: refId({ app, ...asked }),
    kind: asked.options.length <= 2 ? 'yesno' : 'pick',
    task: `${app}:${asked.thread}`,
    at: asked.at,
    question: clip(lines[0] ?? '', 160).replace(/:$/, ''),
    ...(context && { context: clip(context, 280) }),
    options,
    refs: [{ app, thread: asked.thread, message: asked.message }],
  }
}

export function refId({ app, thread, message }: Ref) {
  return `${app}:${thread}:${message}`
}

function parseRef(id: string): Ref | undefined {
  const [, app, thread, message] = id.match(/^(\w+):(.+):(\d+)$/) ?? []
  return app && thread ? { app, thread, message: Number(message) } : undefined
}

function link({ app, thread, message }: Ref) {
  if (app !== 'telegram' || !thread.startsWith('-100')) return
  const [chat, topic] = thread.slice(4).split(':')
  return topic ? `https://t.me/c/${chat}/${topic}/${message}` : `https://t.me/c/${chat}/${message}`
}

function plain(text: string) {
  return text
    .replace(/```[\s\S]*?(```|$)/g, '')
    .replace(/\*\*|__|`/g, '')
    .replace(/^#+\s+/gm, '')
}

function clip(text: string, max: number) {
  return text.length > max ? `${text.slice(0, max - 1).trimEnd()}…` : text
}

function apps(state: string) {
  try {
    return readdirSync(state).filter(app => app !== 'voice')
  } catch {
    return []
  }
}

function readMarks(file: string): Marks {
  const marks = readJson(file) ?? {}
  return { answers: marks.answers ?? {}, sent: marks.sent ?? {}, dismissed: marks.dismissed ?? {}, read: marks.read ?? {} }
}

function readJson(path: string) {
  try {
    return JSON.parse(readFileSync(path, 'utf8'))
  } catch {}
}

function watchDir(dir: string, changed: (file: string | null) => void) {
  try {
    const watcher = watch(dir, (_, file) => changed(file))
    return () => watcher.close()
  } catch {
    return () => {}
  }
}

function now() {
  return new Date().toISOString()
}
