import { Database } from 'bun:sqlite'
import { createHash } from 'crypto'
import { existsSync, watch } from 'fs'
import { homedir } from 'os'
import { basename, dirname, join } from 'path'

// app: where it's stuck, t3 or hex itself. request: what hex's General is asked to do about it; without one,
// the action just puts it away.
export type Stuck = { id: string; app: string; title: string; why: string; action: string; mark: 'paused' | 'failed'; at: string; request?: string }
// topic: the T3 project it finished in, or the thread's own title. where says the same as one line, for apps
// that still read it.
export type Fresh = { id: string; app: string; topic: string; title: string; where: string; line: string; at: string }

type Thread = { id: string; title: string; project: string | null; visited: string | null; limit: string | null; mine: boolean }
type Run = { thread: string; ordinal: number; status: string; requested: string; completed: string | null }

const DATABASE = join(homedir(), '.t3', 'userdata', 'statev2.sqlite')
const RECENT = 2 * 24 * 60 * 60_000
const QUEUED = 30 * 60_000

// T3 Code's own records, read only: which threads wait on a usage limit, have a run queued that
// never started, or ended in an error you haven't seen; and which of your threads finished since
// you last opened them. It reads again whenever T3 Code writes its database.
export class T3 {
  stuck: Stuck[] = []
  fresh: Fresh[] = []
  private db?: Database
  private pending?: ReturnType<typeof setTimeout>
  private watcher?: ReturnType<typeof watch>

  constructor(
    private changed: () => void,
    private path = DATABASE,
  ) {
    if (!existsSync(path)) return
    this.db = new Database(path, { readonly: true })
    this.watcher = watch(dirname(path), (_, file) => file?.startsWith(basename(path)) && this.schedule())
    this.read()
  }

  close() {
    clearTimeout(this.pending)
    this.watcher?.close()
    this.db?.close()
  }

  private schedule() {
    clearTimeout(this.pending)
    this.pending = setTimeout(() => this.read(), 500)
  }

  private read() {
    try {
      const { stuck, fresh } = this.query(Date.now())
      if (JSON.stringify({ stuck, fresh }) === JSON.stringify({ stuck: this.stuck, fresh: this.fresh })) return
      this.stuck = stuck
      this.fresh = fresh
      this.changed()
    } catch (error) {
      process.stderr.write(`voice: t3: couldn't read ${this.path}: ${error}\n`)
    }
  }

