import { mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'fs'
import { join } from 'path'
import type { Mark, Moment, Speaker } from './call.ts'
import { Changes } from './changes.ts'

export type Source = 'app' | 'web' | 'phone-in' | 'phone-out'

export type Ending = 'you' | 'hex' | 'dropped' | 'expired' | 'no-connect' | 'no-answer' | 'busy'

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
  why?: string
  summary?: string
  waiting?: string[]
  expires?: string
  usage?: Usage
  turns: { who: Speaker; at: number; text: string }[]
  tasks: Moment[]
  moments?: Mark[]
}

export type CallSummary = Omit<CallRecord, 'turns' | 'tasks' | 'moments'> & { seconds: number; tasks: number; preview: string }

export type Usage = { seconds: number; dollars: number; context?: number }

export function usage(seconds: number, context?: number): Usage {
  return { seconds, dollars: Math.round(seconds * 5 / 60) / 100, ...(context === undefined ? {} : { context }) }
}

const ID = /^[\w-]+$/

export function ending(reason: string, by?: string): Ending {
  if (by?.startsWith('close_hex')) return 'hex'
  if (by?.startsWith('close-you') || reason === 'close_requested' || reason === 'remote_hangup') return 'you'
  if (reason === 'expired') return 'expired'
  if (reason === 'content') return 'hex'
  return 'dropped'
}

export class CallLog extends Changes {
  constructor(private dir: string) {
    super()
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

  private file(id: string) {
    return join(this.dir, `${id}.json`)
  }
}

export function summary({ turns, tasks, moments, ...call }: CallRecord): CallSummary {
  const heard = Math.max(0, ...turns.map(turn => turn.at), ...tasks.map(task => task.at))
  const ms = call.ended ? Date.parse(call.ended) - Date.parse(call.started) : heard
  return {
    ...call,
    seconds: Math.round(ms / 1000),
    tasks: new Set(tasks.map(task => task.id)).size,
    preview: turns.find(turn => turn.who === 'you')?.text.slice(0, 160) ?? '',
  }
}
