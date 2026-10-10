export type Speaker = 'you' | 'voice'

export type Fragment = { who: Speaker; text: string; start: number; end: number }

export type Turn = { who: Speaker; text: string; start: number }

export type Task = { id: string; state: 'running' | 'done' | 'failed'; text: string }

export class Call {
  private fragments: (Fragment & { sent?: true })[] = []
  private tasks = new Map<string, Task>()

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
    return turns.map(turn => ({ ...turn, text: turn.text.trim() })).filter(turn => turn.text)
  }

  track(task: Task) {
    this.tasks.set(task.id, task)
  }

  board(): string {
    if (!this.tasks.size) return 'Task board: nothing running or finished yet.'
    return ['Task board:', ...[...this.tasks.values()].map(task => `- ${task.id} ${task.state}: ${task.text}`)].join('\n')
  }
}

export function transcript(turns: Turn[]): string {
  return turns.map(({ who, text, start }) => `[${(start / 1000).toFixed(1)}s] ${who}: ${text}`).join('\n')
}
