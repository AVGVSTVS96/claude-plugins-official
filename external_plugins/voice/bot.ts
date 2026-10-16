import { mkdirSync } from 'fs'
import { join } from 'path'
import { startHub } from '../../hub/hub.ts'
import { door, voicePort } from './door.ts'

const HEX_DIR = process.env.HEX_DIR ?? process.cwd()
const STATE_DIR = process.env.VOICE_STATE_DIR ?? join(HEX_DIR, 'state', 'voice')
const SOCKET = join(STATE_DIR, 'http.sock')
mkdirSync(STATE_DIR, { recursive: true })

const hub = startHub({
  stateDir: STATE_DIR,
  channel: process.env.VOICE_CHANNEL ?? 'plugin:voice@hex',
  main: 'voice',
  mainName: 'voice',
  hexDir: HEX_DIR,
  fresh: () => true,
  limits: { capacity: 0 },
  bind: () => ({ VOICE_SOCKET: SOCKET }),
  launcher: process.env.HEX_LAUNCHER,
  call: async (_, tool) => {
    throw new Error(`unknown tool: ${tool}`)
  },
  state: () => {},
  failed: (_, reason) => process.stderr.write(`voice hub: the voice session couldn't start: ${reason}\n`),
})

door({ port: voicePort(), socket: SOCKET, renewal: () => hub.renewal('voice') })
