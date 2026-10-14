import { connect } from 'net'
import { join } from 'path'

// One line to a hex app's hub, the way hex's own tools and sessions reach it.
export function relay(state: string, app: string, message: object) {
  const path = join(state, app, 'hub.sock')
  return new Promise<void>((resolve, reject) => {
    const socket = connect(path)
    socket.on('connect', () => socket.end(JSON.stringify(message) + '\n', resolve))
    socket.on('error', error => reject(new Error(`hex's hub isn't answering at ${path} (${error.message})`)))
  })
}
