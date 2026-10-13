export type Speaker = 'you' | 'voice'

export type Fragment = { who: Speaker; text: string; start: number; end: number }

export type Turn = { who: Speaker; text: string; start: number }

export type Task = { id: string; state: 'running' | 'done' | 'failed'; text: string }

export type Moment = Task & { at: number }

const PAUSE = 2000

export class Call {
  private fragments: (Fragment & { sent?: true })[] = []
  private tasks = new Map<string, Task>()
  private moments: Moment[] = []

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
  }

  board(): string {
    if (!this.tasks.size) return 'Task board: nothing running or finished yet.'
    return ['Task board:', ...[...this.tasks.values()].map(task => `- ${task.id} ${task.state}: ${task.text}`)].join('\n')
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
    }
  }
}

function tidy<T extends Turn>(turns: T[]): T[] {
  return turns.map(turn => ({ ...turn, text: turn.text.trim() })).filter(turn => turn.text)
}

export function transcript(turns: Turn[]): string {
  return turns.map(({ who, text, start }) => `[${(start / 1000).toFixed(1)}s] ${who}: ${text}`).join('\n')
}
