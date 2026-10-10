#!/usr/bin/env bun
import { connect } from 'net'

// T3 Code starts this as its ACP agent; the agent itself runs in the hub service.
const path = process.argv[2]
if (!path) {
  process.stderr.write('usage: acp.ts <path to the t3 hub acp.sock>\n')
  process.exit(2)
}

const socket = connect(path)
socket.on('connect', () => {
  process.stdin.pipe(socket)
  socket.pipe(process.stdout)
})
socket.on('error', error => {
  process.stderr.write(`hex acp: can't reach hex at ${path} (${error.message}). Is hex running?\n`)
  process.exit(1)
})
socket.on('close', () => process.exit(0))
