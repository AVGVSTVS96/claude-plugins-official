Adds live voice calls with hex. OpenAI's `gpt-live-1` does the talking and
the Claude Code session does the work: the voice model never gets tools of its
own, since the session uses client delegation, so starting, steering and
stopping work stays with Claude.

```
voice session ── HTTP ──► hub ──► call engine ◄── page, app, Twilio, Discord
```

The call engine runs once in the hub service (`0-hub`), and the voice session
reaches it over the hub's HTTP channel like every other client's sessions, so
a session dying or restarting never takes a call down. The OpenAI key, from
`~/.claude/channels/voice/.env`, stays in the engine and out of the service's
environment, so no session sees it. The engine serves a call page on loopback
only; with `VOICE_TOKEN` set, everything but the page and Twilio's routes
needs it as a bearer token, and the page gets the token filled in only when
the request didn't come through a proxy.

A call keeps one transcript: both speakers' fragments in timeline order,
grouped into turns, each handed to Claude exactly once, and a fragment that
arrives late still goes in the next handoff at its place. When the voice
delegates, the engine waits for the words up to that moment, then hands
Claude every turn not yet sent. Claude answers with `say` and `note` (what
the voice says and thinks) and `task`, which keeps a task board the voice can
see; each resolves on OpenAI's acknowledgement or fails with its error, and
all of them are always loaded so a call never waits on a tool search. What the
voice says first (a phone call's greeting, the topic the app started the call
on) goes in the session's creation, so it has it before the caller speaks.

One call, one session. The voice thread is a fresh thread with no capacity:
the engine sends the hub `keep` when a call starts and `renew` when it ends,
every message of the call reaches that same session however long it sits idle,
and the next call starts in a new session that reads the call chat. Steps to
the hub go one at a time: a call that comes while the last call's session
winds down starts at once, and its words wait until the new session connects,
so a caller who calls right back still gets a new session, unless background
agents hold the renew, in which case the call goes to the session there is.

Calls come from the page and the iPhone app over WebRTC, from Twilio (dialing
out with the `phone` tool, or the number's webhook taking calls Twilio signed
from `CALLER_NUMBER` and refusing any other), and from lines other clients
hold, like a Discord voice channel, which hand the engine PCM audio both ways.
Twilio streams use one-time tokens the engine issued (trial accounts can't
pass TwiML inline, so it's served from a token URL). Every kind is followed
the same way and saved as one record: turns, task changes, where it came from,
Claude's exact words as moments, the title, summary and what's waiting that
Claude gives it, its expiry and its usage in seconds, dollars and context. The
app reads records live. Calls that never connect (refused by OpenAI, busy, no
answer, failed, or picked up without the voice joining) are saved with no
turns and Claude is told. Two minutes before a call expires, the voice and
Claude are told. When a call ends, pending handoffs and the last words reach
Claude with a "call ended" message.

A call's record is never left without an end. When a call's sideband drops
without the session closing, the engine reattaches by id a few times before
calling it dropped; when the service starts, it reattaches to the latest call
with no end, tells Claude the call resumed with the call so far, and closes
any other unended record as dropped.

Claude can hand work to the rest of hex during a call. `send` delivers a
message to another hex thread, or opens a new thread in Discord, Telegram or
Buzz, puts it on the board and follows that thread's session (and its
background agents) from the tagged message until a turn ends with no agents
out, marking it done, or failed on an API error. A running task can name the
agent doing it, and its board line shows that agent's latest step, from its
transcript as it's written (converted with claude-agent-acp, as the Buzz and
T3 plugins do), never on a timer. After a restart the engine resumes the last
day's unfinished sends from their records.

For the app, the engine lists every hex thread as a task with a link that
opens it in its own app (a Telegram topic or the bot's DM, a Discord thread,
a Buzz message, a T3 Code thread found in T3's own database, read only) and a
week of its states, kept on disk since Claude Code starts a job's timeline
over when its session restarts; every open question with its answers, links
and every place it was asked, each with the best link its app has; and the
live call's tasks, most recently changed first.

This patch is done when upstream ships an equivalent voice channel for Claude
Code.
