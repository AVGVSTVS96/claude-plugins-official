hex, Bassim's assistant, talks with him through chat apps, and every thread
there (a Telegram topic, a Discord or Buzz thread, a T3 Code thread, a voice
call) is its own Claude Code session. Upstream's channel plugins run one
session per plugin, so this patch adds `hub/`: one service that holds every
app's connection and gives each thread its own session, started, resumed and
stopped as its messages need. The channel patches are its clients, which is
why this one goes first.

The hub keeps which session serves which thread, queues messages for a thread
whose session isn't running, and starts it with `claude --bg` or resumes it,
through a launcher the client can replace so hex can add its own plugins and
flags. A thread's binding (its channel, thread, the hub's port and token)
lives only in a settings file of its own (owner-only) that `--settings` names,
never in a process's arguments or environment: Claude's background daemon may
start from the launcher and every later session inherits the daemon's
environment, so the launcher runs without any bot token, `HEX_*` or `BUZZ_*`
in it. A thread can have its own folder, model, effort and launch arguments.
The hub keeps a digest of what each session started with (its arguments, the
channel's instructions and tools, the hooks files its plugins load), so after
an update each session moves onto the new ones at its own next rest, while a
crash or plain restart of the hub leaves every session running.

The hub serves each client's channel itself, over MCP's Streamable HTTP on
127.0.0.1, one port for the whole service, and a client's plugin is just an
`.mcp.json` of type `http` with its thread and token in headers, so no process
runs per session. That's the point of it: Claude Code never restarts a stdio
server that dies (anthropics/claude-code#43177), and a `pkill -x bun` once
left General deaf and mute for a day, while it reconnects to an HTTP server on
its own. Any local user can reach the port, so a request needs the hub's token
as `Authorization: Bearer`, and one with an `Origin` or a host other than
localhost is refused. The token goes in `Authorization` because Claude Code
takes a refusal there as a failed connection; with any other header it marks
the server as needing auth and skips it for 15 minutes, which no restart
clears.

Claude Code has quirks the hub has to keep handling. It drops channel
messages that arrive before it listens and never says when it starts, but it
registers its channel handler with its `tools/list_changed` handler, so the
hub tells a new session its tools changed (again every 250 ms until it lists
them) and opens the channel when it lists them again. The hub declines
`server/discover` so Claude Code settles on a revision whose stream carries
channel messages, and takes any session id so a session that connected before
a hub restart carries on. When a session loses its channel, Claude Code
retries for about 15 seconds and then gives up for good, so after 20 the hub
restarts a session that's still running in place (`claude respawn` keeps its
conversation), writing its settings file again first so it comes back with
the current token, or stops and resumes it when its flags don't read that
file. A running session is never started twice: one Claude's job record shows
was started for a thread counts as that thread's, even before its
conversation is saved, and a thread takes a new session id only once Claude
has saved it. A stopped session's job record is cleared before `--resume`,
which would otherwise copy the conversation to a new id, and `--channels`
comes right after `--bg` so a prompt is never read as a channel.

Sessions are shaped around the prompt cache. Claude Code keeps a conversation
cached for an hour and compacts a background session only when told to, so a
big session (its last request sent over 150,000 tokens) compacts before it's
stopped for idling, while the cache is warm, without showing as working.
The main thread, hex's General, always runs: it's never stopped for idling,
moved or closed, a big one compacts after 54 minutes idle the same way, and
only its settings say `HEX_MAIN`, so hex runs its scheduled jobs there alone.
A fresh thread (a DM, voice) has its launcher build what a new session knows
of the chat, so it never compacts or resumes: it keeps one session running so
no message waits on a start, and at the session's rest it hands over to a new
one once its context passes `capacity` (350,000 tokens unless the client or
`HEX_CHAT_CAPACITY` says otherwise) or its cache runs out (54 minutes, or a
twelfth of that when the transcript shows the five-minute cache). With a
capacity of 0, voice's, every message that finds the session done gets a new
one, except on a call: from `keep` to `renew` one session takes the whole
call. Nothing renews or compacts a session, or restarts the service, while its
thread is on a call.

Busy and idle come from hooks. Busy counts only prompts from a chat channel,
so scheduled prompts never show as typing, and a turn is over when the Stop
hook reports no background agent or workflow working: Claude's own status
lags the hook and counts a running shell as busy. No timer stands in for
state: a start settles on its channel connecting or its job failing, and the
only waits are the cache's life, the tools-changed nudge and Claude Code's
reconnect window.

The hub is also what the clients share: opening, closing, stopping, finding,
listing and renaming threads, with one rule for names (one word); `begin`,
which opens a thread in any app and starts its session there, so every
client's `new_thread` reaches every other app; `move`, which hands a thread to
another app only once its old session has disconnected, so one conversation
never runs in two places, or continues a copy there (`--fork-session`) for the
main thread and threads their app owns (T3 Code's); permission prompts
relayed to the asking session's own thread; voice-message transcription
through any OpenAI-compatible endpoint when `TRANSCRIBE_URL` is set; local
programs handing a thread a message over `hub.sock`; the model and effort
choices clients offer; a ledger of every question asked with buttons, a menu
or a poll and what became of it, which hex's voice app and check read; and
`buzz://` links turned into web links, since chat apps only link web
addresses.

`hub/serve.ts` runs every client in one process with one HTTP listener. A
voice call's audio runs there too, so on SIGHUP it exits once no thread is on
a call, and whatever runs it starts it again within Claude Code's first
reconnect retry. Bad input fails alone: a malformed line is dropped, an
unreadable `threads.json` is moved aside, and a launcher that can't run fails
only its start.

This patch is done when Claude Code routes one channel plugin's threads to
separate sessions on its own.
