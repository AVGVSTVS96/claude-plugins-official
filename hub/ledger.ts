import { readFileSync, renameSync, writeFileSync } from 'fs'

// via: where the answer came from: the chat app's own buttons, hex's voice app, or a call.
export type Answer = { label: string; at: string; via: string }
// Telegram numbers its messages; Discord's snowflakes outgrow a JavaScript number, so they stay strings.
export type MessageId = number | string
export type Ask = {
  thread: string
  message: MessageId
  text: string
  options: string[]
  at: string
  poll?: string
  // Asked with a menu where any number of options can be picked, so a reopen puts the menu back.
  multiple?: boolean
  answer?: Answer
  settled?: { note: string; at: string }
}
export type Pin = { message: MessageId; text: string; at: string }
type Book = { asks: Ask[]; pins: Record<string, Pin> }

const KEEP = 14 * 24 * 60 * 60_000

// Every question a client asked with buttons or a poll, and what became of it, plus each thread's
// pinned status post as last written. The client that sends and edits the messages keeps it, and
// anything else (the voice app's asks, hex's check) reads the file.
export class Ledger {
  private book: Book

  constructor(private file: string) {
    this.book = read(file)
  }

  get asks(): readonly Ask[] {
    return this.book.asks
  }

  pin(thread: string): Pin | undefined {
    return this.book.pins[thread]
  }

  find(thread: string, message: MessageId) {
    return this.book.asks.find(ask => ask.thread === thread && ask.message === message)
  }

  byPoll(poll: string) {
    return this.book.asks.find(ask => ask.poll === poll)
  }

  ask(thread: string, message: MessageId, text: string, options: string[], poll?: string, multiple = false) {
    this.book.asks.push({ thread, message, text, options, at: now(), ...(poll && { poll }), ...(multiple && { multiple }) })
    this.save()
  }

  answered(thread: string, message: MessageId, label: string, via: string) {
    this.update(thread, message, ask => {
      ask.answer = { label, at: now(), via }
      delete ask.settled
    })
  }

  settled(thread: string, message: MessageId, note: string) {
    this.update(thread, message, ask => (ask.settled = { note, at: now() }))
  }

  reopened(thread: string, message: MessageId) {
    this.update(thread, message, ask => {
      delete ask.answer
      delete ask.settled
    })
  }

  // A message's new text: a pinned post's latest status, or, for a question, the end of its
  // buttons, since an edit that doesn't send them again takes them off.
  edited(thread: string, message: MessageId, text: string) {
    const pin = this.book.pins[thread]
    if (pin?.message === message) {
      this.book.pins[thread] = { message, text, at: now() }
      return this.save()
    }
    const ask = this.find(thread, message)
    if (ask && !ask.answer && !ask.settled && !ask.poll) this.settled(thread, message, 'Edited')
  }

  pinned(thread: string, message: MessageId, text = '') {
    this.book.pins[thread] = { message, text, at: now() }
    this.save()
  }

  unpinned(thread: string, message: MessageId) {
    if (this.book.pins[thread]?.message !== message) return
    delete this.book.pins[thread]
    this.save()
  }

  deleted(thread: string, message: MessageId) {
    this.book.asks = this.book.asks.filter(ask => !(ask.thread === thread && ask.message === message))
    if (this.book.pins[thread]?.message === message) delete this.book.pins[thread]
    this.save()
  }

  forget(thread: string) {
    this.book.asks = this.book.asks.filter(ask => ask.thread !== thread)
    delete this.book.pins[thread]
    this.save()
  }

  private update(thread: string, message: MessageId, change: (ask: Ask) => void) {
    const ask = this.find(thread, message)
    if (!ask) return
    change(ask)
    this.save()
  }

  // Open questions stay however old they get; settled ones go after two weeks.
  private save() {
    const since = new Date(Date.now() - KEEP).toISOString()
    this.book.asks = this.book.asks.filter(ask => !(ask.answer || ask.settled) || ask.at > since)
    writeFileSync(`${this.file}.tmp`, JSON.stringify(this.book, null, 1) + '\n')
    renameSync(`${this.file}.tmp`, this.file)
  }
}

function read(file: string): Book {
  let text: string
  try {
    text = readFileSync(file, 'utf8')
  } catch {
    return { asks: [], pins: {} }
  }
  try {
    const book = JSON.parse(text)
    return { asks: Array.isArray(book.asks) ? book.asks : [], pins: book.pins ?? {} }
  } catch (error) {
    const aside = `${file}.corrupt-${Date.now()}`
    renameSync(file, aside)
    process.stderr.write(`hub: ${file} is unreadable (${error}), moved it to ${aside} and started a new ledger\n`)
    return { asks: [], pins: {} }
  }
}

function now() {
  return new Date().toISOString()
}
