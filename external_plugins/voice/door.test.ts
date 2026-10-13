import { expect, test } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { door, voicePort } from './door.ts'

function scratch() {
  const dir = mkdtempSync(join(tmpdir(), 'door-'))
  const socket = join(dir, 'http.sock')
  const servers: { stop: (force?: boolean) => unknown }[] = []
  const plugin = (handler: Parameters<typeof Bun.serve>[0]) => {
    rmSync(socket, { force: true })
    const server = Bun.serve({ ...handler, unix: socket } as Parameters<typeof Bun.serve>[0])
    servers.push(server)
    return server
  }
  return {
    dir,
    socket,
    plugin,
    servers,
    [Symbol.dispose]: () => {
      for (const server of servers) server.stop(true)
      rmSync(dir, { recursive: true, force: true })
    },
  }
}

const echo = {
  async fetch(request: Request) {
    const { pathname, search } = new URL(request.url)
    return Response.json({ method: request.method, path: pathname + search, body: await request.text(), auth: request.headers.get('authorization'), forwarded: request.headers.get('x-forwarded-for') })
  },
}

test('a request goes on to the plugin as it came, and its answer comes back', async () => {
  using s = scratch()
  s.plugin(echo)
  const front = door({ port: 0, socket: s.socket })!
  s.servers.push(front)
  const response = await fetch(`http://127.0.0.1:${front.port}/session?x=1`, {
    method: 'POST',
    headers: { authorization: 'Bearer t', 'x-forwarded-for': '100.64.0.2' },
    body: '{"sdp":"v=0"}',
  })
  expect(await response.json()).toEqual({ method: 'POST', path: '/session?x=1', body: '{"sdp":"v=0"}', auth: 'Bearer t', forwarded: '100.64.0.2' })
})

test('a request made while the plugin restarts waits for it, past the socket the old one left behind', async () => {
  using s = scratch()
  writeFileSync(s.socket, '')
  const front = door({ port: 0, socket: s.socket })!
  s.servers.push(front)
  const asked = Date.now()
  const answer = fetch(`http://127.0.0.1:${front.port}/session`, { method: 'POST', body: 'offer' })
  await Bun.sleep(300)
  s.plugin(echo)
  const response = await answer
  expect(response.status).toBe(200)
  expect((await response.json()).body).toBe('offer')
  expect(Date.now() - asked).toBeLessThan(2000)
})

test('with no plugin by the time the wait is up, the answer says so', async () => {
  using s = scratch()
  const front = door({ port: 0, socket: s.socket, wait: 200 })!
  s.servers.push(front)
  const response = await fetch(`http://127.0.0.1:${front.port}/calls`)
  expect(response.status).toBe(503)
})

test("a websocket (a phone call's audio) goes through both ways, and closes with the plugin's end", async () => {
  using s = scratch()
  s.plugin({
    fetch: (request, server) => (server.upgrade(request, { data: new URL(request.url).pathname }) ? undefined : new Response('no', { status: 400 })),
    websocket: { message: (ws, message) => (message === 'bye' ? ws.close() : ws.send(`${ws.data} heard ${message}`)) },
  } as Parameters<typeof Bun.serve>[0])
  const front = door({ port: 0, socket: s.socket })!
  s.servers.push(front)
  const ws = new WebSocket(`ws://127.0.0.1:${front.port}/twilio/abc`)
  const heard = new Promise<string>(resolve => (ws.onmessage = ({ data }) => resolve(String(data))))
  ws.onopen = () => ws.send('hello')
  expect(await heard).toBe('/twilio/abc heard hello')
  const closed = new Promise(resolve => (ws.onclose = resolve))
  ws.send('bye')
  await closed
})

test('a port still held by an old plugin is taken once the new plugin comes up', async () => {
  using s = scratch()
  const old = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: () => new Response('old') })
  const { port } = old
  expect(door({ port, socket: s.socket })).toBeUndefined()
  old.stop(true)
  s.plugin(echo)
  await Bun.sleep(100)
  expect((await (await fetch(`http://127.0.0.1:${port}/calls`)).json()).path).toBe('/calls')
})

test("the door's port is the plugin's: VOICE_PORT from the environment, then from its .env, then 8790", () => {
  using s = scratch()
  const env = join(s.dir, '.env')
  const before = process.env.VOICE_PORT
  delete process.env.VOICE_PORT
  expect(voicePort(env)).toBe(8790)
  writeFileSync(env, 'OPENAI_API_KEY=sk-1\nVOICE_PORT = 8801\n')
  expect(voicePort(env)).toBe(8801)
  process.env.VOICE_PORT = '8802'
  expect(voicePort(env)).toBe(8802)
  if (before === undefined) delete process.env.VOICE_PORT
  else process.env.VOICE_PORT = before
})
