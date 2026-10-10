---
format: patch-md/v0.1
id: voice
summary: Add a voice channel where OpenAI's gpt-live-1 holds a live call and hands every real request to the Claude Code session.
baseline: b8e53f1c05dff3b6d751297f6527990ffc81c2f4
patch_file: voice.patch
patch_sha256: b9de2b4cfed6547fa56dfc6545fb59ea65b0bfd5068f9213a45888df20720c8d
---

## Intent

Add `external_plugins/voice`, a channel for live voice calls. It works in
stock Claude Code and in the hub alike, because it is one plain channel
plugin with no hub code.

- `server.ts` serves a call page on `127.0.0.1` (`VOICE_PORT`, 8790 by
  default). The page's WebRTC offer goes to `POST /session`, which creates a
  `gpt-live-1` session in client delegation mode (`delegation: { type:
  "client" }`) with the key from `~/.claude/channels/voice/.env`, then
  attaches a sideband WebSocket to it.
- `call.ts` keeps the call's transcript: fragments from both speakers in
  `start_ms` order, grouped into turns by speaker, each fragment handed to
  Claude exactly once. It also keeps the task board.
- On `session.delegation.created` the plugin holds the handoff until a
  fragment that starts at or after its `offset_ms` arrives, then delivers
  every unsent turn as a channel message with `delegation_id` in its meta.
- Claude answers with `say` (`session.commentary.append`), `note`
  (`session.thinking.append`) and `task` (updates the board and sends it as
  `session.thinking.append` with no delegation id). Each tool resolves on
  OpenAI's matching `*.appended` acknowledgement, or fails with its `error`.
- When the call closes, pending handoffs and the last words reach Claude
  with a "call ended" message.

## Invariants

1. The voice model never gets tools: the session uses client delegation, so
   starting, steering and stopping work stays with Claude.
2. A transcript fragment that arrives late is still delivered, at its
   timeline position, in the next handoff.
3. The API key stays in the plugin; the page listens on loopback only.
4. Stays on `@modelcontextprotocol/sdk` 1.x, which Claude Code registers
   channels on.

## Verification

`bun test external_plugins/voice` covers transcript order, late fragments and
the board. `scripts/verify` builds `server.ts`. A live check: start
`claude --channels plugin:voice@hex`, open the page, ask something that needs
the backend, and see a `<channel source="voice">` handoff arrive and its
`say` spoken.

## Removal

Delete when upstream ships an equivalent voice channel for Claude Code.
