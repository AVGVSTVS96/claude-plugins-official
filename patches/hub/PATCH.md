---
format: patch-md/v0.1
id: hub
summary: Add a client-agnostic hub that gives every chat thread its own Claude Code session and moves threads between clients.
baseline: d4226d062928f8d9505dbdeadd10217d23361052
patch_file: hub.patch
patch_sha256: 76deacdde4d904a7f7765979f13006dcfad808347553a28de9c5f95f9c478d98
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
Sessions report busy and idle through hooks that run `hub/state.ts`; the
hub hands those to the client and stops a session that stays idle, unless
`claude agents --json` still reports it busy (background tasks outlive the
turn's Stop hook). A client can open a thread with a prompt, close one (its
session stops once idle and the thread is forgotten), stop a thread's session
now (its next message resumes it), find threads by name and rename them. Each session's settings enable only its client's plugin.

The main thread is always running: the hub starts it (or resumes it) when it
starts, never stops it for being idle, and starts it again when its session
has been gone for 30 seconds.

`hub/serve.ts` is the service: it runs every client (Telegram, Discord,
Buzz) in one process. Each client registers in `clients` with a `place` that opens an
empty thread, which lets `move` hand a thread to another client: its session
stops once its turn ends (`release`) and resumes there with its memory
(`adopt`). The main thread never leaves, so a copy of it continues there
instead (`fork`, `--fork-session`).

## Invariants

1. The hub never stops the main thread, and never moves or closes it.
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
   stays warm before it's stopped, and how long the main thread may be gone
   (a reconnect, a respawn) before it's started again; Claude's own status
   decides whether a session is still working or running.
7. Bad input fails alone: a malformed line on `hub.sock` is logged and
   dropped, an unreadable `threads.json` is moved aside rather than
   overwritten, a malformed entry in it is dropped, and a launcher that
   can't run fails that start. None of them stop the service.

## Verification

`bun test hub` drives routing, queueing, resume, running sessions, the main
thread (started with the hub, kept running, revived), the launcher and its
environment, failed starts, busy and idle, idle stops, stopping, closing, naming and
handoffs (release, adopt, fork) and bad input against a fake `claude`. Run `scripts/verify`.

## Removal

Remove this patch when Claude Code routes one channel plugin's threads to
separate sessions on its own, so clients no longer need a hub.
