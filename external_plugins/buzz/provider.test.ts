import { beforeEach, expect, test } from 'bun:test'
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, writeFileSync, chmodSync, statSync, existsSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { generateSecretKey, getPublicKey, nip19 } from 'nostr-tools'
import { info, respond } from './provider.ts'

// Buzz's crates/buzz-backend-kubernetes/tests/fixtures/provider-wire/deploy-full-launch.request.json,
// recorded from Desktop's real deploy payload builder.
const fixture = {
  op: 'deploy',
  request_id: 'req-6',
  agent: {
    agent_args: [],
    agent_command: 'goose',
    auth_tag: 'tag-1',
    env_vars: { USER_KEY: 'user-value' },
    idle_timeout_seconds: null,
    launch: {
      args: ['acp'],
      command: 'goose',
      env: { GOOSE_MODEL: 'gpt-5', GOOSE_PROVIDER: 'openai', USER_KEY: 'user-value' },
      owner_pubkey: 'a'.repeat(64),
      policy_env: {
        BUZZ_ACP_AGENTS: '10',
        BUZZ_ACP_DISPLAY_NAME: 'worker',
        BUZZ_ACP_LAZY_POOL: 'true',
        BUZZ_ACP_MODEL: 'gpt-5',
        BUZZ_ACP_RELAY_OBSERVER: 'true',
        BUZZ_ACP_SESSION_POLICY: 'channel',
        BUZZ_ACP_SESSION_TITLE: 'worker',
        GOOSE_MODE: 'auto',
      },
    },
    max_turn_duration_seconds: null,
    model: 'gpt-5',
    name: 'worker',
    parallelism: 10,
    private_key_nsec: 'nsec1vl029mgpspedva04g90vltkh6fvh240zqtv9k0t9af8935ke9laqsnlfe5',
    provider: 'openai',
    relay_url: 'wss://relay.example',
    respond_to: 'allowlist',
    respond_to_allowlist: ['a'.repeat(64), 'b'.repeat(64)],
    system_prompt: null,
    turn_timeout_seconds: 300,
  },
  provider_config: {
    namespace: 'buzz-agents-test',
    image: `ghcr.io/block/buzz-sprig@sha256:${'a'.repeat(64)}`,
    inactivity_seconds: 3600,
  },
}

const OWNER = getPublicKey(generateSecretKey())
const AUTH_TAG = JSON.stringify(['auth', OWNER, '', 'ab'.repeat(64)])

let dir: string
let home: string
let ssh: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'provider-'))
  home = join(dir, 'home', 'hex')
  fakeHex(home)
  ssh = join(dir, 'ssh')
  writeFileSync(ssh, `#!/bin/sh
jq -cn '$ARGS.positional' --args -- "$@" >> "${dir}/calls"
for last; do :; done
HOME="${join(dir, 'home')}" exec sh -c "$last"
`)
  chmodSync(ssh, 0o755)
})

function fakeHex(home: string) {
  mkdirSync(join(home, '.hex', 'bin'), { recursive: true })
  writeFileSync(join(home, '.hex', 'bin', 'hex'), `#!/bin/sh
echo "$@" >> "${dir}/restarts"
echo "hex started; its log is state/hub.log"
`)
  chmodSync(join(home, '.hex', 'bin', 'hex'), 0o755)
}

function request(config: object = { target: 'me@box', home }, agent: object = {}) {
  return JSON.stringify({ ...fixture, agent: { ...fixture.agent, auth_tag: AUTH_TAG, ...agent }, provider_config: config })
}

function run(input: string) {
  const result = Bun.spawnSync(['bun', join(import.meta.dir, 'provider.ts')], { stdin: new TextEncoder().encode(input) })
  return { code: result.exitCode, out: JSON.parse(result.stdout.toString()), err: result.stderr.toString() }
}

const envFile = () => join(home, 'state', 'buzz', '.env')
const mode = (path: string) => statSync(path).mode & 0o777
const lines = (file: string) => (existsSync(file) ? readFileSync(file, 'utf8').trim().split('\n') : [])

test('info has exactly the fields Desktop accepts', () => {
  const { code, out } = run('{"op":"info","request_id":"req-1"}')
  expect(code).toBe(0)
  expect(Object.keys(out).sort()).toEqual(['config_schema', 'description', 'name', 'ok', 'protocol_version', 'version'])
  expect(out.ok).toBe(true)
  expect(out.protocol_version).toBe(1)
  for (const field of ['name', 'version', 'description']) expect(out[field]).toBeString()
  for (const field of ['name', 'version', 'description']) expect(out[field]).not.toBe('')
  expect(out.config_schema.required).toEqual(['target'])
  expect(Object.keys(out.config_schema.properties)).toEqual(['target', 'home'])
  expect(out.config_schema.properties.target.default).toBeUndefined()
  expect(out.config_schema.properties.home.default).toBe('~/hex')
  expect(out).toEqual(info)
})

