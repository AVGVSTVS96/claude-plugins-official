import { mkdirSync } from 'fs'
import { join } from 'path'
import { engine, startHub } from '../../hub/hub.ts'
import { server } from './channel.ts'
import { serve, take, tool } from './server.ts'

const HEX_DIR = process.env.HEX_DIR ?? process.cwd()
const STATE = join(HEX_DIR, 'state')
const THREAD = 'voice'
const stateDir = process.env.VOICE_STATE_DIR ?? join(STATE, THREAD)
mkdirSync(stateDir, { recursive: true })

// One session, always running, takes every call: it stays warm for the whole call and starts
// over once the call ends, so each call gets a new session that reads the call chat.
const hub = startHub({
  stateDir,
  channel: process.env.VOICE_CHANNEL ?? 'plugin:voice@hex',
  server,
  main: THREAD,
  mainName: THREAD,
  hexDir: HEX_DIR,
  fresh: () => true,
  limits: { capacity: 0 },
  launcher: process.env.HEX_LAUNCHER,
  call: (_, name, args) => tool(name, args),
  state: () => {},
  failed: (_, reason) => process.stderr.write(`voice hub: the voice session couldn't start: ${reason}\n`),
})

serve(
  {
    deliver: (content, meta) => hub.deliver(THREAD, THREAD, { content, meta }),
    keep: () => hub.keep(THREAD),
    renew: () => hub.renew(THREAD),
    renewal: () => hub.renewal(THREAD),
    session: () => hub.session(THREAD),
  },
  STATE,
)

engine.take = take
