---
format: patch-md/v0.1
id: discord-threads
summary: Rework the Discord channel so every thread in a server is its own Claude Code session, Claude-tag style, through the thread hub.
baseline: d1adba47161a271799de7b548225d929310046bd
patch_file: discord-threads.patch
patch_sha256: 803cc26fd189b4466b7c42f787b516f4a2efaa6eb03f1ad2cf4c518809c649d6
---

## Intent

Split upstream's single-session `server.ts` in two, the same way
`telegram-topics` splits Telegram's, so one gateway connection serves a
session per Discord thread through `hub/`, and no process runs per session:

- `bot.ts` takes upstream's gateway half: the allowlist, attachments and the
  Discord calls. It runs in the hub service (`hub/serve.ts`), embeds the hub,
  and maps each thread to its own session by the thread's channel id.
- `channel.ts` keeps upstream's tools and instructions as the channel the hub
  serves every session over HTTP. `.mcp.json` points the session there
  (`HEX_PORT`) with its `HEX_CHANNEL`, `HEX_THREAD` and the hub's `HEX_TOKEN`
  (as `Authorization`) in headers, in place of upstream's `bun server.ts`.

Discord is the place for deeper work, Claude-tag style:

- Tagging the bot in a text channel starts a thread on that message, with a
  fresh session. Inside a thread every message reaches its session, no tag
  needed. The session renames a new thread to one word (`rename_thread`).
- Answers can be longer and structured: the instructions say what Discord's
  Markdown renders (headings, code blocks with a language for highlighting,
  `-#` subtext, masked links, `<link>` without a preview) and that it has no
  tables, the chunker splits on paragraphs by default, and a code block cut
  across messages is closed and reopened so both halves render.
- `new_thread` (its `about` line is the thread's first message, then the
  request that asked for it and the session's replies since, forwarded as
  Discord forwards, when a message from the user started the caller's turn;
  in a forum channel it opens a post with that line and the tags it names;
  with `app: "telegram"` or `"buzz"` it opens the thread there through the
  hub's `begin`; `reply` and `edit_message` turn `buzz://` links into web
  links), `close_thread` (archives the thread and forgets it once its
  session stops; a new message unarchives it with a fresh session) and
  `reply` into another thread by name. A thread deleted in Discord is
  forgotten too, and so are its questions.
- `handoff(to: "telegram" | "buzz", channel?)` moves a thread's session to a
  new Telegram topic or Buzz thread.
- A session reads the whole server, not just its own thread: its inbound
  messages name their `channel`, `fetch_messages({channel})` returns a text
  channel's top-level messages, each with its thread's reply count and last
  reply, and `fetch_messages({thread})` reads any thread by its starter
  message id or name. `before` pages back, and `list_channels` lists the
  text, announcement and forum channels the bot can read;
  `fetch_messages({channel})` on a forum lists its posts. Only those channels and
  threads in the bot's server that it can see are read, never a DM.
  `search_messages` searches the whole server through Discord's guild
  message search, and says when Discord is still indexing.
- Announcement channels work like text channels: a tag starts a thread,
  and they can be read, searched and posted into.
- A DM to the bot is its own conversation: one session named `DM`,
  separate from every thread. Thread-only tools (`rename_thread`,
  `close_thread`) say a DM is not a thread. A DM is a fresh thread (see the
  hub): each message that finds its session done gets a new one.
- Forum posts get sessions like any thread. A new post carries its title as
  `post_title` instead of asking for a rename.
- The typing indicator follows the session's real busy state.
- Once connected, the bot leaves its server's id in `guild.json` in its state
  folder, so the voice app can link a thread to Discord.
- A session that fails to start says why, in its thread.
- `reply` refuses to attach channel state or any `.env` file.
- `reply` and `react` are always loaded (`_meta` `anthropic/alwaysLoad`),
  so a session's first reaction needs no tool search round first.
- User, nickname and role mentions are stripped from a message and from the
  thread name it starts.
- A reply says which message it answers, in `reply_to_*` meta: its id,
  author, text and attachments.
- An edit reaches the session again, marked `edited`. A forward carries the
  forwarded message's text and attachments, marked `forwarded`.
- A voice message arrives as its transcript, `(voice message) <words>`, when the
  hub has a transcriber (`transcribe`); otherwise as before. The recording stays
  listed in the attachment meta.