test('deploy writes the credentials over ssh stdin and restarts hex', () => {
  expect(respond(request(), ssh)).toEqual({ ok: true, agent_id: `me@box:${home}` })
  expect(readFileSync(envFile(), 'utf8')).toBe(
    `BUZZ_RELAY_URL=wss://relay.example\nBUZZ_PRIVATE_KEY=${fixture.agent.private_key_nsec}\nBUZZ_AUTH_TAG=${AUTH_TAG}\n`,
  )
  expect(mode(envFile())).toBe(0o600)
  expect(mode(join(home, 'state', 'buzz'))).toBe(0o700)
  expect(lines(join(dir, 'restarts'))).toEqual(['restart'])
  expect(lines(join(dir, 'calls')).map(line => JSON.parse(line))).toEqual([
    ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=10', 'me@box', 'sh -s'],
  ])
})

test('redeploys are idempotent and tighten a loose .env', () => {
  mkdirSync(join(home, 'state', 'buzz'), { recursive: true, mode: 0o755 })
  writeFileSync(envFile(), 'OLD=1\n', { mode: 0o644 })
  const first = respond(request(), ssh)
  const written = readFileSync(envFile(), 'utf8')
  expect(respond(request(), ssh)).toEqual(first)
  expect(readFileSync(envFile(), 'utf8')).toBe(written)
  expect(readdirSync(join(home, 'state', 'buzz'))).toEqual(['.env'])
  expect(mode(envFile())).toBe(0o600)
  expect(mode(join(home, 'state', 'buzz'))).toBe(0o700)
  expect(lines(join(dir, 'restarts'))).toEqual(['restart', 'restart'])
})

test('home defaults to ~/hex on the target', () => {
  expect(respond(request({ target: 'me@box' }), ssh)).toEqual({ ok: true, agent_id: 'me@box:~/hex' })
  expect(respond(request({ target: 'me@box', home: '' }), ssh)).toEqual({ ok: true, agent_id: 'me@box:~/hex' })
  expect(lines(join(dir, 'restarts'))).toEqual(['restart', 'restart'])
  expect(mode(envFile())).toBe(0o600)
})

test('a home with quotes and spaces is quoted for the remote shell', () => {
  const odd = join(dir, `it's "here" $HOME`, 'hex')
  fakeHex(odd)
  expect(respond(request({ target: 'me@box', home: odd }), ssh)).toEqual({ ok: true, agent_id: `me@box:${odd}` })
  expect(readFileSync(join(odd, 'state', 'buzz', '.env'), 'utf8')).toStartWith('BUZZ_RELAY_URL=wss://relay.example\n')
})

test('bad input is refused with ok:false and a non-zero exit', () => {
  const cases: [string, RegExp][] = [
    [JSON.stringify({ ...fixture, provider_config: { target: 'me@box', home } }), /auth_tag/],
    [request({ home }), /target/],
    [request({ target: '-oProxyCommand=touch /tmp/x', home }), /target/],
    [request(undefined, { auth_tag: JSON.stringify(['p', OWNER]) }), /auth_tag/],
    [request(undefined, { auth_tag: null }), /auth_tag/],
    [request(undefined, { private_key_nsec: nip19.npubEncode(OWNER) }), /private_key_nsec/],
    [request(undefined, { private_key_nsec: `${nip19.nsecEncode(generateSecretKey())}\nBUZZ_X=1` }), /private_key_nsec/],
    [request(undefined, { relay_url: 'https://relay.example' }), /relay_url/],
    [request(undefined, { relay_url: 'wss://relay.example\nBUZZ_X=1' }), /relay_url/],
    ['{"op":"undeploy"}', /unknown op/],
    ['not json', /./],
  ]
  for (const [input, error] of cases) {
    const { code, out, err } = run(input)
    expect(code).toBe(1)
    expect(Object.keys(out)).toEqual(['ok', 'error'])
    expect(out.ok).toBe(false)
    expect(out.error).toMatch(error)
    expect(err).toContain(out.error)
  }
  expect(existsSync(join(home, 'state'))).toBe(false)
})

test('a target without hex fails with the reason and writes nothing', () => {
  const nowhere = join(dir, 'nowhere')
  expect(() => respond(request({ target: 'me@box', home: nowhere }), ssh)).toThrow(`no hex at ${nowhere}/.hex/bin/hex`)
  expect(existsSync(nowhere)).toBe(false)
})
