import { connect } from 'net'

const { HEX_HUB, HEX_THREAD } = process.env

if (HEX_HUB && HEX_THREAD) {
  connect(HEX_HUB)
    .on('connect', function () {
      this.end(JSON.stringify({ type: 'fresh', thread: HEX_THREAD }) + '\n')
    })
    .on('error', () => {})
}