- Stickers arrive with their names and image URLs, and polls with their
  question and options.
- The sender's reactions, added or removed, and deleted messages reach a
  thread that already has a session, as `reaction_*` and `deleted` meta.
  Discord doesn't say who deleted a message, so the bot's own
  `delete_message` calls are the only deletes not reported.
- The sender's votes on the bot's own polls, cast or taken back, reach the
  poll's thread with the answer and question.
- `reply` can be `silent` and carry `buttons`; a tap comes back as a
  message with the button's label, and the buttons lock on the choice. With
  `multiple` they come as a menu (a string select) that takes any number of
  picks at once, which come back as one message and lock the menu on them.
- Every question asked with buttons, a menu or a poll goes in the hub's
  ledger (`ledger.json`, with Discord's message ids as strings), with each
  tap, pick and vote, edits, deletes and the pinned post, as Telegram's do:
  hex's voice app lists them and hex's check reads them. One answered
  elsewhere (`answer` on `hub.sock`: the app or a call) locks its buttons on
  a line saying where (a poll ends instead) and reaches the thread as the
  owner's tap would, with `answered_in`; `settle` locks them on its note;
  `reopen` puts them back and tells the thread the answer no longer stands
  (`took_back`).
- Permission prompts (`claude/channel/permission`) ask in the session's own
  thread: the tool, its description and its input in a code block, with
  Allow and Deny buttons that lock on the choice. A prompt still open when
  the turn ends with no background agents out was answered in the session
  itself, so its buttons say it's no longer waiting. Claude Code relays no prompt for a tool that needs the
  user's own input (AskUserQuestion, ExitPlanMode), so those never come.
- Images in a message arrive downloaded, as `image_path` (paths joined by
  `; `), as Telegram's photos do; other files stay listed for
  `download_attachment`.
- Slash commands, registered globally on connect for the server and the
  bot's DM, control a thread outside its conversation and answer only the
  owner, privately: `/model` and `/effort` (the hub's `MODELS` and
  `EFFORTS`, from the thread's next message), `/compact` (once the thread
  isn't working) and `/stop`. A tap is answered before anything is fetched,
  inside Discord's three seconds.
- A first login that fails (no network yet at boot) is tried again with
  backoff, up to a minute apart; only a bad token is final. discord.js
  reconnects a session it already has.
- The owner joining one of the server's voice channels calls hex there
  (`voice.ts`, the `GuildVoiceStates` intent): the bot joins with
  `@discordjs/voice` (DAVE end-to-end encryption, which Discord requires),
  hands the call to the voice app's call engine through the hub's `engine`,
  and passes audio through: the owner's Opus decoded (`opusscript`) to 24 kHz
  mono, with their quiet sent as silence, since the voice takes its turn on
  hearing it; the voice's audio widened to 48 kHz stereo and played in
  stretches of speech, so the bot shows as speaking only while it talks. The
  call is the engine's like a phone call: the same session, record and board.
  Leaving the channel, moving to another (a new call there), or hex hanging
  up ends it, and the bot leaves.
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
   `/discord:access` (single user; `access.json` holds `allowFrom`) and
   the per-channel opt-in. Permission relay came back, asked in the
   session's own thread instead of every allowlisted DM.
7. The voice connection is the service's too, one call at a time, and only
   the owner's audio is heard.
6. Keep upstream's wording and structure wherever code is shared, so heals
   stay small.

## Verification

The bot builds, `.mcp.json` is an HTTP server, and the hub tests pass. `bun test external_plugins/discord`
runs the tools and gateway events against a fake Discord client: channel
paging, thread drill-in, search, the channel named on arrival, refusal of
hidden channels, DMs and other servers, reactions, deletes, button taps,
stickers, polls, forum posts, announcement channels, a DM as its own
session, permission prompts, the ledger and answers from elsewhere, menus,
images on arrival, new threads' forwarded origin, forum posts with tags,
new threads in other apps, slash commands and a failed first login.
`voice.test.ts` covers the audio conversions, stretches of speech, silence
for quiet, and a call from joining to leaving against a faked
`@discordjs/voice`. Live: the bot joins a voice channel under Bun with DAVE
and plays. Run `scripts/verify`.

## Removal

Remove this patch when upstream's Discord channel routes threads to
separate sessions on its own.
