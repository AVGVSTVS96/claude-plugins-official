# T3 Code

A channel that serves the agent to [T3 Code](https://github.com/pingdotgg/t3code) as an [ACP](https://agentclientprotocol.com) agent. Pick it in T3's agent picker, in any project, and that T3 thread is its own Claude Code session working in that project, run by the hub like every Telegram topic or Buzz thread. Its intent, invariants and design live in [`patches/t3-acp/PATCH.md`](../../patches/t3-acp/PATCH.md).

- `bot.ts` runs in the hub service (`bun hub/serve.ts`) next to Telegram, Discord and Buzz. It embeds the hub and serves ACP on `acp.sock`: `session/new` opens a thread in the request's `cwd`, `session/prompt` delivers the message and streams the turn back, `session/cancel` stops it, and `session/resume` picks a thread up again after T3 restarts.
- `transcript.ts` turns a session's Claude Code transcript into ACP `session/update` notifications: text, thinking, tool calls and their results.
- `server.ts` is the channel each session loads. It only delivers T3's messages: the session's own output is what T3 shows, so it has no reply tool.
- `acp.ts` is what T3 starts. It relays stdio to `acp.sock`, so T3 reaches the agent that's already running instead of starting one.

State lives in `~/.claude/channels/hex/t3/` (or `T3_STATE_DIR`): `threads.json`, the sockets, and `inbox/`, where pasted images and files land for the session to read.

Add the agent in T3 Code's settings as a local ACP agent whose command is `bun acp.ts <state dir>/acp.sock`. hex does it with `hex acp`.
