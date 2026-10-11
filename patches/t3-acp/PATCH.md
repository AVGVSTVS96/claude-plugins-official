---
format: patch-md/v0.1
id: t3-acp
summary: Serve the agent to T3 Code as an ACP agent, where every T3 thread is its own Claude Code session in that thread's project, through the thread hub.
baseline: b8e53f1c05dff3b6d751297f6527990ffc81c2f4
patch_file: t3-acp.patch
patch_sha256: 765ebfc2f9beac732ca708bef676f7b6586e1a36a102606105fbd5ac7f331e9b
---

## Intent

Add `external_plugins/t3`, a channel for [T3 Code](https://github.com/pingdotgg/t3code),
which runs coding agents over the [Agent Client Protocol](https://agentclientprotocol.com)
and takes any local command as one. Unlike the chat channels, T3 shows the
agent's work itself, so the session's own output is the conversation:

- `bot.ts` runs in the hub service (`hub/serve.ts`), embeds the hub, and serves
  ACP on `acp.sock` in its state dir. `acp.ts` is the command T3 starts: it
  relays stdio to that socket, so T3 talks to the agent that is already running.
- `session/new` opens a thread named after its folder, in the request's `cwd`
  (none of its own when that is the hex folder), and starts its session right
  away. The ACP session id is the thread id.
- `session/prompt` delivers the prompt as a channel message and answers when the
  turn ends. Text is passed through, `resource_link` becomes a Markdown link to
  its path, an embedded text resource a `<file path>` block, and images, audio
  and binary resources are saved to `inbox/` and named by path.
- The turn streams back as `session/update` notifications converted from the
  session's Claude Code transcript (`transcript.ts`, with claude-agent-acp's
  converter), from where it ends when the prompt is sent, or from its start for a
  new session. Channel prompts are skipped: T3 already shows what it sent.
- `session/cancel` stops the session and answers `cancelled`; the next prompt
  resumes it. `session/resume` accepts any thread the hub knows.
- The MCP servers T3 sends with `session/new` and `session/resume` (its own
  `t3-code` server: html_render, preview, delegate_task and the rest) reach the
  session as `--mcp-config`. A session loads them only as it starts, so when they
  change, the next prompt goes to a fresh start of the session, unless it is busy
  with background work.
- `session/new` and `session/resume` advertise a `model` and an `effort` config
  option, which T3 shows as its model and effort pickers; `session/set_config_option`
  saves the choice as the thread's (hub `configure`), and the next prompt goes to a
  fresh start of the session with it. A thread with no choice shows what hex's
  settings give it.
- A session that fails to start fails the prompt with its reason, such as a
  workspace Claude Code doesn't trust yet.
- `server.ts` is the channel each session loads. It delivers T3's messages and
  tells the session that its output is the reply; it has no tools.

## Invariants

1. Updates go out in order, and a prompt is answered only after its last update.
2. A turn ends where the transcript says: the first `turn_duration` after the
   turn's channel prompt. Claude Code writes the transcript in batches, so the
   Stop hook can run before the last reply is on disk and never ends a turn.
3. One prompt per thread at a time; a second is refused.
4. No timer stands in for state: the transcript is followed by watching its
   folder, and a turn waits for its own end, a cancel, or a failed start.

## Verification

`bun test external_plugins/t3` follows transcripts (where a turn starts and
ends, partial lines) and drives `bot.ts` as a subprocess over a real ACP
connection with a fake launcher and session: a new thread starting in its
project, a prompt streamed to its end, resume, cancel, a failed start, and
attachments. Run `scripts/verify`.

## Removal

Remove this patch when T3 Code can reach a running hex itself, or hex no longer
runs on this hub.
