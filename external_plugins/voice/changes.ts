export class Changes {
  version = Date.now()
  private waiting = new Set<() => void>()
  private listeners = new Set<() => void>()

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

  listen(listener: () => void) {
    this.listeners.add(listener)
    return () => void this.listeners.delete(listener)
  }

  changed() {
    this.version = Math.max(this.version + 1, Date.now())
    for (const done of [...this.waiting, ...this.listeners]) done()
  }
}
