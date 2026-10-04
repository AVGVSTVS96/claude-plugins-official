---
format: patch-md/v0.1
id: thread-hub
summary: Add a client-agnostic hub that gives every chat thread its own Claude Code session.
baseline: 2f189354595613190f575ab1f7510f3a94150022
patch_file: thread-hub.patch
patch_sha256: 9da7226ede2775720f9fa0b9008ab720341393dd81afa3100000a81607fcb04c
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
them.

## Invariants

1. The hub never launches or stops the main thread.
2. A session that is still running is never relaunched. A stopped one has
   its job record cleared (`claude rm`) before `--resume`, which otherwise
   copies the conversation to a new id.
3. `--channels` comes right after `--bg`, so a prompt is never read as a
   channel.
4. Busy only counts prompts from a chat channel (`<channel source=`), so
   scheduled prompts never show as typing.
5. No timer stands in for state: a start settles on the session's hello or
   its job's `failed` state. The only delay is how long a quiet session stays
   warm before it's stopped.

## Verification

`bun test hub` drives routing, queueing, resume, running sessions, the main
thread, failed starts, busy and idle, idle stops, closing and naming against
a fake `claude`. Run `scripts/verify`.

## Removal

Remove this patch when Claude Code routes one channel plugin's threads to
separate sessions on its own, so clients no longer need a hub.
