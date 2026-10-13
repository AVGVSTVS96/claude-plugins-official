import { expect, test } from 'bun:test'
import { Call, transcript } from './call.ts'

test('a handoff gets every turn since the last one, in timeline order', () => {
  const call = new Call()
  call.hear({ who: 'you', text: 'check if ', start: 1000, end: 1400 })
  call.hear({ who: 'you', text: 'the build passed', start: 1400, end: 2000 })
  call.hear({ who: 'voice', text: 'On it.', start: 2300, end: 2800 })
  expect(transcript(call.handOff())).toBe('[1.0s] you: check if the build passed\n[2.3s] voice: On it.')
  call.hear({ who: 'you', text: 'and the time?', start: 5000, end: 5600 })
  expect(call.handOff()).toEqual([{ who: 'you', text: 'and the time?', start: 5000 }])
})

test('a fragment that arrives late still reaches the next handoff, placed by its timestamp', () => {
  const call = new Call()
  call.hear({ who: 'voice', text: 'Sure.', start: 3000, end: 3300 })
  call.handOff()
  call.hear({ who: 'you', text: 'Thursday, not Friday', start: 2000, end: 2900 })
  call.hear({ who: 'you', text: 'please', start: 4000, end: 4300 })
  expect(transcript(call.handOff())).toBe('[2.0s] you: Thursday, not Friday\n[4.0s] you: please')
})

test('the board lists every task with its latest state', () => {
  const call = new Call()
  expect(call.board()).toBe('Task board: nothing running or finished yet.')
  call.track({ id: 'build', state: 'running', text: 'checking CI' })
  call.track({ id: 'build', state: 'done', text: 'CI is green' })
  call.track({ id: 'mail', state: 'running', text: 'drafting the reply' })
  expect(call.board()).toBe('Task board:\n- build done: CI is green\n- mail running: drafting the reply')
})

test('the record keeps the whole call, each speaker joined like the live captions, with every task change in time', () => {
  const call = new Call()
  call.hear({ who: 'you', text: 'check if ', start: 1000, end: 1400 })
  call.hear({ who: 'voice', text: 'Mm-hmm.', start: 1500, end: 1700 })
  call.hear({ who: 'you', text: 'the build passed', start: 1600, end: 2000 })
  call.handOff()
  call.hear({ who: 'voice', text: ' On it. ', start: 2300, end: 2800 })
  call.hear({ who: 'you', text: 'thanks', start: 9000, end: 9400 })
  call.track({ id: 'build', state: 'running', text: 'checking CI' }, 2500)
  call.track({ id: 'build', state: 'done', text: 'CI is green' }, 8000)
  expect(call.record()).toEqual({
    turns: [
      { who: 'you', at: 1000, text: 'check if the build passed' },
      { who: 'voice', at: 1500, text: 'Mm-hmm. On it.' },
      { who: 'you', at: 9000, text: 'thanks' },
    ],
    tasks: [
      { id: 'build', state: 'running', text: 'checking CI', at: 2500 },
      { id: 'build', state: 'done', text: 'CI is green', at: 8000 },
    ],
  })
})
