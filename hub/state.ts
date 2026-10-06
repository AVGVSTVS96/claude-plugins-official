import { connect } from 'net'

const { HEX_HUB, HEX_THREAD } = process.env
const busy = process.argv[2] === 'busy'

async function fromChat() {
  const { prompt } = JSON.parse(await Bun.stdin.text())
  return typeof prompt === 'string' && prompt.startsWith('<channel source=')
}

if (HEX_HUB && HEX_THREAD && (!busy || (await fromChat()))) {
  connect(HEX_HUB)
    .on('connect', function () {
      this.end(JSON.stringify({ type: 'state', thread: HEX_THREAD, busy }) + '\n')
    })
    .on('error', () => {})
}
