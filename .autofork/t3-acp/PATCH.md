Adds a channel for [T3 Code](https://github.com/pingdotgg/t3code), so hex is
one of T3's agents and every T3 thread is a hex session working in that
thread's project. T3 runs coding agents over the
[Agent Client Protocol](https://agentclientprotocol.com) and takes any local
command as one, and it shows the agent's work itself, so unlike the chat
channels the session's own output is the conversation.

The plugin runs in the hub service (`0-hub`) and serves ACP on a socket in its
state folder; the command T3 starts only relays stdio to that socket, so T3
talks to the hex that's already running. A new ACP session opens a thread
named after its folder, working there (none of its own when it's the hex
folder), and starts its session right away; the ACP session id is the thread
id, and resume accepts any thread the hub knows. A prompt is delivered as a
channel message: text as it is, linked files as Markdown links, embedded text
as a `<file path>` block, and images, audio and binaries saved to `inbox/` and
named by path. The turn streams back as ACP updates converted from the
session's Claude Code transcript with claude-agent-acp's converter, skipping
the channel prompt T3 already shows. Updates go out in order, a prompt is
answered only after its last update, and a thread takes one prompt at a time.

A turn ends when the session's work does: the Stop hook reports no background
agent or workflow working, and the transcript has the turn's end with no turn
after it. A background agent's result comes back as a turn of its own and
streams into the same T3 turn, so T3 shows it and T3's tools stay usable.
Claude Code writes the transcript in batches, so the Stop hook can come before
the last reply is on disk, and its own status reads idle for a moment between
an agent finishing and its result's turn, so neither is trusted alone.
Background shells and monitors don't hold the turn, as Claude Code doesn't
count them as working, and a dev server would hold it forever. The transcript
is followed by watching its folder, never on a timer.

Cancel stops the session and answers `cancelled`; the next prompt resumes it.
So does a prompt whose connection closes, as when T3 quits or restarts: T3's
MCP credentials live only in its running server, so the session's T3 tools are
dead, and the old connection would otherwise hold the thread and T3's next
prompt would be refused. The MCP servers T3 sends (its own `t3-code` tools)
reach the session as `--mcp-config`; a session loads them only as it starts,
so when they change, the next prompt goes to a fresh start of the session
unless it's busy with background work. T3's model and effort pickers offer the
hub's choices and set the thread's own, taking effect the same way; a thread
with no choice shows what hex's settings give it. A session that fails to
start, such as in a workspace Claude Code doesn't trust yet, fails the prompt
with its reason.

The channel tells the session its output is the reply, and its tools reach the
chat apps: `new_thread` opens a Discord, Telegram or Buzz thread whose session
works in this thread's project, and `handoff` continues the conversation there
as a copy, since T3 Code owns its threads and this one stays.

This patch is done when T3 Code can reach a running hex by itself, or hex no
longer runs on this hub.
