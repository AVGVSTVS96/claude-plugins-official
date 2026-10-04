import { connect } from 'net'

const { ASSISTANT_HUB, ASSISTANT_THREAD } = process.env
const busy = process.argv[2] === 'busy'

async function fromChat() {
  const { prompt } = JSON.parse(await Bun.stdin.text())
  return typeof prompt === 'string' && prompt.startsWith('<channel source=')
}

if (ASSISTANT_HUB && ASSISTANT_THREAD && (!busy || (await fromChat()))) {
  connect(ASSISTANT_HUB)
    .on('connect', function () {
      this.end(JSON.stringify({ type: 'state', thread: ASSISTANT_THREAD, busy }) + '\n')
    })
    .on('error', () => {})
}
