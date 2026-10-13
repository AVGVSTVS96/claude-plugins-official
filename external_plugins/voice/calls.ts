import { mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'fs'
import { join } from 'path'
import type { Moment, Speaker } from './call.ts'

export type Source = 'app' | 'web' | 'phone-in' | 'phone-out'

export type Ending = 'you' | 'hex' | 'dropped' | 'no-connect' | 'no-answer'

export type CallRecord = {
  id: string
  started: string
  ended?: string
  end?: Ending
  reason?: string
  from: Source
  voice?: string
  title?: string
  claude?: string
  turns: { who: Speaker; at: number; text: string }[]
  tasks: Moment[]
}

export type CallSummary = Omit<CallRecord, 'turns' | 'tasks'> & { seconds: number; tasks: number; preview: string }

const ID = /^[\w-]+$/

export function ending(reason: string, by?: string): Ending {
  if (by?.startsWith('close-you') || reason === 'close_requested' || reason === 'remote_hangup') return 'you'
  if (reason === 'expired' || reason === 'content') return 'hex'
  return 'dropped'
}

export class CallLog {
  version = Date.now()
  private waiting = new Set<() => void>()

  constructor(private dir: string) {
    mkdirSync(dir, { recursive: true })
  }

  save(record: CallRecord) {
    const file = this.file(record.id)
    writeFileSync(`${file}.tmp`, JSON.stringify(record))
    renameSync(`${file}.tmp`, file)
    this.changed()
  }

  get(id: string): CallRecord | undefined {
    if (!ID.test(id)) return
    try {
      return JSON.parse(readFileSync(this.file(id), 'utf8'))
    } catch {}
  }

  delete(id: string) {
    if (!this.get(id)) return false
    rmSync(this.file(id))
    this.changed()
    return true
  }

  list(): CallSummary[] {
    return readdirSync(this.dir)
      .flatMap(name => {
        const record = name.endsWith('.json') && this.get(name.slice(0, -5))
        return record ? [summary(record)] : []
      })
      .sort((a, b) => b.started.localeCompare(a.started))
  }

  changes(after: number, wait: number) {
    if (after !== this.version) return Promise.resolve()
    return new Promise<void>(resolve => {
      const done = () => {
        clearTimeout(timer)
        this.waiting.delete(done)
        resolve()
      }
      const timer = setTimeout(done, wait)
      this.waiting.add(done)
    })
  }

  private changed() {
    this.version = Math.max(this.version + 1, Date.now())
    for (const done of [...this.waiting]) done()
  }

  private file(id: string) {
    return join(this.dir, `${id}.json`)
  }
}

export function summary({ turns, tasks, ...call }: CallRecord): CallSummary {
  const heard = Math.max(0, ...turns.map(turn => turn.at), ...tasks.map(task => task.at))
  const ms = call.ended ? Date.parse(call.ended) - Date.parse(call.started) : heard
  return {
    ...call,
    seconds: Math.round(ms / 1000),
    tasks: new Set(tasks.map(task => task.id)).size,
    preview: turns.find(turn => turn.who === 'you')?.text.slice(0, 160) ?? '',
  }
}
