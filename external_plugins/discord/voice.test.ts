import { expect, mock, test } from 'bun:test'
import { EventEmitter } from 'events'
import { PassThrough } from 'stream'
import OpusScript from 'opusscript'
import * as real from '@discordjs/voice'
import { engine } from '../../hub/hub.ts'

const OWNER = '2000'
const joined: { options: any; connection: any }[] = []
const resources: PassThrough[] = []
const player = { play: (resource: { stream: PassThrough }) => void resources.push(resource.stream) }

function connection() {
  const voice = new PassThrough({ objectMode: true })
  const emitter = Object.assign(new EventEmitter(), {
    state: { status: real.VoiceConnectionStatus.Ready as string },
    voice,
    subscribed: undefined as unknown,
    subscribe: (to: unknown) => void (emitter.subscribed = to),
    receiver: { subscribe: (user: string) => ((emitter as any).listening = user, voice) },
    destroy: () => {
      emitter.state.status = real.VoiceConnectionStatus.Destroyed
      emitter.emit(real.VoiceConnectionStatus.Destroyed)
    },
  })
  return emitter
}

mock.module('@discordjs/voice', () => ({
  ...real,
  joinVoiceChannel: (options: any) => {
    const made = connection()
    joined.push({ options, connection: made })
    return made
  },
  entersState: async () => {},
  createAudioPlayer: () => player,
  createAudioResource: (stream: PassThrough) => ({ stream }),
}))

const { narrow, widen, speaker, listener, voiceCalls } = await import('./voice.ts')

const pcm = (...samples: number[]) => {
  const buffer = Buffer.alloc(samples.length * 2)
  samples.forEach((sample, i) => buffer.writeInt16LE(sample, i * 2))
  return buffer
}
const samples = (buffer: Buffer) => Array.from({ length: buffer.length / 2 }, (_, i) => buffer.readInt16LE(i * 2))
const tick = (value: number) => pcm(...Array(2400).fill(value)).toString('base64')

async function until<T>(check: () => T | undefined, timeout = 3000): Promise<T> {
  for (const end = Date.now() + timeout; Date.now() < end; await Bun.sleep(10)) {
    const value = check()
    if (value) return value
  }
  throw new Error('timed out')
}

test('Discord\'s 48 kHz stereo becomes the engine\'s 24 kHz mono, and back, each new sample halfway to the next', () => {
  expect(samples(narrow(pcm(100, 300, 200, 200, -50, -150, 0, 0)))).toEqual([200, -50])
  expect(samples(widen(pcm(0, 100)))).toEqual([0, 0, 50, 50, 100, 100, 100, 100])
})

test('the voice plays in stretches of speech: silence before it is skipped, a short pause stays, and a long one ends the stretch', () => {
  resources.length = 0
  const play = speaker(player as any)
  play(tick(0))
  expect(resources).toHaveLength(0)
  play(tick(5000))
  expect(resources).toHaveLength(1)
  const stretch = resources[0]!
  const cushion = stretch.read(19200) as Buffer
  expect(samples(cushion).every(sample => sample === 0)).toBe(true)
  expect(samples(stretch.read() as Buffer).slice(0, 4)).toEqual([5000, 5000, 5000, 5000])
  for (let i = 0; i < 3; i++) play(tick(0))
  expect(stretch.writableEnded).toBe(false)
  play(tick(0))
  expect(stretch.writableEnded).toBe(true)
  play(tick(0))
  play(tick(4000))
  expect(resources).toHaveLength(2)
})

test('the owner\'s voice is decoded and sent on at 24 kHz, and quiet is sent as silence', async () => {
  const heard: Buffer[] = []
  const ear = listener(audio => void heard.push(Buffer.from(audio, 'base64')))
  const encoder = new OpusScript(48_000, 2, OpusScript.Application.VOIP)
  ear.packet(Buffer.from(encoder.encode(pcm(...Array(1920).fill(1000)), 960)))
  expect(heard[0]).toHaveLength(960)
  await until(() => heard.length > 1)
  expect(heard[1]).toHaveLength(4800)
  expect(samples(heard[1]!).every(sample => sample === 0)).toBe(true)
  ear.close()
  encoder.delete()
})

test('the owner joining a voice channel calls hex there through the call engine, and leaving hangs up and leaves', async () => {
  const handlers = new Map<string, (...args: any[]) => void>()
  const client = { on: (event: string, handler: (...args: any[]) => void) => handlers.set(event, handler) }
  const heard: string[] = []
  const calls: { greeting: string; line: any; hungUp: boolean }[] = []
  engine.take = (from, greeting, line) => {
    expect(from).toBe('discord')
    const call = { greeting, line, hungUp: false }
    calls.push(call)
    return { hear: audio => void heard.push(audio), hangUp: () => void (call.hungUp = true) }
  }
  voiceCalls(client as any, user => user === OWNER)
  const channel = { id: '6000', name: 'General', guild: { id: '3000', voiceAdapterCreator: () => ({}) } }
  const state = (channelId: string | null, id = OWNER) => ({ id, channelId, channel: channelId ? channel : null })

  handlers.get('voiceStateUpdate')!(state(null, '8888'), state('6000', '8888'))
  handlers.get('voiceStateUpdate')!(state(null), state('6000'))
  const call = await until(() => calls[0])
  expect(joined).toHaveLength(1)
  expect(joined[0]!.options).toMatchObject({ channelId: '6000', guildId: '3000', selfDeaf: false })
  expect(call.greeting).toBe('They joined you in the Discord voice channel General. Answer briefly, then listen.')
  const { connection } = joined[0]!
  expect(connection.listening).toBe(OWNER)
  expect(connection.subscribed).toBe(player)

  const encoder = new OpusScript(48_000, 2, OpusScript.Application.VOIP)
  connection.voice.write(Buffer.from(encoder.encode(pcm(...Array(1920).fill(800)), 960)))
  await until(() => heard.length)
  encoder.delete()

  handlers.get('voiceStateUpdate')!(state('6000'), state('6000'))
  expect(call.hungUp).toBe(false)
  handlers.get('voiceStateUpdate')!(state('6000'), state(null))
  expect(call.hungUp).toBe(true)
  expect(connection.state.status).toBe(real.VoiceConnectionStatus.Destroyed)

  handlers.get('voiceStateUpdate')!(state(null), state('6000'))
  const next = await until(() => calls[1])
  next.line.end()
  expect(joined[1]!.connection.state.status).toBe(real.VoiceConnectionStatus.Destroyed)
  delete engine.take
})
