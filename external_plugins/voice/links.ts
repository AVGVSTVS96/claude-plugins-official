import { Database } from 'bun:sqlite'
import { existsSync, readFileSync, watch } from 'fs'
import { homedir } from 'os'
import { join } from 'path'

const T3_HOME = join(homedir(), '.t3', 'userdata')
const DATABASE = 'statev2.sqlite'
const REFRESH = 500

// Where a hex thread lives in its own app. Each bot leaves what its links need in its state folder
// (Discord's server, Telegram's bot name, the channel of every Buzz thread), and T3 Code's own database,
// read only, says which T3 thread a hex thread is and what it's called there. An app that can't say gives no link.
// T3_APP_SCHEME is the T3 Code app's URL scheme: t3code, t3code-preview or t3code-dev.
export class Links {
  private guild?: string
  private bot?: string
  private channels: Record<string, string> = {}
  private threads = new Map<string, { thread: string; title: string }>()
  private environment?: string
  private db?: Database
  private watcher?: ReturnType<typeof watch>
  private pending?: ReturnType<typeof setTimeout>

  constructor(
    private state: string,
    private changed: () => void,
    private t3 = T3_HOME,
    private scheme = process.env.T3_APP_SCHEME || 't3code',
  ) {
    const database = join(t3, DATABASE)
    if (!existsSync(database)) return
    this.environment = word(readFile(join(t3, 'environment-id'))?.trim())
    this.db = new Database(database, { readonly: true })
    this.watcher = watch(t3, (_, file) => file?.startsWith(DATABASE) && this.schedule())
    this.read()
  }

  close() {
    clearTimeout(this.pending)
    this.watcher?.close()
    this.db?.close()
  }

  // The small files the bots keep; read again whenever the threads are.
  load() {
    this.guild = word(readJson(join(this.state, 'discord', 'guild.json'))?.id)
    this.bot = word(readJson(join(this.state, 'telegram', 'bot.json'))?.username)
    this.channels = readJson(join(this.state, 'buzz', 'channels.json')) ?? {}
  }

  of(app: string, id: string): string | undefined {
    switch (app) {
      case 'telegram': {
        if (!id.includes(':') && !id.startsWith('-')) return this.bot && `https://t.me/${this.bot}`
        if (!id.startsWith('-100')) return
        const [chat, topic = '1'] = id.slice(4).split(':')
        return `https://t.me/c/${chat}/${topic}`
      }
      case 'discord':
        return this.guild && `https://discord.com/channels/${this.guild}/${id}`
      case 'buzz': {
        if (id.includes('-')) return `buzz://channel/${id}`
        const channel = word(this.channels[id])
        return channel && `buzz://message?channel=${channel}&id=${id}`
      }
      case 't3': {
        const thread = this.threads.get(id)?.thread
        return thread && this.environment && `${this.scheme}://threads/${this.environment}/${encodeURIComponent(thread)}`
      }
    }
  }

  // What the thread is called in its own app, where hex knows it by another name: T3 Code's title.
  title(app: string, id: string): string | undefined {
    return app === 't3' ? word(this.threads.get(id)?.title) : undefined
  }

  private schedule() {
    if (this.pending) return
    this.pending = setTimeout(() => {
      this.pending = undefined
      if (this.read()) this.changed()
    }, REFRESH)
  }

  // A hex thread's key is the session id the T3 Code ACP agent holds as its native thread.
  private read() {
    try {
      const rows = this.db!
        .query<{ key: string; thread: string; title: string }, []>(
          `select json_extract(p.payload_json, '$.nativeThreadRef.nativeId') key, json_extract(p.payload_json, '$.appThreadId') thread, t.title
           from orchestration_v2_projection_provider_threads p
           join orchestration_v2_projection_threads t on t.thread_id = json_extract(p.payload_json, '$.appThreadId')
           where p.driver = 'acpRegistry' and t.deleted_at is null
           order by p.updated_at`,
        )
        .all()
      const threads = new Map(rows.map(({ key, thread, title }) => [key, { thread, title }]))
      if (JSON.stringify([...threads]) === JSON.stringify([...this.threads])) return false
      this.threads = threads
      return true
    } catch (error) {
      process.stderr.write(`voice: links: couldn't read T3 Code's threads: ${error}\n`)
      return false
    }
  }
}

function word(value: unknown) {
  return typeof value === 'string' && value ? value : undefined
}

function readFile(path: string) {
  try {
    return readFileSync(path, 'utf8')
  } catch {}
}

function readJson(path: string) {
  try {
    return JSON.parse(readFile(path) ?? '')
  } catch {}
}
