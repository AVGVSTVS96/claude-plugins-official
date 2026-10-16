import { expect, test } from 'bun:test'
import { createHmac } from 'crypto'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

const CALLER = '+15550001111'
const TWILIO_TOKEN = 'twilio-secret'
const HOST = 'voice.test'

// A phone call end to end, with a stand-in for OpenAI's live API and a recorded-style Twilio
// media stream: the call engine runs on its own with a hub that takes everything, and the test
// plays the caller's phone.
async function phoneCall() {
  const home = mkdtempSync(join(tmpdir(), 'phone-'))
  const state = join(home, '.claude', 'channels', 'voice')
  mkdirSync(state, { recursive: true })
  const audio: string[] = []
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
        if (event.type === 'session.start') socket.send(JSON.stringify({ type: 'session.started', session: { id: 'sess_phone', expires_at: Date.now() / 1000 + 3600 } }))
        if (event.type === 'session.input_audio.append') audio.push(event.audio)
        if (event.type === 'session.close') socket.send(JSON.stringify({ type: 'session.closed', reason: 'close_requested', client_event_id: event.event_id }))
      },
    },
  })
  const port = 20000 + Math.floor(Math.random() * 20000)
  writeFileSync(
    join(state, '.env'),
    [`OPENAI_API_KEY=test`, `OPENAI_BASE_URL=http://127.0.0.1:${openai.port}/v1`, `VOICE_PORT=${port}`, `TWILIO_ACCOUNT_SID=AC1`, `TWILIO_AUTH_TOKEN=${TWILIO_TOKEN}`, `TWILIO_NUMBER=+15550002222`, `CALLER_NUMBER=${CALLER}`, `VOICE_PUBLIC_URL=${HOST}`].join('\n'),
  )
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^(VOICE|TWILIO|OPENAI|CALLER|HEX)_/.test(key)))
  const hex = join(home, 'hex', 'state')
  mkdirSync(hex, { recursive: true })
  // The hub's side, as lines on stdout; a renewal holds until the test writes a line to stdin.
  const engine = `import { serve } from ${JSON.stringify(join(import.meta.dir, 'server.ts'))}
const step = (step, more = {}) => console.log(JSON.stringify({ step, ...more }))
const lines = console[Symbol.asyncIterator]()
serve({
  deliver: (content, meta) => step('deliver', { content, meta }),
  keep: () => step('keep'),
  renew: () => step('renew'),
  renewal: async () => (step('renewal'), await lines.next()),
  session: () => 'brain',
}, ${JSON.stringify(hex)})`
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
  const base = `http://127.0.0.1:${port}`
  for (let i = 0; i < 100; i++) {
    if (await fetch(`${base}/calls`).then(r => r.ok, () => false)) break
    await Bun.sleep(50)
  }
  return {
    base,
    audio,
    steps,
    renewed: () => (plugin.stdin.write('renewed\n'), plugin.stdin.flush()),
    delegate: (id: string, offset_ms: number) => voice!.send(JSON.stringify({ type: 'session.delegation.created', delegation: { id, target: 'client' }, offset_ms })),
    say: (who: 'you' | 'voice', delta: string, start_ms: number) =>
      voice!.send(JSON.stringify({ type: who === 'you' ? 'session.input_transcript.delta' : 'session.output_transcript.delta', delta, start_ms, end_ms: start_ms + 300 })),
    [Symbol.asyncDispose]: async () => {
      plugin.kill()
      await plugin.exited
      openai.stop(true)
      rmSync(home, { recursive: true, force: true })
    },
  }
}

