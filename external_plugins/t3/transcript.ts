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
// prompts and slash commands are skipped: the client already shows what it sent.
// The turn ends when the session's work does: its Stop hook says no background
// agent is still working (done), and the transcript has caught up to that stop,
// a turn_duration after the prompt with no turn after it. Claude Code writes the
// transcript in batches, so the Stop hook can run before the last reply is on disk,
// and a background agent's result comes back as a turn of its own, streamed here
// too. A /compact turn ends at its compaction, or with its error.
export function follow({ path, sessionId, cwd, fresh, done, emit, end }: {
  path: string
  sessionId: string
  cwd: string
  fresh: boolean
  done: () => boolean
  emit: (notification: SessionNotification) => void
  end: (error?: string) => void
}) {
  const tools = {}
  const tasks = new Map()
  let offset = fresh ? 0 : sizeOf(path)
  let rest = Buffer.alloc(0)
  let asked = false
  let open = false
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
    if (entry.type === 'system' && entry.subtype === 'turn_duration') {
      open = false
      return settle()
    }
    if (entry.type === 'system' && entry.subtype === 'compact_boundary' && entry.compactMetadata?.trigger === 'manual') return stop()
    const failed = entry.type === 'system' && entry.subtype === 'local_command' && entry.content?.match(/<local-command-stderr>([\s\S]*)<\/local-command-stderr>/)?.[1]
    if (failed) return stop(failed)
    if ((entry.type !== 'assistant' && entry.type !== 'user') || entry.isSidechain) return
    open = true
    if (entry.type === 'user' && (entry.isMeta || entry.origin || /^\/\S/.test(entry.message?.content))) return
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

  function settle() {
    if (!ended && asked && !open && done()) stop()
  }

  function stop(error?: string) {
    ended = true
    watcher.close()
    end(error)
  }

  return {
    settle,
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
