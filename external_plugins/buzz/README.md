# Buzz

A channel for [Buzz](https://github.com/block/buzz), where every Buzz thread is its own Claude Code session, Claude-tag style: tag the agent in a channel and it starts a thread on your message, with a fresh session working inside it. Inside a thread, or in a DM, you just talk. It works with any Buzz relay, no Buzz changes needed. Its intent, invariants and design live in [`patches/buzz-threads/PATCH.md`](../../patches/buzz-threads/PATCH.md).

- `bot.ts` holds the one relay connection (`relay.ts`). It runs in the hub service (`bun hub/serve.ts`) next to Telegram and Discord, so a conversation can move between them. It starts sessions in `HEX_DIR` through `HEX_LAUNCHER`, like Discord.
- `server.ts` is the channel each session loads. A session learns its thread and its hub from `HEX_THREAD` and `HEX_HUB`.
- `activity.ts` and `memory.ts` fill Buzz Desktop's activity and memory panels, and share files with Agent Files where the relay supports it.
- `provider.ts` is `buzz-backend-hex`, the Buzz Desktop provider that deploys the agent's key here over SSH.

The agent's credentials live in `~/.claude/channels/hex/buzz/.env` (or `BUZZ_STATE_DIR`) as `BUZZ_RELAY_URL`, `BUZZ_PRIVATE_KEY` and `BUZZ_AUTH_TAG`; the provider writes them. `access.json` there can hold `allowFrom` (pubkeys allowed to talk to it; default: the owner in the auth tag), `channel` (where handoffs open; default `general`), `share` (files shared through Agent Files; default `AGENTS.md`, `SOUL.md`, `MEMORY.md` and `schedules.json`) and `"panels": false` to turn the panels off.
