---
format: patch-md/v0.1
id: thread-hub
summary: Add a client-agnostic hub that gives every chat thread its own Claude Code session and moves threads between clients.
baseline: d182ca456ca09d31d139f7d3818d1d333b103cce
patch_file: thread-hub.patch
patch_sha256: bb69525fbcc978b98c2108115af90569fc2e2f09b26b207feaf389bbb36d23c2
---

## Intent

Add `hub/`, a small library a chat client's bot process embeds so one bot
connection can serve many Claude Code sessions, one per chat thread.

`startHub` keeps the thread → session registry in `threads.json`, listens
on `hub.sock` for each session's channel plugin, and queues messages for a
thread whose session isn't running. It starts that session with
`claude --bg`, or resumes it with `--resume`, and passes the thread and the
socket path through the session's `--settings` env. It watches each start
through Claude's job record and reports a failed start with its reason.
Sessions report busy and idle through hooks that run `hub/state.ts`; the
hub hands those to the client and stops a session that stays idle. A client
can open a thread with a prompt, close one, find threads by name and rename
them. Each session gets its client's plugin enabled from the hub's channel,
so one `thread.json` serves every client.

`hub/serve.ts` is the service: it runs every client (Telegram, Discord) in
one process. Each client registers in `clients` with a `place` that opens an
empty thread, which lets `move` hand a thread to another client: its session
stops once its turn ends (`release`) and resumes there with its memory
(`adopt`). The main thread never leaves, so a copy of it continues there
instead (`fork`, `--fork-session`).

## Invariants

1. The hub never launches or stops the main thread.
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
   its job's `failed` state. The only delay is how long a quiet session stays
   warm before it's stopped.

## Verification

`bun test hub` drives routing, queueing, resume, running sessions, the main
thread, failed starts, busy and idle, idle stops, closing, naming and
handoffs (release, adopt, fork) against a fake `claude`. Run `scripts/verify`.

## Removal

Remove this patch when Claude Code routes one channel plugin's threads to
separate sessions on its own, so clients no longer need a hub.
