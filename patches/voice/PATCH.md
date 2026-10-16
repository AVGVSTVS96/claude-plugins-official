---
format: patch-md/v0.1
id: voice
summary: Add a voice channel where OpenAI's gpt-live-1 holds a live call and hands every real request to the Claude Code session.
baseline: b8e53f1c05dff3b6d751297f6527990ffc81c2f4
patch_file: voice.patch
patch_sha256: f326067bfce8bdc79687e28a359493820d291f9631bc5075004cc03feab25189
---

## Intent

Add `external_plugins/voice`, a channel for live voice calls. Its call engine
runs in hex's hub service, and the voice session reaches it over the hub's
HTTP channel, like every other client's sessions:

```
voice session ── HTTP ──► hub ──► call engine (server.ts) ◄── page, app, Twilio
```

- `channel.ts` is the channel the hub serves (its instructions and tools), and
  `.mcp.json` points the session at the hub's port with its thread and token, so
  no process runs per session: a session's process dying or restarting never
  takes the call engine with it. `env.ts` reads `~/.claude/channels/voice/.env`
  without putting it in the service's environment, so its keys never reach a
  session.
- `server.ts` is the call engine, started once with the service: it serves a call page on `127.0.0.1` (`VOICE_PORT`, 8790 by
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
  (`session.thinking.append`) and `task` (updates the board and sends the
  task that changed as `session.thinking.append` with no delegation id). Each
  tool resolves on OpenAI's matching `*.appended` acknowledgement, or fails
  with its `error`. `say`, `note`, `task` and `send` are marked
  `anthropic/alwaysLoad`, so a call never waits on a tool search for them.
- What the voice says first (a phone call's greeting, a topic the app started
  the call on) goes in the session's creation as a `developer` message in
  `session.input`, where GPT-Live has it before the caller speaks.
- `bot.ts` runs in the hub service (`hub/serve.ts`): it starts the hub for one
  session, `voice`, always running as its main thread, and then the engine,
  handing it the hub's side (`deliver`, `keep`, `renew`, `renewal`, `session`).
  A tool call from the session runs in the engine (`tool`). `voice` is a fresh
  thread with no capacity, so one session takes a whole call: the engine sends
  `keep` when a call starts and `renew` when it ends, every message between
  reaches that session however long it sits idle, and the next call starts in
  a new session that reads the call chat. Steps to the hub go one at a time, in
  order: a call that comes while the last call's session winds down to renew
  starts at once, and its words wait for the hub's `renewal` (the new session
  connecting) before its `keep`, so a caller who calls right back still gets a
  new session; a renew held up by background agents doesn't hold the call,
  which goes to the session there is. Other sessions and local programs reach
  `voice` as `inbound` on its `hub.sock`.
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
  background subagent. `send` delivers a
  message to another hex thread through that app's `state/<app>/hub.sock`
  with a one-off `voice_task` meta tag, puts it on the board, follows the
  thread's session from the line that carries the tag (and its background
  agents' transcripts), and marks the task done when a turn ends with none of
  those agents out, failed when it ends on an API error. A renewed session
  appears in `threads.json` and is followed from its start. When the service
  starts, the engine resumes the last day's unfinished sends from their records, reading each thread from the
  start of its session to find the tagged message.
- `GET /tasks` shows every hex thread as a task with a `link` that opens the
  thread in its own app (`links.ts`): a Telegram topic, General, or the bot for
  the DM; a Discord thread in the server named in the bot's `guild.json`; a
  Buzz message in the channel in the bot's `channels.json`, or the DM's channel;
  a T3 Code thread, found in T3's own database (`statev2.sqlite`, read only and
  read again when it changes) from the hex thread's key and opened by the app's URL scheme
  (`T3_APP_SCHEME`, `t3code` unless set). An app that can't say where a thread
  lives gives it no link.
- `GET /activity?after=<version>` long-polls the live call's tasks, most
  recently changed first, each with its latest `line`, for the app's live
  line.
- Calls that never connect are saved with no turns and Claude is told:
  `/session` refused by OpenAI, a phone session OpenAI refused, and placed
  phone calls Twilio reports (through a signed `StatusCallback` at
  `/twilio/status/<token>`) as busy, no-answer, failed, or picked up without
  the voice ever joining. `end` takes `no-connect`, `no-answer` and `busy`.
- When the sideband of a page or app call closes without `session.closed`,
  the engine reattaches to the session by id a few times before calling the
  call dropped; on start it reattaches to the latest call whose record has no
  end, sends Claude a "call resumed" message with the call so far, and closes
  out any other unended record as `dropped`, ending it like any other call: Claude
  is told to name it, and the hub gets `renew`. A new call sends the hub `keep`,
  which cancels a pending `renew`. The hub keeps both across its session's
  channel dropping and coming back, so the engine sends each once.
- Records keep Claude's exact `say` and `note` text as `moments`, plus
  `why` (from `phone`), `summary` and `waiting` (from `title`), `expires`
  and `usage` (billed seconds, dollars, context ratio from
  `session.usage.updated` and `session.closed`). Two minutes before
  `expires` the voice and Claude are told. `hang_up` closes the session with
  an `event_id` starting `close_hex` once the voice stops talking.
  `POST /calls/<id>/moments` records when the caller's phone took the audio
  and tells the voice to wait.
- With `VOICE_TOKEN` set, everything but the page and Twilio's routes needs
  `Authorization: Bearer <token>`; the page gets the token filled in only for
  requests that didn't come through a proxy.

## Invariants

1. The voice model never gets tools: the session uses client delegation, so
   starting, steering and stopping work stays with Claude.
2. A transcript fragment that arrives late is still delivered, at its
   timeline position, in the next handoff.
3. The API key stays in the engine, out of the service's environment; the
   page listens on loopback only.
4. A call's record is never left without an end once the engine has run again.
5. One call, one session: no message of a call goes to another session, and
   no call shares its session with the call before it.

## Verification

`bun test external_plugins/voice` covers transcript order, late fragments,
the board, call records, step lines, following a sent message to done or
failed through fake transcripts, and the engine against a fake hub and fake
OpenAI and Twilio (a phone call's words reaching the session only after the
last call's renew, in order, and its end asking for a renew). `bun test hub`
covers a call keeping one session and the next getting a new one.
`scripts/verify` builds `bot.ts` and checks `.mcp.json` is HTTP. Live: in an
isolated `CLAUDE_CONFIG_DIR`, through hex's launcher, a voice session gets a
call's handoffs over HTTP, keeps one session across the call's turns, carries
on through a hub restart with the call resumed, and the next call gets a new
session.

## Removal

Delete when upstream ships an equivalent voice channel for Claude Code.
