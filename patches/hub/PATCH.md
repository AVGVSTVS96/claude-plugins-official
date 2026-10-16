---
format: patch-md/v0.1
id: hub
summary: Add a client-agnostic hub that gives every chat thread its own Claude Code session and moves threads between clients.
baseline: b8e53f1c05dff3b6d751297f6527990ffc81c2f4
patch_file: hub.patch
patch_sha256: dc5bdbde696cd4b14f71fc19175650e1d89b9510f917d899554eb144e454afd2
---

## Intent

Add `hub/`, a small library a chat client's bot process embeds so one bot
connection can serve many Claude Code sessions, one per chat thread.

`startHub` keeps the thread → session registry in `threads.json`, serves
each session's channel itself, and queues messages for a thread whose session
isn't running. It starts that session with
`claude --bg` through the client's launcher (`claude` unless one is given, so
hex can add its own plugins and flags), or resumes it with
`--resume`, and passes the channel, the thread, the socket path and the
channel's port through the session's `--settings` env. The launcher runs in the hex folder
without any `*_BOT_TOKEN`, `HEX_*` or `BUZZ_*` in its environment: Claude's
background daemon may start from it, and every later session inherits the
daemon's environment, so a thread's binding lives only in its `--settings`. It watches each start
through Claude's job record and reports a failed start with its reason.
Sessions report busy and idle through hooks that run `hub/state.ts`, and an
idle report says when the turn stopped with background agents or workflows still
working (the Stop hook's `background_tasks`; Claude Code counts those, not shells
or monitors, as the session working); the hub hands those to the client and stops a session that stays idle, unless
`claude agents --json` still reports it busy (background tasks outlive the
turn's Stop hook). Claude Code keeps a conversation in the prompt cache for an
hour and compacts a background session only when told to, so a session whose
last request (its transcript's newest usage or compaction) sent more than 150,000
tokens compacts before it stops, while its cache is warm: it starts again with
`/compact` as its only prompt, without showing as working, and stops at its next
rest. Otherwise its next message after the hour would write the whole
conversation to the cache again. A fresh thread, one on a call, and one leaving
never compact. A thread's session runs in the hex folder, or in a folder of
its own that the client opened it in; `threads.json` keeps that folder, so the
session resumes there and keeps it when it moves to another client. A failed
start is reported before the thread goes idle, so a client still waiting on the
start sees why. A client can open a thread with a prompt, close one (its
session stops once idle and the thread is forgotten), stop a thread's session
now (its next message resumes it), find threads by name, list them and rename them. `title` is the one rule
for thread names every client enforces: one word. `transcribe` turns a
recording into text through any OpenAI-compatible transcriptions endpoint set by
`TRANSCRIBE_URL` and `TRANSCRIBE_MODEL` (and `TRANSCRIBE_API_KEY` if it needs one),
and fetches nothing and returns nothing without them, so clients fall back to what they did before. A
local program can hand a thread a message over the socket (`inbound`), as if it
came from the app. A session's permission prompt (`permission_request`) reaches
the client with the session's thread, and the client's `answer` goes back to
that session alone (`permission`). A thread can have its own model and effort
(`configure`), kept in `threads.json` and passed as `--model` and `--effort`, and a
client can add launch arguments per thread, and more of a thread's binding to its
settings env (`bind`), under the hub's own. `threads.json` keeps a digest of what a
session started with, so a message to a session whose arguments changed goes to a
fresh start of it (a session busy with background work keeps running and takes it
as it is). A client can mark threads fresh: their launcher builds what a new
session knows of the chat (its settings env says `HEX_FRESH`), so a fresh thread
needs no compaction and never compacts. A fresh thread keeps one session running
and sends each message straight to it, so no message waits for a session to start,
while that session is worth it: its context (its last request) holds less than
`capacity` tokens, 350,000 unless the client or `HEX_CHAT_CAPACITY` sets
another, and its last request is younger than the cache's life (54 minutes, as
for the main thread, or a twelfth of that when the transcript shows the request
wrote the five-minute cache, an API key's default). Past that, its next message would send a full context, or
its whole context uncached, when a new session sends only the chat's view; so at
the session's rest, once its context fills (at the rest the Stop hook reports with
no agents working, since Claude's own status still says busy for about a second)
or at the moment its cache expires (timed from its last request in the
transcript), the hub stops it and starts a new
one at once, which then waits for the next message. A message that finds the
session spent while it still works, on its turn, a permission prompt or background
agents, reaches it as it is; one that finds it done goes to a new session. A
stopped fresh session is never resumed: a start rewrites the view and memory its
instruction files carry, so a resume would read nothing past the system prompt
from the cache and would hold the chat twice. A new session waits until its first
request before any of this counts. A fresh thread
never stops for being idle. With a `capacity` of 0 (the voice client), every
message that finds its session done goes to a new one. Messages
waiting for a new start keep their order. Each session's settings enable only its client's plugin.

A client hands `startHub` its channel (`server`: the instructions and tools
each session gets), and the hub serves it over MCP's Streamable HTTP on
`127.0.0.1`, one port for every client in the process (`HEX_PORT`, 8789 by
default) under the client's plugin name (`/telegram`). The client's plugin is
then only an `.mcp.json` of `"type": "http"` whose headers carry the session's
`HEX_CHANNEL` and `HEX_THREAD`, so no process runs per session: Claude Code
never restarts a stdio server that dies (anthropics/claude-code#43177), so a
`pkill -x bun` left General deaf and mute for a day, while it reconnects to
an HTTP one on its own. The hub declines `server/discover`, so Claude Code
settles on a revision whose stream can carry channel messages, and takes any
session id it's given, so a session that connected before the hub restarted
carries on without initializing again. A new session's stream opens a second
after it lists the tools, since Claude Code starts listening for channel
messages some tens of milliseconds after that, says nothing when it does, and
drops what comes before. A request with an `Origin` header or a host other
than localhost is refused, and a session with no thread (its env has none, or
another channel's) gets no messages and acts on no thread. A client with no
`server` keeps its plugin's own process, which reaches the hub on `hub.sock`
and says hello; sessions started before the hub served over HTTP do the same
until they next start.

A thread whose session runs needs its channel. When it drops, when the hub
starts, when a message finds its session running without one, and after a
start, the hub gives Claude Code 20 seconds to reconnect it (it retries a
dropped HTTP server at about 0, 1, 3, 7 and 15 seconds, then gives up for
good). After that, a session still running that started before then restarts
in place (`claude respawn`, which keeps its conversation and runs a turn it was
on again), one that started since gets the same time, and one that restarted
and still has no channel is reported as a failed start. A gone main thread
starts again, and a thread whose messages waited on a session that has since
ended resumes. The running session serving a thread is its current one, or one
Claude's job record shows was started for it (its `respawnFlags` keep the
settings env), so a session whose conversation isn't saved yet is waited for,
never started twice.

`tappable` turns `buzz://` links into web links through `open.html` on hex's
site, since chat apps only link web addresses.

The main thread is always running: the hub starts it (or resumes it) when it
starts, never stops it for being idle, and starts it again when its session
is gone. After 54 minutes idle, just before its cache
expires, a big main thread compacts the same way and keeps running. A client whose main thread is hex's General
says so (`general`), and only that session's settings env says `HEX_MAIN`, so
hex runs General's jobs in General alone, not in every client's main thread.
A session can ask to `renew`: at its next rest, once its Stop hook reports the
turn over with no background agents or workflows working (Claude's own status
lags the hook and counts a running shell as busy, so it isn't asked for a renew
the session asked for itself), the hub stops it, and a main thread or a fresh thread starts over as soon as its process exits
(a fresh thread as a new session); any other thread's next message resumes it. A session that connects to a hub
younger than it (Claude's `startedAt`) renews too, once Claude reports it idle, since it may run
code an update has since replaced (its hooks, and the tools and instructions its channel
gave it when it connected, which a reconnect keeps): an update restarts the hub, and each
session then moves onto the new code at its own next rest instead of all of
them waiting for a moment none is busy. Asking to `keep` before then cancels a
renew (a voice call started in the meantime), even while the hub is still
asking Claude whether the session is working. `renewal` resolves once a renew on
its way is through (the new session connects) or off, at once when none is, and
doesn't wait on one held up by background agents, so a client can hold a new
call for the new session. A fresh thread whose session outlived the hub (a
hub restart), saved or not, is left to reconnect instead of starting a new one, so it never
runs twice and a warm session is never left running unwatched.

`hub/serve.ts` is the service: it runs every client (Telegram, Discord,
Buzz, T3 Code) in one process. A thread is on a call from its `keep` until its
`renew` or until its session disconnects, and a voice call passes through this
process, so on SIGHUP the service exits once no thread is on a call (`free`), and
whatever runs it starts it again on the current code, inside Claude Code's
first retry, so sessions carry on where they were. Each chat client registers in `clients` with a `place` that opens a
thread, led by a line saying what it's for when one is given, which lets `move` hand a thread to another client: its session
stops once its turn ends (`release`) and resumes there with its memory
(`adopt`). The main thread never leaves, so a copy of it continues there
instead (`fork`, `--fork-session`).

## Invariants

1. The hub never stops the main thread unless it renews or compacts, and never moves or closes it.
   Nothing renews or compacts a session, or restarts the service, while its thread is on a call.
2. A session that is still running is never relaunched: one without its
   channel restarts in place, once. A stopped one has
   its job record cleared (`claude rm`) before `--resume`, which otherwise
   copies the conversation to a new id.
3. `--channels` comes right after `--bg`, so a prompt is never read as a
   channel.
4. Busy only counts prompts from a chat channel (`<channel source=`), so
   scheduled prompts never show as typing.
5. A moved session resumes only after its old session has disconnected, so
   one conversation never runs in two places.
6. No timer stands in for state: a start settles on the session's channel
   connecting or its job's `failed` state. The only delays are how long a
   quiet session stays warm before it's stopped, how long the main thread
   rests before its cache would expire, how long Claude Code takes to listen
   on a new channel, and how long it keeps reconnecting one before giving up;
   a fresh thread's session hands over when its cache's life, counted from its
   last request, runs out; Claude's own status decides whether a session is still working or running.
7. Bad input fails alone: a malformed line on `hub.sock` is logged and
   dropped, an unreadable `threads.json` is moved aside rather than
   overwritten, a malformed entry in it is dropped, and a launcher that
   can't run fails that start. None of them stop the service.
8. A thread takes a new session id only once Claude has saved that session's
   conversation, so a session that dies before then never leaves its thread
   resuming an id Claude can't find; it resumes its last saved one instead.

## Verification

`bun test hub` drives sessions over HTTP the way Claude Code connects (and a
plugin's own process on `hub.sock`): routing, queueing, resume, folders, running sessions, the main
thread (started with the hub, kept running, revived, `HEX_MAIN` only for General, renewed at once, a
fresh one left to reconnect after a hub restart), renews at the rest the Stop hook reports and after
background agents, `renewal` holding for the new session and not for agents or a keep,
sessions older than the hub renewing at their
next rest and never during a call, `free` waiting for calls to end, the launcher and its
environment, failed starts, busy and idle, idle stops, compacting big sessions before they rest, fresh threads (warm delivery, never resuming, the handover once the context
fills, even while Claude's status lags, or the cache expires, by its recorded tier, never compacting, a warm session from before a hub
restart found by its job instead of started twice), stopping, closing, naming and
handoffs (release, adopt, fork), permission prompts and bad input against a fake `claude`, plus
channels that drop and come back, sessions that restart in place once and are reported after,
sessions that outlived the hub, unsaved sessions found by their job, a new stream held until
Claude Code listens, a stream adopted after a restart, the declined protocol, refused requests
and unbound sessions. Run `scripts/verify`. Live: a session in an isolated `CLAUDE_CONFIG_DIR`
gets a message and replies, carries on through hub restarts (also a few seconds after it
connected and mid-turn), and restarts in place after a 35-second outage.

## Removal

Remove this patch when Claude Code routes one channel plugin's threads to
separate sessions on its own, so clients no longer need a hub.