async function dialIn(base: string) {
  const form = new URLSearchParams({ From: CALLER, CallSid: 'CA1' })
  const signature = createHmac('sha1', TWILIO_TOKEN).update(`https://${HOST}/twilio/incoming${[...form.keys()].sort().map(key => key + form.get(key)).join('')}`).digest('base64')
  const twiml = await fetch(`${base}/twilio/incoming`, { method: 'POST', body: form, headers: { 'x-twilio-signature': signature } }).then(r => r.text())
  const [, token] = twiml.match(/\/twilio\/([\w-]+)"/)!
  const phone = new WebSocket(`${base.replace('http', 'ws')}/twilio/${token}`)
  await new Promise(resolve => (phone.onopen = resolve))
  phone.send(JSON.stringify({ event: 'start', start: { streamSid: 'MZ1' } }))
  return phone
}

async function live(base: string) {
  for (let i = 0; i < 100; i++) {
    const { live } = await fetch(`${base}/calls`).then(r => r.json())
    if (live) return live as string
    await Bun.sleep(50)
  }
  throw new Error('the phone call never went live')
}

test("a phone call's words reach the app as they're heard, and how it ended lands in its record", async () => {
  await using call = await phoneCall()
  const phone = await dialIn(call.base)
  const id = await live(call.base)
  expect(id).toBe('sess_phone')

  phone.send(JSON.stringify({ event: 'media', media: { payload: 'f39/fw==' } }))
  const first = await fetch(`${call.base}/calls/${id}`).then(r => r.json())
  expect(first).toMatchObject({ from: 'phone-in', turns: [] })
  expect(typeof first.version).toBe('number')

  const waiting = fetch(`${call.base}/calls/${id}?after=${first.version}`).then(r => r.json())
  await Bun.sleep(100)
  call.say('you', 'is the build ', 1000)
  const heard = await waiting
  expect(heard.turns).toEqual([{ who: 'you', at: 1000, text: 'is the build' }])
  expect(heard.version).toBeGreaterThan(first.version)

  call.say('you', 'green?', 1300)
  call.say('voice', 'One sec.', 2500)
  await Bun.sleep(100)
  const later = await fetch(`${call.base}/calls/${id}?after=${heard.version}`).then(r => r.json())
  expect(later.turns).toEqual([
    { who: 'you', at: 1000, text: 'is the build green?' },
    { who: 'voice', at: 2500, text: 'One sec.' },
  ])
  expect(call.audio).toEqual(['f39/fw=='])

  const ending = fetch(`${call.base}/calls/${id}?after=${later.version}`).then(r => r.json())
  phone.send(JSON.stringify({ event: 'stop' }))
  const ended = await ending
  expect(ended).toMatchObject({ id, from: 'phone-in', end: 'you' })
  expect(ended.ended).toBeString()
  expect(ended.version).toBeUndefined()
  expect(ended.turns).toHaveLength(2)
  expect((await fetch(`${call.base}/calls`).then(r => r.json())).live).toBeUndefined()
}, 20_000)

async function until<T>(check: () => T | undefined, timeout = 3000): Promise<T> {
  for (const end = Date.now() + timeout; Date.now() < end; await Bun.sleep(20)) {
    const value = check()
    if (value) return value
  }
  throw new Error('timed out')
}

test("a call's words reach the voice session only once the last call's renew is through, in order, and its end lets the session renew", async () => {
  await using call = await phoneCall()
  const phone = await dialIn(call.base)
  await live(call.base)
  await until(() => call.steps.find(step => step.step === 'renewal'))
  call.delegate('d1', 900)
  await Bun.sleep(50)
  call.say('you', 'is the build green?', 1000)
  await Bun.sleep(200)
  expect(call.steps.map(step => step.step)).toEqual(['renewal'])
  call.renewed()
  await until(() => call.steps.filter(step => step.step === 'deliver').length === 2)
  const [, keep, started, handoff] = call.steps
  expect(keep.step).toBe('keep')
  expect(started.content).toStartWith('A call started.')
  expect(handoff).toMatchObject({ content: expect.stringContaining('is the build green?'), meta: { delegation_id: 'd1' } })
  phone.send(JSON.stringify({ event: 'stop' }))
  await until(() => call.steps.at(-1)?.step === 'renew')
  expect(call.steps.at(-2).content).toStartWith('The call ended')
  const record = await fetch(`${call.base}/calls/sess_phone`).then(r => r.json())
  expect(record.claude).toBe('brain')
}, 20_000)
