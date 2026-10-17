import { expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

// A call on a line another client holds (a Discord voice channel), end to end against a stand-in
// for OpenAI's live API: the engine runs on its own with a hub that takes everything, and the test
// plays the client holding the line, through lines on the engine's stdin and stdout.
async function lineCall() {
  const home = mkdtempSync(join(tmpdir(), 'line-'))
  const state = join(home, '.claude', 'channels', 'voice')
  mkdirSync(state, { recursive: true })
  const heard: string[] = []
  const started: any[] = []
  let voice: Bun.ServerWebSocket<unknown> | undefined
  const openai = Bun.serve({
    port: 0,
    fetch: (request, server) => (server.upgrade(request) ? undefined : new Response('no', { status: 400 })),
    websocket: {
      open: socket => {
        voice = socket
      },
      message(socket, raw) {
        const event = JSON.parse(String(raw))
        if (event.type === 'session.start') {
          started.push(event.session)
          socket.send(JSON.stringify({ type: 'session.started', session: { id: 'sess_discord', expires_at: Date.now() / 1000 + 3600 } }))
        }
        if (event.type === 'session.input_audio.append') heard.push(event.audio)
        if (event.type === 'session.thinking.append') socket.send(JSON.stringify({ type: 'session.thinking.appended', client_event_id: event.event_id }))
        if (event.type === 'session.close') socket.send(JSON.stringify({ type: 'session.closed', reason: 'close_requested', client_event_id: event.event_id }))
      },
    },
  })
  const port = 20000 + Math.floor(Math.random() * 20000)
  writeFileSync(join(state, '.env'), [`OPENAI_API_KEY=test`, `OPENAI_BASE_URL=http://127.0.0.1:${openai.port}/v1`, `VOICE_PORT=${port}`].join('\n'))
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^(VOICE|TWILIO|OPENAI|CALLER|HEX)_/.test(key)))
  const hex = join(home, 'hex', 'state')
  mkdirSync(join(hex, 'discord'), { recursive: true })
  const engine = `import { serve, take, tool } from ${JSON.stringify(join(import.meta.dir, 'server.ts'))}
import { clients } from ${JSON.stringify(join(import.meta.dir, '..', '..', 'hub', 'hub.ts'))}
const step = (step, more = {}) => console.log(JSON.stringify({ step, ...more }))
clients.set('discord', {
  hub: { register: () => {}, deliver: (thread, name, message) => step('delivered', { thread, name, message }) },
  place: async (name, where, about) => (step('placed', { name, where, about }), { thread: '9001', link: 'https://discord.com/channels/1/9001' }),
})
serve({
  deliver: (content, meta) => step('deliver', { content, meta }),
  keep: () => step('keep'),
  renew: () => step('renew'),
  renewal: async () => {},
  session: () => 'brain',
}, ${JSON.stringify(hex)})
const held = take('discord', 'They joined you in a Discord voice channel.', { play: audio => step('play', { audio }), end: () => step('end') })
for await (const line of console) {
  const [verb, audio] = line.split(' ')
  if (verb === 'hear') held.hear(audio)
  if (verb === 'hangup') held.hangUp()
  if (verb === 'send') tool('send', JSON.parse(line.slice(5))).then(text => step('sent', { text }), error => step('sent', { error: error.message }))
}`
  const plugin = Bun.spawn(['bun', '-e', engine], { env: { ...env, HOME: home }, stdin: 'pipe', stdout: 'pipe', stderr: 'ignore' })
  const steps: any[] = []
  void (async () => {
    let buffer = ''
    for await (const chunk of plugin.stdout) {
      buffer += new TextDecoder().decode(chunk)
      const lines = buffer.split('\n')
      buffer = lines.pop()!
      steps.push(...lines.map(line => JSON.parse(line)))
    }
  })()
  return {
    base: `http://127.0.0.1:${port}`,
    heard,
    started,
    steps,
    tell: (line: string) => (plugin.stdin.write(`${line}\n`), plugin.stdin.flush()),
    speak: (audio: string) => voice!.send(JSON.stringify({ type: 'session.output_audio.delta', delta: audio })),
    [Symbol.asyncDispose]: async () => {
      plugin.kill()
      await plugin.exited
      openai.stop(true)
      rmSync(home, { recursive: true, force: true })
    },
  }
}

async function until<T>(check: () => T | undefined, timeout = 5000): Promise<T> {
  for (const end = Date.now() + timeout; Date.now() < end; await Bun.sleep(20)) {
    const value = check()
    if (value) return value
  }
  throw new Error('timed out')
}

test("a call on another client's line is held like a phone call: PCM both ways, the voice session told, a record of its own, and the line ended when the caller hangs up", async () => {
  await using call = await lineCall()
  const session = await until(() => call.started[0])
  expect(session.audio.format).toEqual({ type: 'audio/pcm', rate: 24000 })
  expect(session.input[0].content[0].text).toBe('They joined you in a Discord voice channel.')

  await until(() => call.steps.find(step => step.step === 'keep'))
  expect(call.steps.find(step => step.step === 'deliver').content).toStartWith('A call started.')
  call.tell('hear AAAA')
  await until(() => call.heard.length)
  expect(call.heard).toEqual(['AAAA'])
  call.speak('BBBB')
  expect(await until(() => call.steps.find(step => step.step === 'play'))).toEqual({ step: 'play', audio: 'BBBB' })
  expect((await fetch(`${call.base}/calls`).then(r => r.json())).live).toBe('sess_discord')

  call.tell(`send ${JSON.stringify({ thread: 'Anchors', about: 'the anchors', text: 'look into the anchors', app: 'discord' })}`)
  expect(await until(() => call.steps.find(step => step.step === 'sent'))).toEqual({ step: 'sent', text: 'opened Anchors in discord, on the board as the-anchors' })
  expect(call.steps.find(step => step.step === 'placed')).toEqual({ step: 'placed', name: 'Anchors', about: 'From a call: the anchors' })
  expect(call.steps.find(step => step.step === 'delivered')).toEqual({
    step: 'delivered',
    thread: '9001',
    name: 'Anchors',
    message: { content: 'look into the anchors', meta: { user: 'hex voice', voice_task: 'sess_discord:the-anchors' } },
  })

  call.tell('hangup')
  await until(() => call.steps.find(step => step.step === 'end'))
  await until(() => call.steps.find(step => step.step === 'renew'))
  const record = await fetch(`${call.base}/calls/sess_discord`).then(r => r.json())
  expect(record).toMatchObject({ id: 'sess_discord', from: 'discord', end: 'you', claude: 'brain' })
}, 20_000)
