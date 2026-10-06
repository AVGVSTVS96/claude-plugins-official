---
format: patch-md/v0.1
id: discord-threads
summary: Rework the Discord channel so every thread in a server is its own Claude Code session, Claude-tag style, through the thread hub.
baseline: d4226d062928f8d9505dbdeadd10217d23361052
patch_file: discord-threads.patch
patch_sha256: 7b6000190848b75eba4deb89402054962cf5add703a56303c0eb7125657a41be
---

## Intent

Split upstream's single-session `server.ts` in two, the same way
`telegram-topics` splits Telegram's, so one gateway connection serves a
session per Discord thread through `hub/`:

- `bot.ts` takes upstream's gateway half: the allowlist, attachments and the
  Discord calls. It runs in the hub service (`hub/serve.ts`), embeds the hub,
  and maps each thread to its own session by the thread's channel id.
- `server.ts` keeps upstream's tools and instructions as the channel every
  session loads. It learns its thread and its hub's socket from the session's
  env (`HEX_THREAD`, `HEX_HUB`), connects only when
  `HEX_CHANNEL` names this plugin, and forwards its calls there.

Discord is the place for deeper work, Claude-tag style:

- Tagging the bot in a text channel starts a thread on that message, with a
  fresh session. Inside a thread every message reaches its session, no tag
  needed. The session renames a new thread to 1–2 words (`rename_thread`).
- Answers can be longer and structured: the instructions say so, the
  chunker splits on paragraphs by default, and a code block cut across
  messages is closed and reopened so both halves render.
- `new_thread`, `close_thread` (archives the thread and forgets it once its
  session stops; a new message unarchives it with a fresh session) and
  `reply` into another thread by name. A thread deleted in Discord is
  forgotten too.
- `handoff(to: "telegram" | "buzz")` moves a thread's session to a new
  Telegram topic or Buzz thread.
- A session reads the whole server, not just its own thread: its inbound
  messages name their `channel`, `fetch_messages({channel})` returns a text
  channel's top-level messages, each with its thread's reply count and last
  reply, and `fetch_messages({thread})` reads any thread by its starter
  message id or name. `before` pages back, and `list_channels` lists the
  text channels the bot can read. Only text channels and threads in the
  bot's server that it can see are read, never a DM. Bots can't search.
- The typing indicator follows the session's real busy state.
- A session that fails to start says why, in its thread.
- `reply` refuses to attach channel state or any `.env` file.
- User, nickname and role mentions are stripped from a message and from the
  thread name it starts.

## Invariants

1. One gateway connection, owned by the service. Sessions never connect to
   Discord.
2. Tools act on the caller's own thread unless they name another one, so
   they take no `chat_id`. Reading may name any channel the bot can see;
   posting stays in the caller's thread or a thread it names.
3. The bot always posts as itself.
4. Without `DISCORD_BOT_TOKEN`, Discord stays off and the rest of the hub
   service runs.
5. Deliberately dropped from upstream, never ported back: pairing and
   `/discord:access` (single user; `access.json` holds `allowFrom`), DMs,
   the per-channel opt-in, and permission relay.
6. Keep upstream's wording and structure wherever code is shared, so heals
   stay small.

## Verification

Both halves build and the hub tests pass. `bun test external_plugins/discord`
runs the reading tools against a fake Discord client: channel paging, thread
drill-in, the channel named on arrival, and refusal of hidden channels, DMs
and other servers. Run `scripts/verify`.

## Removal

Remove this patch when upstream's Discord channel routes threads to
separate sessions on its own.
