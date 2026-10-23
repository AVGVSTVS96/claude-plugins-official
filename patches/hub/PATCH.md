---
format: patch-md/v0.1
id: hub
summary: Add a client-agnostic hub that gives every chat thread its own Claude Code session and moves threads between clients.
baseline: 58267944f92187b7d6a1c822165c96c81c864806
patch_file: hub.patch
patch_sha256: 71624c16afbd2fcd9846f4904a09c44fe0e1c10db20860ac1076f6f997f3d74c
---

## Intent

Add `hub/`, a small library a chat client's bot process embeds so one bot
connection can serve many Claude Code sessions, one per chat thread.

`startHub` keeps the thread → session registry in `threads.json`, serves
each session's channel itself, and queues messages for a thread whose session
isn't running. It starts that session with
`claude --bg` through the client's launcher (`claude` unless one is given, so
hex can add its own plugins and flags), or resumes it with
`--resume`, and passes the channel, the thread, the socket path, the
channel's port and the hub's token through the session's settings env, in a file
of its own (`sessions/<thread>.json`, owner-only) that `--settings` names, so
none of it shows in a process's arguments and `claude respawn` reads the
thread's current binding. The launcher runs in the hex folder
without any `*_BOT_TOKEN`, `HEX_*` or `BUZZ_*` in its environment: Claude's
background daemon may start from it, and every later session inherits the
daemon's environment, so a thread's binding lives only in its settings. It watches each start
through Claude's job record and reports a failed start with its reason.
Everything the hub asks of Claude Code (`agents`, `stop`, `rm`, `respawn`, a
`--bg` start, job records and transcripts) goes through `hub/claude.ts`, which
reads `CLAUDE_CONFIG_DIR` the way Claude does. Each thread the hub runs is one
record whose phase says where its session stands: stopped, launching (started,
its channel not yet connected), recovering (running without its channel) or
live.
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
client can add launch arguments per thread. `threads.json` keeps a digest of what a
session started with, so a message to a session whose arguments changed goes to a
fresh start of it (a session busy with background work keeps running and takes it
as it is). A client can mark threads fresh: their launcher builds what a new
session knows of the chat (its settings env says `HEX_FRESH`), so a fresh thread
needs no compaction and never compacts. A fresh thread keeps one session running
and sends each message straight to it, so no message waits for a session to start,
while that session is worth it: its context (its last request) holds less than
`capacity` tokens, 350,000 unless the client or `HEX_CHAT_CAPACITY` sets
another (0 is taken as it is; anything but a number stops the service from starting), and its last request is younger than the cache's life (54 minutes, as
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
message that finds its session done goes to a new one, except on a call: from
`keep` to `renew` one session takes every message of the call, idle or not, and
its renew waits for the call to end. Messages
waiting for a new start keep their order. Each session's settings enable only its client's plugin.

