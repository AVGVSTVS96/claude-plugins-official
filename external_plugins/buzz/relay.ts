import { finalizeEvent, getPublicKey, type Event } from 'nostr-tools/pure'
import type { Filter } from 'nostr-tools/filter'

export type Relay = {
  pubkey: string
  publish(event: { kind: number; content: string; tags: string[][]; created_at?: number }): Promise<Event>
  subscribe(filters: Filter[], onEvent: (event: Event) => void): () => void
  query(filters: Filter[]): Promise<Event[]>
  close(): void
}

type Request = { message: unknown[]; events?: Event[]; done: (error?: string) => void }

const TIMEOUT = 20_000
const PING = 30_000
const OVERLAP = 60

const now = () => Math.floor(Date.now() / 1000)

export function connectRelay({ url, secretKey, authTag }: { url: string; secretKey: Uint8Array; authTag: string[] }): Relay {
  const pubkey = getPublicKey(secretKey)
  const subs = new Map<string, { filters: Filter[]; onEvent: (event: Event) => void }>()
  const seen = new Set<string>()
  const requests = new Map<string, Request>()
  let socket: WebSocket | undefined
  let auth = ''
  let ready = false
  let closed = false
  let attempt = 0
  let alive = now()
  let answered = true
  let next = 0

  function send(message: unknown[]) {
    if (ready) socket!.send(JSON.stringify(message))
  }

  function sign(template: { kind: number; content: string; tags: string[][]; created_at?: number }) {
    return finalizeEvent({ created_at: now(), ...template, tags: [...template.tags, authTag] }, secretKey)
  }

  // Subscriptions start, or resume after a drop, from shortly before the
  // connection was last alive; an event seen once is never delivered again.
  function req(id: string, filters: Filter[]) {
    const since = alive - OVERLAP
    send(['REQ', id, ...filters.map(filter => (filter.since === undefined ? filter : { ...filter, since: Math.max(filter.since, since) }))])
  }

  function open() {
    const ws = (socket = new WebSocket(url))
    ws.addEventListener('message', ({ data }) => {
      if (ready) alive = now()
      answered = true
      try {
        handle(JSON.parse(String(data)))
      } catch (error) {
        process.stderr.write(`buzz hub: dropped a bad frame from the relay: ${error}\n`)
      }
    })
    ws.addEventListener('pong', () => (answered = true))
    ws.addEventListener('close', () => {
      if (socket !== ws) return
      socket = undefined
      ready = false
      if (closed) return
      const delay = Math.min(1000 * 2 ** attempt++, 30_000)
      process.stderr.write(`buzz hub: relay connection lost, reconnecting in ${delay / 1000}s\n`)
      setTimeout(open, delay)
    })
    ws.addEventListener('error', () => {})
  }

  function handle([type, id, ...rest]: any[]) {
    if (type === 'AUTH') {
      const event = sign({ kind: 22242, content: '', tags: [['relay', url], ['challenge', id]] })
      auth = event.id
      socket!.send(JSON.stringify(['AUTH', event]))
    }
    if (type === 'OK' && id === auth) {
      if (!rest[0]) {
        process.stderr.write(`buzz hub: relay refused auth: ${rest[1]}\n`)
        return socket!.close()
      }
      ready = true
      attempt = 0
      for (const [sub, { filters }] of subs) req(sub, filters)
      for (const request of requests.values()) send(request.message)
    }
    if (type === 'OK' && id !== auth) requests.get(id)?.done(rest[0] ? undefined : rest[1] || 'refused')
    if (type === 'EVENT') {
      const sub = subs.get(id)
      if (sub && !seen.has(rest[0].id)) {
        seen.add(rest[0].id)
        sub.onEvent(rest[0])
      }
      requests.get(id)?.events?.push(rest[0])
    }
    if (type === 'EOSE' && requests.has(id)) {
      send(['CLOSE', id])
      requests.get(id)!.done()
    }
    if (type === 'CLOSED') {
      if (requests.has(id)) requests.get(id)!.done(rest[0] || 'closed')
      else if (subs.has(id)) process.stderr.write(`buzz hub: relay closed a subscription: ${rest[0]}\n`)
    }
    if (type === 'NOTICE') process.stderr.write(`buzz hub: relay notice: ${id}\n`)
  }

  function request<T>(id: string, message: unknown[], result: (events: Event[]) => T, collect = false): Promise<T> {
    if (closed) return Promise.reject(new Error('the relay connection is closed'))
    return new Promise((resolve, reject) => {
      const events: Event[] = []
      const timer = setTimeout(() => done('timed out'), TIMEOUT)
      function done(error?: string) {
        clearTimeout(timer)
        requests.delete(id)
        if (error) reject(new Error(error))
        else resolve(result(events))
      }
      requests.set(id, { message, done, ...(collect ? { events } : {}) })
      send(message)
    })
  }

  const ping = setInterval(() => {
    if (!ready) return
    if (!answered) return socket!.terminate()
    answered = false
    socket!.ping()
  }, PING)

  open()

  return {
    pubkey,
    publish(template) {
      const event = sign(template)
      return request(event.id, ['EVENT', event], () => event)
    },
    subscribe(filters, onEvent) {
      const id = `s${++next}`
      subs.set(id, { filters, onEvent })
      req(id, filters)
      return () => {
        subs.delete(id)
        send(['CLOSE', id])
      }
    },
    query(filters) {
      const id = `q${++next}`
      return request(id, ['REQ', id, ...filters], events => [...new Map(events.map(event => [event.id, event])).values()], true)
    },
    close() {
      closed = true
      clearInterval(ping)
      for (const request of requests.values()) request.done('the relay connection is closed')
      socket?.close()
    },
  }
}