  query(now: number) {
    const db = this.db!
    const threads = new Map(
      db
        .query<Thread, []>(
          `select t.thread_id id, t.title, p.title project,
             json_extract(t.payload_json, '$.lastVisitedAt') visited,
             json_extract(t.payload_json, '$.limitRecovery.resetAt') "limit",
             json_extract(t.payload_json, '$.createdBy') = 'user' mine
           from orchestration_v2_projection_threads t left join projection_projects p using (project_id)
           where t.archived_at is null and t.deleted_at is null`,
        )
        .all()
        .map(thread => [thread.id, thread]),
    )
    const latest = db
      .query<Run, []>(
        `select r.thread_id thread, r.ordinal, r.status, r.requested_at requested, r.completed_at completed
         from orchestration_v2_projection_runs r
         join (select thread_id, max(ordinal) ordinal from orchestration_v2_projection_runs group by thread_id) m using (thread_id, ordinal)`,
      )
      .all()
    const queued = db
      .query<Run, []>(`select thread_id thread, min(requested_at) requested from orchestration_v2_projection_runs where status = 'queued' group by thread_id`)
      .all()
    const iso = new Date(now).toISOString()
    const recent = new Date(now - RECENT).toISOString()
    const stuck: Stuck[] = []

    const parked = [...threads.values()].filter(thread => thread.limit && thread.limit > iso)
    if (parked.length) {
      const until = parked.map(thread => thread.limit!).sort()[0]!
      stuck.push({
        id: `t3-limit-${until}`,
        app: 't3',
        title: `${count(parked.length, 'T3 thread')} ${parked.length === 1 ? 'waits' : 'wait'} for ${day(until)}`,
        why: `A usage limit: ${parked.map(thread => thread.title).join(', ')}.`,
        action: 'Switch plan',
        mark: 'paused',
        at: until,
        request: `These T3 Code threads are parked on a usage limit until ${day(until)}: ${parked.map(thread => `"${thread.title}"`).join(', ')}. Switch them to a plan with room so they carry on now.`,
      })
    }
    for (const run of queued) {
      const thread = threads.get(run.thread)
      if (!thread || thread.limit && thread.limit > iso || Date.parse(run.requested) > now - QUEUED) continue
      stuck.push({
        id: `t3-queued-${digest(`${run.thread}:${run.requested}`)}`,
        app: 't3',
        title: `${thread.title}: queued since ${day(run.requested)}`,
        why: 'Its run never started.',
        action: 'Resume',
        mark: 'paused',
        at: run.requested,
        request: `The T3 Code thread "${thread.title}" (${run.thread}) has had a run queued since ${run.requested} that never started. Get it going.`,
      })
    }
    const failed = latest.filter(run => {
      const thread = threads.get(run.thread)
      return thread && run.status === 'failed' && !(thread.limit && thread.limit > iso) && run.completed! > recent && run.completed! > (thread.visited ?? '')
    })
    if (failed.length) {
      const titles = failed.map(run => threads.get(run.thread)!.title)
      stuck.push({
        id: `t3-failed-${digest(failed.map(run => `${run.thread}:${run.ordinal}`).sort().join(','))}`,
        app: 't3',
        title: failed.length === 1 ? `${titles[0]} ended in an error` : `${failed.length} T3 runs ended in an error`,
        why: failed.length === 1 ? 'You haven’t opened it since.' : `${titles.join(', ')}.`,
        action: 'Look',
        mark: 'failed',
        at: failed.map(run => run.completed!).sort().at(-1)!,
        request: `These T3 Code runs ended in an error and nobody has looked since: ${failed.map(run => `"${threads.get(run.thread)!.title}" (${run.thread})`).join(', ')}. See whether their work landed anyway; settle the ones that did and get the rest going again.`,
      })
    }

    const fresh = latest
      .filter(run => {
        const thread = threads.get(run.thread)
        return thread?.mine && run.status === 'completed' && run.completed! > recent && run.completed! > (thread.visited ?? '')
      })
      .sort((a, b) => b.completed!.localeCompare(a.completed!))
      .map((run): Fresh => {
        const thread = threads.get(run.thread)!
        return {
          id: `t3-done-${digest(`${run.thread}:${run.ordinal}`)}`,
          app: 't3',
          topic: thread.project ?? thread.title,
          title: thread.title,
          where: thread.project ? `T3 · ${thread.project}` : 'T3',
          line: this.lastWords(run.thread),
          at: run.completed!,
        }
      })
    return { stuck, fresh }
  }

  // The thread's last answer, its first plain line.
  private lastWords(thread: string) {
    const row = this.db!
      .query<{ text: string | null }, [string]>(
        `select json_extract(payload_json, '$.text') text from orchestration_v2_projection_messages
         where thread_id = ? and role = 'assistant' order by created_at desc limit 1`,
      )
      .get(thread)
    const line = (row?.text ?? '')
      .split('\n')
      .map(line => line.replace(/^(#+|[-*>]|\d+\.)\s+/, '').replace(/\*\*|__|`/g, '').trim())
      .find(Boolean)
    return line ? (line.length > 200 ? `${line.slice(0, 199)}…` : line) : ''
  }
}

function digest(text: string) {
  return createHash('sha256').update(text).digest('hex').slice(0, 12)
}

function count(n: number, noun: string) {
  return `${n} ${noun}${n === 1 ? '' : 's'}`
}

function day(iso: string) {
  return new Date(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
}