A client hands `startHub` its channel (`server`: the instructions and tools
each session gets), and the hub serves it over MCP's Streamable HTTP on
`127.0.0.1`, one port for every client in the process (`HEX_PORT`, 8789 by
default) under the client's plugin name (`/telegram`). The client's plugin is
then only an `.mcp.json` of `"type": "http"` whose URL takes the session's
`HEX_PORT` and whose headers carry its `HEX_CHANNEL`, `HEX_THREAD` and
`HEX_TOKEN`, so no process runs per session: Claude Code
never restarts a stdio server that dies (anthropics/claude-code#43177), so a
`pkill -x bun` left General deaf and mute for a day, while it reconnects to
an HTTP one on its own. The hub declines `server/discover`, so Claude Code
settles on a revision whose stream can carry channel messages, and takes any
session id it's given, so a session that connected before the hub restarted
carries on without initializing again. Claude Code drops channel messages that
come before it listens and says nothing when it starts, but it registers its
channel handler in the same step as its `tools/list_changed` handler, so the hub
declares `tools.listChanged`, tells a new session its tools changed once its
stream is open and it has listed them (again every 250 ms, since a session
starting cold drops it until it listens), and opens the channel when the
session lists them again. Any local user can reach the port, so the hub makes
a token once (`token` in its state folder, owner-only) and refuses a request
without it as `Authorization: Bearer`, one with an `Origin` header, or one by a host other than
localhost. The token goes in `Authorization` because Claude Code takes a
refusal then as a failed connection; with any other header it records the
server in `mcp-needs-auth-cache.json` and skips it for 15 minutes, which no
restart in place clears. A session with no thread (its env has none, or
another channel's) gets no messages and acts on no thread. Every client has a
`server`, so HTTP is the one way a session the hub starts reaches it; `hub.sock`
takes hooks' `state` and local programs' lines (`inbound`, `open`, `answer`,
`settle`, `reopen`). A session whose plugin started before its client served over
HTTP still says hello on `hub.sock` and keeps that line as its channel, its tool
calls and permission prompts included, so an update leaves no thread deaf; since
nothing else says hello, such a session starts over at its next rest, the way a
stale one does, and its next session reaches the hub over HTTP.

A thread whose session runs needs its channel. When it drops, when the hub
starts, when a message finds its session running without one, and after a
start, the hub gives Claude Code 20 seconds to reconnect it (it retries a
dropped HTTP server at about 0, 1, 3, 7 and 15 seconds, then gives up for
good). After that, a session still running that started before then restarts
in place (`claude respawn`, which keeps its conversation and runs a turn it was
on again) when its flags read the thread's settings file, which the hub writes
again first, so the session comes back with the current token and thread. The hub
owns that file's plugin and thread keys and a launcher may add its own at start
(hex's adds its chat prompt's settings and a call's model); a respawn runs without the
launcher, so the hub renews only its own keys and the launcher's stay. Otherwise it stops
and resumes, since a respawn would start it without its binding; one that
started since gets the same time, and one that restarted
and still has no channel is reported as a failed start, as is a session the
hub started or restarted that ended before its channel connected, so a thread
never waits on a start that is gone. A gone main thread
starts again, and a thread whose messages waited on a session that has since
ended resumes. The running session serving a thread is its current one, or one
Claude's job record shows was started for it (its `respawnFlags` keep the
settings env, in its settings file or, from a hub before that file, inline), so a
session whose conversation isn't saved yet is waited for, never started twice. A
session the hub stops to start again is stopped by its own id, which for one
found by its job record isn't the thread's saved one.

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
(a fresh thread as a new session); any other thread's next message resumes it.
`threads.json` keeps a digest (`stamp`) of what each thread's session started
with: its launch arguments, the channel's instructions and tools, and the hooks
files its launcher's plugins load (`hooks`, from `HEX_HOOKS`), which a session
reads only as it starts and a reconnect keeps. A session that connects
with another digest renews too, once Claude reports it idle, and its next message
goes to a fresh start, so an update that changes them moves each session onto
it at its own next rest, while a crash or a plain restart of the hub leaves
every session running, a warm DM included. A thread with no digest started with
none of its own arguments, before the hub kept one. A client in the same process
calls `keep` and `renew` on the hub it started: `keep` before the rest cancels a
renew (a voice call started in the meantime), even while the hub is still
asking Claude whether the session is working, and a renew asked for survives
the session's channel dropping and coming back before its rest. `renewal` resolves once a renew on
its way is through (the new session connects) or off, at once when none is, and
doesn't wait on one held up by background agents, so a client can hold a new
call for the new session. A fresh thread whose session outlived the hub (a
hub restart), saved or not, is left to reconnect instead of starting a new one, so it never
runs twice and a warm session is never left running unwatched.

`hub/serve.ts` is the service: it runs every client (Telegram, Discord,
Buzz, T3 Code, voice) in one process and owns its one HTTP listener, which hands each
request to the hub serving that path (`route`). A thread is on a call from its `keep` until its
`renew`, whatever happens to its session's channel meanwhile, and a voice call's audio runs in this
process, so on SIGHUP the service exits once no thread is on a call (`free`), and
whatever runs it starts it again on the current code, inside Claude Code's
first retry, so sessions carry on where they were. Each chat client registers in `clients` with a `place` that opens a
thread, led by a line saying what it's for when one is given. `begin` is how
any session starts work anywhere: it opens a thread on any client and starts
its session on a prompt (its first message as it starts) or on a message
delivered there the way the app's own are (the voice app's `send`, which
follows it by a tag in its meta), so every client's `new_thread` reaches
every other app through it, T3 Code's included. `move` hands a thread to
another client: its session stops once its turn ends (`release`) and resumes
there with its memory (`adopt`). The main thread never leaves, nor does a
thread its app owns (a T3 Code thread, `copy`), so a copy of it continues
there instead (`fork`, `--fork-session`). A thread that names another client
that isn't running is told which are.

The hub also holds what its clients share: `MODELS` and `EFFORTS`, the
choices a client offers for a thread's settings (T3 Code's pickers, Discord's
`/model` and `/effort`); `preview`, a permission prompt's input as one line
per field; and `engine`, where the voice app's call engine puts `take` once it
runs, so a client that holds a line to the owner (a Discord voice channel)
hands it calls without depending on the voice plugin. `hub/ledger.ts` keeps
every question a client asked with buttons, a menu or a poll, what became of
it (answered, and where; settled; taken back), and each thread's pinned post,
in the client's `ledger.json`, where the voice app's asks and hex's check read
them. A message is a number in Telegram and a string in Discord, whose
snowflakes outgrow a JavaScript number; an ask from a menu records that any
number could be picked, so taking an answer back puts the menu back.

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
   rests before its cache would expire, how often a new session that hasn't
   listed its tools again is told they changed, and how long Claude Code keeps
   reconnecting a channel before giving up;
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

