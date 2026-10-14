---
format: patch-md/v0.1
id: hub
summary: Add a client-agnostic hub that gives every chat thread its own Claude Code session and moves threads between clients.
baseline: b8e53f1c05dff3b6d751297f6527990ffc81c2f4
patch_file: hub.patch
patch_sha256: 5239fc19e7f62cf68ca22038db13c283915c875fd8f3f0d1071b1dfad8516441
---

## Intent

Add `hub/`, a small library a chat client's bot process embeds so one bot
connection can serve many Claude Code sessions, one per chat thread.

`startHub` keeps the thread → session registry in `threads.json`, listens
on `hub.sock` for each session's channel plugin, and queues messages for a
thread whose session isn't running. It starts that session with
`claude --bg` through the client's launcher (`claude` unless one is given, so
hex can add its own plugins and flags), or resumes it with
`--resume`, and passes the channel, the thread and the socket path through
the session's `--settings` env. The launcher runs in the hex folder
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
now (its next message resumes it), find threads by name and rename them. `title` is the one rule
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
as it is). A client can mark threads fresh: a fresh thread's session is never
resumed, so a message that finds its session done (Claude reports it idle and its
turn has ended) starts a new one, and a message while it still works, on its turn,
a permission prompt or background agents, reaches it as it is. Its settings env
says `HEX_FRESH`, so the launcher can build what the new session knows. Messages
waiting for a new start keep their order. Each session's settings enable only its client's plugin.

`tappable` turns `buzz://` links into web links through `open.html` on hex's
site, since chat apps only link web addresses.

The main thread is always running: the hub starts it (or resumes it) when it
starts, never stops it for being idle, and starts it again when its session
has been gone for 30 seconds. After 54 minutes idle, just before its cache
expires, a big main thread compacts the same way and keeps running. A client whose main thread is hex's General
says so (`general`), and only that session's settings env says `HEX_MAIN`, so
hex runs General's jobs in General alone, not in every client's main thread.
A session can ask to `renew`: at its next rest, once Claude reports it idle,
the hub stops it, and a main thread starts over as soon as its process exits,
as a new session for a fresh thread, without waiting out its 30 seconds; any
other thread's next message resumes it. A session that says hello to a hub
younger than it (Claude's `startedAt`) renews the same way, since it may run
code an update has since replaced: an update restarts the hub, and each
session then moves onto the new code at its own next rest instead of all of
them waiting for a moment none is busy. Asking to `keep` before then cancels a
renew (a voice call started in the meantime), even while the hub is still
asking Claude whether the session is working. A
fresh main thread whose session outlived the hub (a hub restart) gets the same
30 seconds to reconnect before a new one starts, so it never runs twice; any
running session under its name and folder counts, since a fresh session's id is
only saved once it has a conversation.

`hub/serve.ts` is the service: it runs every client (Telegram, Discord,
Buzz, T3 Code) in one process. A thread is on a call from its `keep` until its
`renew` or until its session disconnects, and a voice call passes through this
process, so on SIGHUP the service exits once no thread is on a call (`free`), and
whatever runs it starts it again on the current code. Each chat client registers in `clients` with a `place` that opens a
thread, led by a line saying what it's for when one is given, which lets `move` hand a thread to another client: its session
stops once its turn ends (`release`) and resumes there with its memory
(`adopt`). The main thread never leaves, so a copy of it continues there
instead (`fork`, `--fork-session`).

## Invariants

1. The hub never stops the main thread unless it renews or compacts, and never moves or closes it.
   Nothing renews or compacts a session, or restarts the service, while its thread is on a call.
2. A session that is still running is never relaunched. A stopped one has
   its job record cleared (`claude rm`) before `--resume`, which otherwise
   copies the conversation to a new id.
3. `--channels` comes right after `--bg`, so a prompt is never read as a
   channel.
4. Busy only counts prompts from a chat channel (`<channel source=`), so
   scheduled prompts never show as typing.
5. A moved session resumes only after its old session has disconnected, so
   one conversation never runs in two places.
6. No timer stands in for state: a start settles on the session's hello or
   its job's `failed` state. The only delays are how long a quiet session
   stays warm before it's stopped, how long the main thread rests before its
   cache would expire, and how long the main thread may be gone
   (a reconnect, a respawn) before it's started again; Claude's own status
   decides whether a session is still working or running.
7. Bad input fails alone: a malformed line on `hub.sock` is logged and
   dropped, an unreadable `threads.json` is moved aside rather than
   overwritten, a malformed entry in it is dropped, and a launcher that
   can't run fails that start. None of them stop the service.
8. A thread takes a new session id only once Claude has saved that session's
   conversation, so a session that dies before then never leaves its thread
   resuming an id Claude can't find; it resumes its last saved one instead.

## Verification

`bun test hub` drives routing, queueing, resume, folders, running sessions, the main
thread (started with the hub, kept running, revived, `HEX_MAIN` only for General, renewed at once, a
fresh one left to reconnect after a hub restart), sessions older than the hub renewing at their
next rest and never during a call, `free` waiting for calls to end, the launcher and its
environment, failed starts, busy and idle, idle stops, compacting big sessions before they rest, fresh threads, stopping, closing, naming and
handoffs (release, adopt, fork), permission prompts and bad input against a fake `claude`. Run `scripts/verify`.

## Removal

Remove this patch when Claude Code routes one channel plugin's threads to
separate sessions on its own, so clients no longer need a hub.
