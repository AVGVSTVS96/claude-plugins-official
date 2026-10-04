---
format: patch-md/v0.1
id: telegram-topics
summary: Rework the Telegram channel so every forum topic in a group is its own Claude Code session, through the thread hub.
baseline: d182ca456ca09d31d139f7d3818d1d333b103cce
patch_file: telegram-topics.patch
patch_sha256: f5abe8bfaf6a8f56df66e12c57537fd8be74ce36869bc1039f9eb8182d28ea20
---

## Intent

Split upstream's single-session `server.ts` in two, so one bot connection
serves a session per forum topic through `hub/`:

- `bot.ts` takes upstream's bot half: polling, the allowlist, attachments
  and the Telegram calls. It runs once as a service (`bun run bot`), embeds
  the hub, and maps each forum topic, or a plain chat, to a thread.
- `server.ts` keeps upstream's tools and instructions as the channel every
  session loads. It learns its thread from `ASSISTANT_THREAD`, connects to the
  hub, and forwards its calls there.

On top of upstream:

- `new_thread(title, prompt)` opens a topic with a fresh session. Titles are
  1–2 words, enforced.
- `close_thread` closes a topic and stops its session once it's idle.
- `reply` can post into another topic by name.
- The typing indicator follows the session's real busy state.
- DMs to the bot are forwarded into the main thread (`ASSISTANT_MAIN_THREAD`).
- A session that fails to start says why, in its topic.

## Invariants

1. One bot connection, owned by the service. Sessions never poll Telegram.
2. Tools act on the caller's own thread unless they name another one, so
   they take no `chat_id`.
3. Messages to a forum's General go without a topic id; only chat actions
   use topic 1, which Telegram needs to show typing inside General.
4. A session says hello a second after connecting: Claude Code starts
   listening for channel notifications about 30ms after its last request to
   the server and never signals it.
5. Deliberately dropped from upstream, never ported back: pairing and
   `/telegram:access` (single user; `access.json` holds `allowFrom`), bot
   commands, permission relay, and the `bot.pid` takeover.
6. Keep upstream's wording and structure wherever code is shared, so heals
   stay small.

## Verification

Both halves build and the hub tests pass. Run `scripts/verify`.

## Removal

Remove this patch when upstream's Telegram channel routes forum topics to
separate sessions on its own.
