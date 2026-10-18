import { readdirSync, readFileSync, renameSync, watch, writeFileSync } from 'fs'
import { homedir } from 'os'
import { join } from 'path'
import type { Ask as Asked, MessageId, Pin } from '../../hub/ledger.ts'
import { Changes } from './changes.ts'
import { Check } from './check.ts'
import { Links } from './links.ts'
import { relay } from './relay.ts'
import { T3, type Fresh, type Stuck } from './t3.ts'

export type Kind = 'pick' | 'yesno' | 'do' | 'look'
// value: the button's own label, when the option stands for one.
export type Option = { label: string; value?: string; pick?: boolean }
// A page an ask points to; opening it answers nothing.
export type Link = { label: string; url: string }
export type Answer = { label: string; at: string; via: string }
export type Ref = { app: string; thread: string; message: MessageId }
// Where an ask was asked, as hex's check found it: a thread, with the message when it knows it
// (a question, a pinned post, a plain message), or a call.
export type Source = { app: string; thread?: string; message?: MessageId; call?: string }
// Each place an ask was asked, for its row: the app, what the place is called there, the hex thread
// (task) or call it is, and a link that opens it, the message itself where the app has one. A place
// without a link is still known to be where it was asked.
export type Place = { app: string; place: string; task?: string; call?: string; link?: string }
export type Ask = {
  id: string
  kind: Kind
  task: string
  app: string
  topic: string
  at: string
  question: string
  context?: string
  options: Option[]
  links?: Link[]
  tag?: string
  places: Place[]
}
// hex's check rewrites the raw questions into these: one per decision, however many places asked
// it (from; refs are the open questions with buttons among them, which an answer goes back to), in
// the order that unblocks the most, with its pick and what it costs.
export type Curated = Omit<Ask, 'app' | 'topic' | 'places'> & { from?: Source[]; refs?: Ref[] }
// A check.json written before places and links were typed: its places were names and a link was an
// option with a url. The next pass rewrites it.
type Written = Omit<Curated, 'options'> & { places?: string[]; options: (Option & { url?: string })[] }
export type Note = { title: string; text: string; did?: string }
export type CheckResult = {
  at: string
  why: string
  read: Record<string, number>
  asks: Curated[]
  fixed: Note[]
  flagged: Note[]
  stuck: Omit<Stuck, 'app'>[]
  inputs?: string
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
const CALLS = join(homedir(), '.claude', 'channels', 'voice', 'calls')
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
  private pins = new Map<string, Pin>()
  private links: Links
  private calls: string
  private result?: CheckResult
  private marks: Marks
  private pending?: ReturnType<typeof setTimeout>
  private stops: (() => void)[] = []
  private t3: T3
  private check: (why: string) => void
  private seen?: { pins: string; t3: string }

  constructor(
    private state: string,
    { t3Database, t3Home, calls = CALLS, check = why => new Check(state).start(why) }: { t3Database?: string; t3Home?: string; calls?: string; check?: (why: string) => void } = {},
  ) {
    super()
    this.check = check
    this.calls = calls
    this.links = new Links(state, () => this.schedule(), t3Home)
    this.marks = readMarks(join(state, 'voice', 'marks.json'))
    this.t3 = new T3(() => this.schedule(), t3Database)
    for (const app of apps(state)) this.stops.push(watchDir(join(state, app), file => (file === 'ledger.json' || file === 'threads.json') && this.schedule()))
    this.stops.push(watchDir(join(state, 'voice'), file => file === 'check.json' && this.schedule()))
    this.build()
  }

  get lastCheck() {
    return this.result
  }

  // Tasks opened with questions newer than the last check, or a call ended: hex checks again.
  opened() {
    const checked = this.result?.at ?? ''
    if ([...this.ledgers.values()].some(asks => asks.some(ask => !ask.answer && !ask.settled && ask.at > checked))) this.check('you opened Tasks')
  }

  called() {
    this.check('a call ended')
  }

  close() {
    clearTimeout(this.pending)
    this.t3.close()
    this.links.close()
    for (const stop of this.stops) stop()
  }

  find(id: string) {
    return this.view.asks.find(ask => ask.id === id)
  }

  // The thread's own questions and its pinned status post, for its page.
  of(task: string) {
    return { asks: this.view.asks.filter(ask => ask.task === task), ...(this.pins.has(task) && { pin: this.pins.get(task)!.text }) }
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
    for (const [app, asks] of this.ledgers) {
      const asked = asks.find(ask => refId({ app, ...ask }) === id)
      if (asked) return [{ app, thread: asked.thread, message: asked.message }]
    }
    return []
  }

  private asked(ref: Ref) {
    return this.ledgers.get(ref.app)?.find(ask => ask.thread === ref.thread && String(ask.message) === String(ref.message))
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
    this.pins.clear()
    for (const app of apps(this.state)) {
      const book = readJson(join(this.state, app, 'ledger.json'))
      this.ledgers.set(app, book?.asks ?? [])
      for (const [thread, pin] of Object.entries<any>(book?.pins ?? {})) if (pin.text) this.pins.set(`${app}:${thread}`, pin)
      for (const [thread, known] of Object.entries<any>(readJson(join(this.state, app, 'threads.json')) ?? {})) this.names.set(`${app}:${thread}`, known.name ?? thread)
    }
    this.links.load()
    this.result = readJson(join(this.state, 'voice', 'check.json'))
    this.notice()
    const used = new Set<string>()
    const curated = (this.result?.asks ?? []).flatMap((ask: Written) => {
      for (const ref of ask.refs ?? []) used.add(refId(ref))
      const live = ask.refs?.length ? ask.refs.some(ref => this.open(ref)) : !this.marks.answers[ask.id]
      return live ? [this.dress(ask)] : []
    })
    const raw = [...this.ledgers].flatMap(([app, asks]) =>
      asks.filter(ask => !ask.answer && !ask.settled && !used.has(refId({ app, ...ask }))).map(ask => this.dress(fromLedger(app, ask))),
    )
    raw.sort((a, b) => b.at.localeCompare(a.at))
    const checked = this.result?.at ?? ''
    const stuck = [...this.t3.stuck, ...(this.result?.stuck ?? []).map(item => ({ ...item, app: 'hex' }))]
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

  // A pinned post that changed or a T3 run that ended starts a check; the first read only takes note.
  private notice() {
    const now = {
      pins: JSON.stringify([...this.pins].map(([task, pin]) => [task, pin.text])),
      t3: JSON.stringify([this.t3.stuck, this.t3.fresh].map(items => items.map(item => item.id))),
    }
    const why = !this.seen ? undefined : now.pins !== this.seen.pins ? 'a pinned post changed' : now.t3 !== this.seen.t3 ? 'a T3 run ended' : undefined
    this.seen = now
    if (why) this.check(why)
  }

  private dress({ refs, from, options, links = [], places: _names, ...ask }: Written): Ask {
    const [app, ...thread] = ask.task.split(':')
    const pages = [...links, ...options.flatMap(({ label, url }) => (url ? [{ label, url }] : []))]
    return {
      ...ask,
      app: app!,
      topic: this.names.get(ask.task) ?? thread.at(-1)!,
      options: options.filter(option => !option.url),
      ...(pages.length && { links: pages }),
      places: this.places(from ?? [...(refs ?? []), { app: app!, thread: thread.join(':') }]),
    }
  }

  // Every place an ask was asked, newest first where it's known when; a thread named both with a
  // message and without is the message.
  private places(from: Source[]): Place[] {
    const messaged = new Set(from.filter(source => source.message !== undefined).map(source => `${source.app}:${source.thread}`))
    const seen = new Set<string>()
    return from
      .filter(source => {
        const key = source.call ? `call:${source.call}` : `${source.app}:${source.thread}:${source.message ?? ''}`
        const bare = !source.call && source.message === undefined && messaged.has(`${source.app}:${source.thread}`)
        if (bare || seen.has(key) || (!source.call && !source.thread)) return false
        seen.add(key)
        return true
      })
      .map(source => ({ source, at: this.when(source) }))
      .sort((a, b) => (b.at ?? '').localeCompare(a.at ?? ''))
      .map(({ source }) => (source.call ? this.call(source.call) : this.thread(source.app, source.thread!, source.message)))
  }

  private thread(app: string, thread: string, message?: MessageId): Place {
    const task = `${app}:${thread}`
    const place = app === 'telegram' && !thread.includes(':') ? (thread.startsWith('-') ? 'General' : 'DM') : (this.links.title(app, thread) ?? this.names.get(task) ?? thread)
    const link = this.links.of(app, thread, message)
    return { app, place, task, ...(link && { link }) }
  }

  private call(id: string): Place {
    return { app: 'voice', place: readJson(join(this.calls, `${id}.json`))?.title ?? 'a call', call: id }
  }

  private when({ app, thread, message, call }: Source) {
    if (call) return readJson(join(this.calls, `${call}.json`))?.started as string | undefined
    if (message === undefined) return
    const pin = this.pins.get(`${app}:${thread}`)
    if (pin && String(pin.message) === String(message)) return pin.at
    return this.asked({ app, thread: thread!, message })?.at
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
    from: [{ app, thread: asked.thread, message: asked.message }],
  }
}

export function refId({ app, thread, message }: Ref) {
  return `${app}:${thread}:${message}`
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
