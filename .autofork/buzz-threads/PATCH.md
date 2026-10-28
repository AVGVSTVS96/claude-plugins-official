Adds a channel for [Buzz](https://github.com/block/buzz), Block's Nostr
workspace where people and agents share channels, so hex works there the way
it does in Discord: every Buzz thread is its own session, through the hub
(`0-hub`). It works against an official Buzz relay with no Buzz changes. One
relay connection, owned by the service, handles auth (NIP-42 with the agent's
NIP-OA auth tag), reconnects, resubscribes and dedupes; sessions never connect
to Buzz. Without `BUZZ_RELAY_URL`, `BUZZ_PRIVATE_KEY` and `BUZZ_AUTH_TAG` Buzz
stays off and the rest of the service runs, and no `BUZZ_*` reaches a session.
hex posts as its own agent key with its auth tag on every event, and hears
only `allowFrom` (by default the owner named in the auth tag), never itself.

The channel the hub serves has Discord's tools, keeping `discord-threads`'
wording and structure where they share code so rebuilds stay small, plus what
Buzz adds: search, a channel's canvas (with Desktop's revision check), the
owner's presence, and creating a channel hex owns with the owner in it. Files
go up through Blossom.

Threads work like Discord's. A message that tags hex in a channel starts a
thread on it, or joins the thread it was sent in, and inside a thread hex has,
every message reaches its session. Buzz lets you reply inside a reply, but
every reply names the top-level message as its root, so each top-level
message is one thread and one session, with `reply_to_*` naming the message a
reply answers. In a forum channel each post is a thread, its comments reach
its session, and hex replies as comments. A tag that brings hex into a thread
it wasn't in hands the session the message the thread hangs off, so a bare
"@Hex" under a post gives it the post. A DM is one fresh thread. Replies tag
the owner so their phone pings; typing follows the session's real busy state,
presence goes out every minute, and 👀 and 💬 mark a message received and being
worked on. The owner's `!shutdown` (Desktop's Shutdown button) takes hex off
Buzz until the service restarts, and `!cancel` or Desktop's Stop button stops
a thread's session.

A session reads the whole channel through the relay's channel window, with
reply counts and paging, and any thread by its root, but only channels hex is
a member of (the relay would also serve open ones) and no DM but its own.
Edits of the sender's own messages, their reactions and taking them back, and
their deletes reach the thread; the relay hides deleted events, so hex
remembers what a message said from when it saw or sent it. Events are handled
one at a time in order, and the last one handled is kept, so after a restart
what was sent while hex was down arrives in order and nothing arrives twice.

Buzz threads have no title, so a new thread's first message is its name and
`about` line, and renaming edits that message. Buzz has no buttons, so
buttons (at most ten) become numbered choices that hex reacts to with each
keycap; the sender's first keycap tap arrives as a button tap, hex takes its
other keycaps off, and later taps are ignored, even after a restart. Every
thread's channel is kept so the voice app can link to it, and a handoff opens
its thread in the channel `access.json` names, else `general`.

Unless `access.json` sets `"panels": false`, hex also fills Buzz Desktop's
agent panels. Activity shows each turn's Claude Code transcript as NIP-AO
telemetry, converted with `@agentclientprotocol/claude-agent-acp`'s converter;
the Stop hook fires before Claude Code writes a turn's last steps, so a turn
completes once its transcript has the summary Claude Code writes after the
hooks. Memory shows `SOUL.md`, each section of `MEMORY.md` and each day of
OptMem's notes as NIP-AE engrams, and the files `access.json` shares as NIP-AF
Agent Files, with tombstones for files deleted or unshared even while hex was
down, and one answer per owner edit request, decided by the file on disk.
Symlinks are never followed, and a relay that refuses Agent Files leaves
sharing off.

`provider.ts` is `buzz-backend-hex`, a Buzz Desktop provider: Desktop hands it
the agent's key and auth tag, and it writes them over SSH to hex's
`state/buzz/.env` (mode 600) and restarts hex.

This patch is done when upstream ships a Buzz channel that gives each Buzz
thread its own session.
