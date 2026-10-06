#!/usr/bin/env bun
import { nip19 } from 'nostr-tools'
import { version } from './package.json'

export const info = {
  ok: true,
  name: 'hex',
  version,
  protocol_version: 1,
  description: 'Runs the agent as Hex on a machine you reach over SSH',
  config_schema: {
    type: 'object',
    properties: {
      target: { type: 'string', title: 'SSH destination', description: 'The machine Hex runs on, as you would pass it to ssh, e.g. user@host' },
      home: { type: 'string', title: 'Hex folder', description: 'Your hex folder on that machine', default: '~/hex' },
    },
    required: ['target'],
  },
}

type Agent = { relay_url?: unknown; private_key_nsec?: unknown; auth_tag?: unknown }
type Config = { target?: unknown; home?: unknown }

export function respond(input: string, ssh = '/usr/bin/ssh'): object {
  const request = JSON.parse(input)
  if (request.op === 'info') return info
  if (request.op === 'deploy') return { ok: true, agent_id: deploy(request.agent ?? {}, request.provider_config ?? {}, ssh) }
  throw new Error(`unknown op ${JSON.stringify(request.op)}`)
}

function deploy(agent: Agent, config: Config, ssh: string): string {
  const { relay_url, private_key_nsec, auth_tag } = agent
  if (typeof relay_url !== 'string' || !/^wss?:\/\/\S+$/.test(relay_url)) throw new Error('agent.relay_url must be a ws:// or wss:// URL')
  if (typeof private_key_nsec !== 'string' || !isNsec(private_key_nsec)) throw new Error('agent.private_key_nsec must be an nsec')
  const tag = authTag(auth_tag)
  const target = config.target
  if (typeof target !== 'string' || !/^[^-\s]\S*$/.test(target)) throw new Error('provider_config.target must be an ssh destination, e.g. user@host')
  const home = typeof config.home === 'string' && config.home.trim() ? config.home.trim() : '~/hex'
  if (/[\n\r]/.test(home)) throw new Error('provider_config.home must be one line')

  const script = `set -eu
home=${remotePath(home)}
hex="$home/.hex/bin/hex"
[ -x "$hex" ] || { echo "no hex at $hex" >&2; exit 1; }
umask 077
mkdir -p "$home/state/buzz"
chmod 700 "$home/state/buzz"
tmp=$(mktemp "$home/state/buzz/.env.XXXXXX")
cat > "$tmp" <<'EOF'
BUZZ_RELAY_URL=${relay_url}
BUZZ_PRIVATE_KEY=${private_key_nsec}
BUZZ_AUTH_TAG=${JSON.stringify(tag)}
EOF
chmod 600 "$tmp"
mv -f "$tmp" "$home/state/buzz/.env"
"$hex" restart </dev/null
`
  const result = Bun.spawnSync([ssh, '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=10', target, 'sh -s'], {
    stdin: new TextEncoder().encode(script),
  })
  if (result.exitCode !== 0) {
    const reason = result.stderr.toString().trim() || `ssh exited with ${result.exitCode}`
    throw new Error(`deploying to ${target}:${home} failed: ${reason}`)
  }
  return `${target}:${home}`
}

function isNsec(value: string): boolean {
  try {
    return nip19.decode(value).type === 'nsec'
  } catch {
    return false
  }
}

function authTag(value: unknown): string[] {
  let tag: unknown
  try {
    tag = JSON.parse(String(value))
  } catch {}
  if (!Array.isArray(tag) || tag.length !== 4 || tag[0] !== 'auth' || !tag.every(part => typeof part === 'string') || !/^[0-9a-f]{64}$/.test(tag[1])) {
    throw new Error('agent.auth_tag must be a JSON ["auth", owner, conditions, sig] tag')
  }
  return tag
}

function remotePath(path: string): string {
  const quote = (s: string) => `'${s.replaceAll("'", `'\\''`)}'`
  if (path === '~') return '"$HOME"'
  if (path.startsWith('~/')) return `"$HOME"/${quote(path.slice(2))}`
  return quote(path)
}

if (import.meta.main) {
  try {
    console.log(JSON.stringify(respond(await Bun.stdin.text())))
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err)
    console.log(JSON.stringify({ ok: false, error }))
    console.error(`buzz-backend-hex: ${error}`)
    process.exit(1)
  }
}
