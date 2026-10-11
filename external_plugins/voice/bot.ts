import { mkdirSync } from 'fs'
import { join } from 'path'
import { startHub } from '../../hub/hub.ts'

const HEX_DIR = process.env.HEX_DIR ?? process.cwd()
const STATE_DIR = process.env.VOICE_STATE_DIR ?? join(HEX_DIR, 'state', 'voice')
mkdirSync(STATE_DIR, { recursive: true })

startHub({
  stateDir: STATE_DIR,
  channel: process.env.VOICE_CHANNEL ?? 'plugin:voice@hex',
  main: 'voice',
  mainName: 'voice',
  hexDir: HEX_DIR,
  launcher: process.env.HEX_LAUNCHER,
  call: async (_, tool) => {
    throw new Error(`unknown tool: ${tool}`)
  },
  state: () => {},
  failed: (_, reason) => process.stderr.write(`voice hub: the voice session couldn't start: ${reason}\n`),
})
