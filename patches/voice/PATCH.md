---
format: patch-md/v0.1
id: voice
summary: Add a voice channel where OpenAI's gpt-live-1 holds a live call and hands every real request to the Claude Code session.
baseline: b8e53f1c05dff3b6d751297f6527990ffc81c2f4
patch_file: voice.patch
patch_sha256: c2f7b309962d1bfa91d1e2599fc971b81c50b5bb894d0e45980a07be0d0456b9
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
- `bot.ts` runs in the hub service (`hub/serve.ts`) and keeps one session,
  `voice`, always running as its main thread, so the call page is back as
  soon as the hub restarts it. That session's `server.ts` says hello on the
  hub socket, which also lets other sessions message it as `inbound`.
  `voice` is a fresh thread, and when a call ends `server.ts` sends the hub
  `renew`, so every call starts in a new session that reads the call chat.
- `dial` (the `phone` tool, or `POST /phone`) has Twilio ring a number; its
  TwiML comes from `/twilio/<one-time token>/twiml` (trial accounts can't pass
  TwiML inline) and streams the call to `wss://VOICE_PUBLIC_URL/twilio/<token>`. The plugin accepts only a token it issued, opens a `gpt-live-1`
  WebSocket session in `audio/pcmu` at 8 kHz, and passes Twilio's μ-law
  frames through both ways; the call is followed exactly like a page call.
- `POST /twilio/incoming` is the Twilio number's voice webhook: a call Twilio
  signed (`X-Twilio-Signature`) from `CALLER_NUMBER` gets a one-time token
  and streams the same way; any other call is rejected.
- When the call closes, pending handoffs and the last words reach Claude
  with a "call ended" message.
- Every call is saved as one record in `calls/` (turns, task changes, where
  it came from, Claude's title), served at `GET /calls` (long-polled with
  `?after=<version>`), `GET /calls/<id>` and `DELETE /calls/<id>`.
- Agent activity (`activity.ts`): a running task can name who does it, and
  the plugin follows that agent's Claude Code transcript as it is written
  (a file change, never a timer), converts each new assistant line to ACP
  `session/update` notifications with `@agentclientprotocol/claude-agent-acp`
  (as the Buzz and T3 plugins do), and keeps one plain line per task for its
  latest step. `task` takes `agent`, the agentId of the brain's own
  background subagent. `send` (only in hex, when `HEX_HUB` is set) delivers a
  message to another hex thread through that app's `state/<app>/hub.sock`
  with a one-off `voice_task` meta tag, puts it on the board, follows the
  thread's session from the line that carries the tag (and its background
  agents' transcripts), and marks the task done when a turn ends with none of
  those agents out, failed when it ends on an API error. A renewed session
  appears in `threads.json` and is followed from its start. Each call's
  session starts its own plugin, so on start the plugin resumes the last
  day's unfinished sends from their records, reading each thread from the
  start of its session to find the tagged message.
- `GET /activity?after=<version>` long-polls the live call's tasks, most
  recently changed first, each with its latest `line`, for the app's live
  line.

## Invariants

1. The voice model never gets tools: the session uses client delegation, so
   starting, steering and stopping work stays with Claude.
2. A transcript fragment that arrives late is still delivered, at its
   timeline position, in the next handoff.
3. The API key stays in the plugin; the page listens on loopback only.
4. Stays on `@modelcontextprotocol/sdk` 1.x, which Claude Code registers
   channels on.

## Verification

`bun test external_plugins/voice` covers transcript order, late fragments,
the board, call records, step lines, and following a sent message to done or
failed through fake transcripts. `scripts/verify` builds `server.ts`. A live check: start
`claude --channels plugin:voice@hex`, open the page, ask something that needs
the backend, and see a `<channel source="voice">` handoff arrive and its
`say` spoken.

## Removal

Delete when upstream ships an equivalent voice channel for Claude Code.