`bun test hub` drives sessions over HTTP the way Claude Code connects
(`hub/testing.ts`, which the clients' tests share): routing, queueing, resume, folders, running sessions, the main
thread (started with the hub, kept running, revived, `HEX_MAIN` only for General, renewed at once, a
fresh one left to reconnect after a hub restart), renews at the rest the Stop hook reports and after
background agents, `renewal` holding for the new session and not for agents or a keep,
sessions started with another digest renewing at their
next rest and never during a call, a plain hub restart leaving them running, `free` waiting for calls to end
even with the session's channel gone, one session taking a whole call and the next call a new one, a renew asked for kept across a reconnect, the launcher and its
environment, failed starts, busy and idle, idle stops, compacting big sessions before they rest, fresh threads (warm delivery, never resuming, the handover once the context
fills, even while Claude's status lags, or the cache expires, by its recorded tier, never compacting, a warm session from before a hub
restart found by its job instead of started twice), stopping, closing, naming and
handoffs (release, adopt, fork), permission prompts and bad input against a fake `claude`, plus
channels that drop and come back, sessions that restart in place once and are reported after,
sessions that outlived the hub, starts that end before their channel connects, unsaved sessions found by their job, a new stream held until
Claude Code lists its tools again (told again while it drops that), a stream adopted after a
restart, the declined protocol, requests without the token refused, a restart in place
writing the current token first, a lost state folder made again with a new token, a hooks-only change renewing and unchanged hooks not, owner-only token and
settings files, sessions whose flags read no settings file stopped and resumed instead of
respawned, `HEX_CHAT_CAPACITY` parsing, and unbound sessions. Run `scripts/verify`. Live: in an
isolated `CLAUDE_CONFIG_DIR`, a new thread and a warm DM each get a message and reply on a
cold start without a restart, the DM's next message goes straight to the same session, both
carry on through a hub restart with no renew, and both restart in place with their token after
a 30-second outage. A session started with a wrong token is refused, Claude Code records
no needs-auth entry, and the hub restarts it in place with the right one, which then gets a
message, with no step by hand.

## Removal

Remove this patch when Claude Code routes one channel plugin's threads to
separate sessions on its own, so clients no longer need a hub.
