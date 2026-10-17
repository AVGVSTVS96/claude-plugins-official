import {
  joinVoiceChannel,
  createAudioPlayer,
  createAudioResource,
  entersState,
  EndBehaviorType,
  StreamType,
  VoiceConnectionStatus,
  type AudioPlayer,
} from '@discordjs/voice'
import OpusScript from 'opusscript'
import { PassThrough } from 'stream'
import type { Client, VoiceBasedChannel } from 'discord.js'
import { engine, type Held } from '../../hub/hub.ts'

// Discord's audio is 48 kHz stereo in 20 ms Opus frames; the call engine's is 24 kHz mono PCM.
const RATE = 48_000
const TICK = 100
const SILENCE = Buffer.alloc((24_000 * 2 * TICK) / 1000)
const CUSHION = Buffer.alloc((RATE * 4 * TICK) / 1000)
const PAUSE = 300
const QUIET = 64

// 48 kHz stereo to 24 kHz mono: each sample averages two frames of both channels.
export function narrow(pcm: Buffer): Buffer {
  const out = Buffer.alloc(pcm.length >> 2)
  for (let i = 0, o = 0; o < out.length; i += 8, o += 2) {
    out.writeInt16LE((pcm.readInt16LE(i) + pcm.readInt16LE(i + 2) + pcm.readInt16LE(i + 4) + pcm.readInt16LE(i + 6)) >> 2, o)
  }
  return out
}

// 24 kHz mono to 48 kHz stereo: each new sample sits halfway to the next.
export function widen(pcm: Buffer): Buffer {
  const samples = pcm.length >> 1
  const out = Buffer.alloc(samples * 8)
  for (let i = 0; i < samples; i++) {
    const sample = pcm.readInt16LE(i * 2)
    const between = (sample + (i + 1 < samples ? pcm.readInt16LE(i * 2 + 2) : sample)) >> 1
    out.writeInt16LE(sample, i * 8)
    out.writeInt16LE(sample, i * 8 + 2)
    out.writeInt16LE(between, i * 8 + 4)
    out.writeInt16LE(between, i * 8 + 6)
  }
  return out
}

function silent(pcm: Buffer): boolean {
  for (let i = 0; i < pcm.length; i += 2) if (Math.abs(pcm.readInt16LE(i)) > QUIET) return false
  return true
}

// The voice comes as one unbroken stream, its pauses as silence, and Discord shows the bot speaking
// for as long as it sends audio. So a pause longer than PAUSE ends a stretch of speech, and the next
// sound starts a new one behind a short cushion that absorbs the stream's jitter.
export function speaker(player: AudioPlayer) {
  let stretch: PassThrough | undefined
  let quiet = 0
  return (audio: string) => {
    const pcm = Buffer.from(audio, 'base64')
    quiet = silent(pcm) ? quiet + pcm.length / 48 : 0
    if (quiet > PAUSE) {
      stretch?.end()
      stretch = undefined
      return
    }
    if (!stretch && quiet) return
    if (!stretch) {
      stretch = new PassThrough()
      stretch.write(CUSHION)
      player.play(createAudioResource(stretch, { inputType: StreamType.Raw }))
    }
    stretch.write(widen(pcm))
  }
}

// The owner's voice, decoded as it comes. Discord sends nothing while they're quiet, but the voice
// model takes its turn on hearing silence, so every quiet TICK is sent as silence.
export function listener(hear: (audio: string) => void) {
  const decoder = new OpusScript(RATE, 2, OpusScript.Application.VOIP)
  let heard = Date.now()
  const quiet = setInterval(() => {
    if (Date.now() - heard < TICK) return
    heard = Date.now()
    hear(SILENCE.toString('base64'))
  }, TICK)
  return {
    packet(opus: Buffer) {
      heard = Date.now()
      try {
        hear(narrow(Buffer.from(decoder.decode(opus))).toString('base64'))
      } catch (err) {
        process.stderr.write(`discord hub: dropped a voice packet that wouldn't decode: ${err}\n`)
      }
    },
    close() {
      clearInterval(quiet)
      decoder.delete()
    },
  }
}

// The owner joining one of the server's voice channels calls hex there, through the voice app's
// call engine, like a phone call; leaving, or hex hanging up, ends it. One call at a time.
export function voiceCalls(client: Client, owner: (user: string) => boolean) {
  let current: { channel: string; end: () => void } | undefined

  async function call(channel: VoiceBasedChannel, user: string) {
    const take = engine.take
    if (!take) return void process.stderr.write('discord hub: the voice app isn\'t running, so a voice channel takes no calls\n')
    const connection = joinVoiceChannel({ channelId: channel.id, guildId: channel.guild.id, adapterCreator: channel.guild.voiceAdapterCreator, selfDeaf: false })
    let held: Held | undefined
    let ear: ReturnType<typeof listener> | undefined
    let voice: ReturnType<typeof connection.receiver.subscribe> | undefined
    let over = false
    const end = () => {
      if (over) return
      over = true
      if (current?.end === end) current = undefined
      held?.hangUp()
      voice?.destroy()
      ear?.close()
      if (connection.state.status !== VoiceConnectionStatus.Destroyed) connection.destroy()
    }
    current = { channel: channel.id, end }
    // A disconnect that is only a move or a region change starts signalling again on its own.
    connection.on(VoiceConnectionStatus.Disconnected, () => {
      Promise.race([entersState(connection, VoiceConnectionStatus.Signalling, 5_000), entersState(connection, VoiceConnectionStatus.Connecting, 5_000)]).catch(end)
    })
    connection.on(VoiceConnectionStatus.Destroyed, end)
    try {
      await entersState(connection, VoiceConnectionStatus.Ready, 20_000)
    } catch (err) {
      process.stderr.write(`discord hub: couldn't join #${channel.name}: ${err}\n`)
      return end()
    }
    if (over) return
    const player = createAudioPlayer({ behaviors: { maxMissedFrames: 50 } })
    connection.subscribe(player)
    try {
      held = take('discord', `They joined you in the Discord voice channel ${channel.name}. Answer briefly, then listen.`, { play: speaker(player), end })
    } catch (err) {
      process.stderr.write(`discord hub: ${err}\n`)
      return end()
    }
    ear = listener(held.hear)
    voice = connection.receiver.subscribe(user, { end: { behavior: EndBehaviorType.Manual } })
    voice.on('data', (opus: Buffer) => ear?.packet(opus))
    voice.on('error', err => process.stderr.write(`discord hub: voice receive failed: ${err}\n`))
    process.stderr.write(`discord hub: on a call in #${channel.name}\n`)
  }

  client.on('voiceStateUpdate', (before, after) => {
    if (!owner(after.id) || before.channelId === after.channelId) return
    if (current && current.channel === before.channelId) current.end()
    if (after.channel && !current) void call(after.channel, after.id).catch(err => process.stderr.write(`discord hub: voice call failed: ${err}\n`))
  })
}
