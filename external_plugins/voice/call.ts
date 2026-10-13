export type Speaker = 'you' | 'voice'

export type Fragment = { who: Speaker; text: string; start: number; end: number }

export type Turn = { who: Speaker; text: string; start: number }

export type Task = { id: string; state: 'running' | 'done' | 'failed'; text: string; to?: string; agent?: string }

export type Moment = Task & { at: number }

export type Mark = { at: number; kind: 'say' | 'note' | 'paused' | 'resumed' | 'warned'; text: string }

export type Saved = { turns: { who: Speaker; at: number; text: string }[]; tasks: Moment[]; moments?: Mark[] }

const PAUSE = 2000

export class Call {
  private fragments: (Fragment & { sent?: true })[] = []
  private tasks = new Map<string, Task>()
  private moments: Moment[] = []
  private lines = new Map<string, string>()
  private recent: string[] = []
  private marks: Mark[] = []

  static resume({ turns, tasks, moments = [] }: Saved) {
    const call = new Call()
    call.fragments = turns.map(({ who, at, text }) => ({ who, text, start: at, end: at, sent: true }))
    for (const task of tasks) call.track(task, task.at)
    call.marks = [...moments]
    return call
  }

  hear(fragment: Fragment) {
    let i = this.fragments.length
    while (i > 0 && this.fragments[i - 1].start > fragment.start) i--
    this.fragments.splice(i, 0, fragment)
  }

  handOff(): Turn[] {
    const turns: Turn[] = []
    let joins = false
    for (const fragment of this.fragments) {
      if (fragment.sent) {
        joins = false
        continue
      }
      fragment.sent = true
      const last = turns.at(-1)
      if (joins && last?.who === fragment.who) last.text += fragment.text
      else turns.push({ who: fragment.who, text: fragment.text, start: fragment.start })
      joins = true
    }
    return tidy(turns)
  }

  track(task: Task, at = 0) {
    this.tasks.set(task.id, task)
    this.moments.push({ ...task, at })
    this.touch(task.id)
  }

  task(id: string) {
    return this.tasks.get(id)
  }

  see(id: string, line: string) {
    if (!this.tasks.has(id) || this.lines.get(id) === line) return false
    this.lines.set(id, line)
    this.touch(id)
    return true
  }

  activity() {
    return this.recent.map(id => ({ ...this.tasks.get(id)!, line: this.lines.get(id) }))
  }

  private touch(id: string) {
    this.recent = [id, ...this.recent.filter(other => other !== id)]
  }

  mark(mark: Mark) {
    this.marks.push(mark)
  }

  board(): string {
    if (!this.tasks.size) return 'Task board: nothing running or finished yet.'
    return ['Task board:', ...[...this.tasks.values()].map(task => `- ${task.id} ${task.state}: ${task.text}${task.to ? ` (sent to ${task.to})` : ''}`)].join('\n')
  }

  record() {
    const turns: (Turn & { end: number })[] = []
    for (const { who, text, start, end } of this.fragments) {
      const last = turns.findLast(turn => turn.who === who)
      if (last && start - last.end <= PAUSE) {
        last.text += text
        last.end = Math.max(last.end, end)
      } else turns.push({ who, text, start, end })
    }
    return {
      turns: tidy(turns.sort((a, b) => a.start - b.start)).map(({ who, start, text }) => ({ who, at: start, text })),
      tasks: [...this.moments],
      moments: [...this.marks],
    }
  }
}

function tidy<T extends Turn>(turns: T[]): T[] {
  return turns.map(turn => ({ ...turn, text: turn.text.trim() })).filter(turn => turn.text)
}

export function transcript(turns: Turn[]): string {
  return turns.map(({ who, text, start }) => `[${(start / 1000).toFixed(1)}s] ${who}: ${text}`).join('\n')
}
