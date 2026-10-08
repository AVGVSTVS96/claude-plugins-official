import { closeSync, fstatSync, mkdirSync, openSync, readSync, statSync, watch } from 'fs'
import { homedir } from 'os'
import { basename, dirname, join } from 'path'
import { stripLocalCommandMetadata, toAcpNotifications } from '@agentclientprotocol/claude-agent-acp'
import type { SessionNotification } from '@agentclientprotocol/sdk'

const PROJECTS = join(process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), '.claude'), 'projects')
const client = { sessionUpdate: async () => {} } as unknown as Parameters<typeof toAcpNotifications>[4]
const logger = { log: () => {}, error: (...args: unknown[]) => process.stderr.write(`t3 hub: transcript: ${args.join(' ')}\n`) }

export function transcriptPath(cwd: string, session: string) {
  return join(PROJECTS, cwd.replace(/[^a-zA-Z0-9]/g, '-'), `${session}.jsonl`)
}

// Streams one turn of a session's transcript as ACP session/update notifications,
// from where it ends now, or from its start when the session is new. Channel
// prompts are skipped: the client already shows what it sent. Claude Code writes
// the transcript in batches, so the Stop hook can run before the last reply is on
// disk; the turn ends at the transcript's own turn_duration after the prompt.
export function follow({ path, sessionId, cwd, fresh, emit, end }: {
  path: string
  sessionId: string
  cwd: string
  fresh: boolean
  emit: (notification: SessionNotification) => void
  end: () => void
}) {
  const tools = {}
  const tasks = new Map()
  let offset = fresh ? 0 : sizeOf(path)
  let rest = Buffer.alloc(0)
  let asked = false
  let ended = false

  mkdirSync(dirname(path), { recursive: true })
  const watcher = watch(dirname(path), (_, file) => file === basename(path) && read())
  read()

  function read() {
    if (ended) return
    let fd
    try {
      fd = openSync(path, 'r')
    } catch {
      return
    }
    try {
      const size = fstatSync(fd).size
      if (size <= offset) return
      const chunk = Buffer.alloc(size - offset)
      readSync(fd, chunk, 0, chunk.length, offset)
      offset = size
      const data = Buffer.concat([rest, chunk])
      const last = data.lastIndexOf(10)
      rest = data.subarray(last + 1)
      if (last >= 0) for (const line of data.subarray(0, last).toString('utf8').split('\n')) if (!ended) convert(line)
    } finally {
      closeSync(fd)
    }
  }

  function convert(line: string) {
    let entry
    try {
      entry = JSON.parse(line)
    } catch {
      return
    }
    if (entry.type === 'user' && entry.origin?.kind === 'channel') asked = true
    if (asked && entry.type === 'system' && entry.subtype === 'turn_duration') {
      ended = true
      watcher.close()
      return end()
    }
    if ((entry.type !== 'assistant' && entry.type !== 'user') || entry.isSidechain) return
    if (entry.type === 'user' && (entry.isMeta || entry.origin)) return
    const content = entry.type === 'user' ? stripLocalCommandMetadata(entry.message?.content) : entry.message?.content
    if (content == null) return
    const notifications = toAcpNotifications(content as any, entry.type, sessionId, tools, client, logger, {
      registerHooks: false,
      replay: true,
      cwd,
      taskState: tasks,
      messageId: entry.type === 'assistant' ? entry.message.id : entry.uuid,
      toolUseResult: entry.toolUseResult,
    })
    for (const notification of notifications) emit(notification)
  }

  return {
    close() {
      ended = true
      watcher.close()
    },
  }
}

function sizeOf(path: string) {
  try {
    return statSync(path).size
  } catch {
    return 0
  }
}
