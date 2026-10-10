---
format: patch-md/v0.1
id: discord-threads
summary: Rework the Discord channel so every thread in a server is its own Claude Code session, Claude-tag style, through the thread hub.
baseline: ac996c0dde7fb2a9f805cd5277ffc95ecd44a321
patch_file: discord-threads.patch
patch_sha256: 6e039d5f2790e8a3b64670a8a28f2ddd9cd9330cea3b283e95653379d8d6acf6
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
  text and announcement channels the bot can read. Only those channels and
  threads in the bot's server that it can see are read, never a DM.
  `search_messages` searches the whole server through Discord's guild
  message search, and says when Discord is still indexing.
- Announcement channels work like text channels: a tag starts a thread,
  and they can be read, searched and posted into.
- Forum posts get sessions like any thread. A new post carries its title as
  `post_title` instead of asking for a rename.
- The typing indicator follows the session's real busy state.
- A session that fails to start says why, in its thread.
- `reply` refuses to attach channel state or any `.env` file.
- User, nickname and role mentions are stripped from a message and from the
  thread name it starts.
- A reply says which message it answers, in `reply_to_*` meta: its id,
  author, text and attachments.
- An edit reaches the session again, marked `edited`. A forward carries the
  forwarded message's text and attachments, marked `forwarded`.
- Stickers arrive with their names and image URLs, and polls with their
  question and options.
- The sender's reactions, added or removed, and deleted messages reach a
  thread that already has a session, as `reaction_*` and `deleted` meta.
  Discord doesn't say who deleted a message, so the bot's own
  `delete_message` calls are the only deletes not reported.
- The sender's votes on the bot's own polls, cast or taken back, reach the
  poll's thread with the answer and question.
- `reply` can be `silent` and carry `buttons`; a tap comes back as a
  message with the button's label, and the buttons lock on the choice.
- `delete_message`, `react` with `remove`, `pin`/unpin, `forward` (native
  Discord forwarding into a thread or channel), `poll`, and `edit_message`
  with new files.
- Tools that take a message id find a thread's starter message in the
  channel it hangs off, so `download_attachment` gets the screenshot a tag
  started the thread from.

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
runs the tools and gateway events against a fake Discord client: channel
paging, thread drill-in, search, the channel named on arrival, refusal of
hidden channels, DMs and other servers, reactions, deletes, button taps,
stickers, polls, forum posts and announcement channels. Run `scripts/verify`.

## Removal

Remove this patch when upstream's Discord channel routes threads to
separate sessions on its own.
