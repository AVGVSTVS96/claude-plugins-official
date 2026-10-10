---
format: patch-md/v0.1
id: buzz-threads
summary: Add a Buzz channel where every Buzz thread is its own Claude Code session through the thread hub, with Buzz's activity, memory and files panels.
baseline: b8e53f1c05dff3b6d751297f6527990ffc81c2f4
patch_file: buzz-threads.patch
patch_sha256: fee4f6099ba4bd1fb2aad20b36853a64574c5e61fca8886954dd4768adec2c69
---

## Intent

Add `external_plugins/buzz`, a channel for [Buzz](https://github.com/block/buzz),
Block's Nostr workspace where people and agents share channels. It works
against an official Buzz relay with no Buzz changes, and has the same two
halves as `discord-threads`:

- `bot.ts` holds the one relay connection (`relay.ts`: NIP-42 auth with the
  agent's NIP-OA auth tag, reconnect, resubscribe, dedupe). It runs in the hub
  service (`hub/serve.ts`), embeds the hub, and maps each Buzz thread to its
  own session by its root event id.
- `server.ts` is the channel every session loads, the same as Discord's, with
  the same tools: `reply` (files go up through Blossom as `imeta`), `react`,
  `edit_message`, `fetch_messages`, `list_channels`, `download_attachment`,
  `rename_thread`, `close_thread`, `new_thread` and `handoff` to Telegram or
  Discord, plus `search_messages`, `delete_message`, `canvas`, `presence` and
  `create_channel` (a NIP-29 create-group Hex owns, with the owner added).

Buzz works like Discord:

- A message that tags Hex in a channel starts a thread on it, or joins the
  Buzz thread it was sent in. Inside a thread Hex has, every message reaches
  its session, no tag needed. A DM with Hex is one thread.
- Each top-level message is one thread and one session. Buzz lets you reply
  inside a reply, but every reply at any depth names the top-level message as
  its root, so it reaches that same session, with `reply_to_*` naming the
  message it answers.
- In a forum channel (kind 39000 tagged `forum`), each post (kind 45001) is a
  thread like a top-level message: a post that tags Hex starts its session,
  comments on it (kind 45003) reach that session, edits, reactions and
  deletes work the same, and Hex's replies post as comments on it.
  `new_thread` in a forum channel opens a post.
- A tag that brings Hex into a thread it wasn't in carries the message the
  thread hangs off as `reply_to_*`, so a bare "@Hex" under someone's post
  hands the session that post (content `(tagged you)`), and the session is
  told to name the thread.
- Replies are kind 9 in the thread and tag the owner, so their phone pings.
- Typing (kind 20002) follows the session's real busy state, presence
  (20001) is sent every minute, and 👀 / 💬 acks mark a message received and
  being worked on.
- The owner's `!shutdown` (Buzz Desktop's Shutdown button) takes Hex off Buzz
  until the service restarts; `!cancel` in a thread, or Desktop's Stop
  button (a `cancel_turn` control frame), stops that thread's session.
- A session reads the whole channel, not just its own thread: its inbound
  messages name their `channel`, `fetch_messages({channel})` returns the
  channel's top-level messages through the relay's NIP-98 `/query` channel
  window (NIP-CW), each with its thread's reply count and last reply, and
  `fetch_messages({thread})` reads any thread by its root id. `before` pages
  back. `search_messages` is the relay's NIP-50 search. Sessions read only
  channels Hex is a member of (the relay would also serve open channels it
  isn't in), and no direct message but their own.
- A reply to one message in particular (a NIP-10 reply marker other than
  the thread's head) says which, in `reply_to_*` meta: its id, author, text
  and attachments.
- An edit (kind 40003) of the sender's own message reaches the session as
  that message's new text, marked `edited`.
- The sender's reactions (kind 7) on any message in a thread Hex has reach
  that thread as `(reaction: 👍)`, naming the message they're on; taking one
  back (a kind 5 of the reaction) arrives as `(reaction removed: 👍)`.
- The sender deleting a message (kind 5, or NIP-29's 9005) in a thread Hex has
  arrives as `(deleted a message)` with what it said, which Hex remembers from
  when it saw or sent it, since the relay hides deleted events.
- Events are handled one at a time in order, and the last one handled (its
  second and the ids handled in it) is kept in `cursor.json`, so after a
  restart Hex subscribes from there: what was sent while it was down arrives
  in order, and nothing is delivered twice. A subscription's stored events
  are delivered oldest first.
- Buzz threads have no title (Desktop's header just says "Thread"), so
  `new_thread` posts the name as the thread's first message, and
  `rename_thread` edits that message when Hex posted it.
- Buzz has no buttons, so `reply`'s `buttons` (at most 10) end the message
  with the choices numbered 1️⃣ to 🔟 and Hex reacts with each keycap. The
  sender's first keycap tap on it arrives as a button tap (the choice's label,
  `button="true"`, `button_message_id`), Hex takes its other keycaps off so
  the chosen one stands out, and later taps are ignored. Which messages carry
  buttons is kept in `buttons.json`, so a tap after a restart still counts.
- `delete_message` and `react` with `remove` take back Hex's own messages and
  reactions; `canvas` reads and replaces a channel's canvas (kind 40100, with
  Desktop's `expected-revision` check and a timestamp past the head it read);
  `presence` reads the owner's online, away or offline status from the
  relay's `/query`.
- `place()` opens a thread for a handoff in `access.json`'s `channel`, else
  `general`, and links to it as `buzz://message?channel=…&id=…`.

Unless `access.json` sets `"panels": false`, Hex also fills Buzz Desktop's
agent panels:

- `activity.ts`: each turn's Claude Code transcript, converted with
  `@agentclientprotocol/claude-agent-acp`'s `toAcpNotifications`, as NIP-AO
  telemetry (kind 24200, NIP-44 to the owner, at most one event a second),
  with turn start, liveness and completion, a `session/new` carrying what the
  session loaded, and remote logs on `log_follow`. The Stop hook reports a
  turn over before Claude Code has written its last steps, so a turn
  completes once its transcript has the `stop_hook_summary` Claude Code writes
  after the hooks, or right away when Hex stopped the session itself.
- `memory.ts`: NIP-AE engrams (kind 30174), `SOUL.md` as the core record,
  each `## ` section of `MEMORY.md` as a memory, and each day of OptMem's
  `memory/LOG.txt` notes as `mem/notes/<date>`; and NIP-AF Agent Files
  (kinds 30180 / 4180 / 4181) for the files in `access.json`'s `share` list:
  a record per file (content inlined only when it's UTF-8 and fits), a
  tombstone for each file deleted or unshared, even while Hex was down, and
  one answer per owner edit request, decided by the file on disk (applied
  edits are written, republished and committed). Symlinks are never followed.
  A relay without Agent Files refuses those kinds; sharing then stays off.

`provider.ts` is `buzz-backend-hex`, a Buzz Desktop provider: Desktop hands it
the agent's key and auth tag, and it writes them over SSH to
`<hex folder>/state/buzz/.env` (mode 600) and restarts hex.

## Invariants

1. One relay connection, owned by the service. Sessions never connect to Buzz.
2. Tools act on the caller's own thread unless they name another one, so
   they take no `chat_id`. Reading may name any channel Hex is in; posting
   stays in the caller's thread or a thread it names.
3. Hex posts as its own agent key, and every event it publishes carries its
   auth tag.
4. Without `BUZZ_RELAY_URL`, `BUZZ_PRIVATE_KEY` and `BUZZ_AUTH_TAG`, Buzz stays
   off and the rest of the hub service runs. No `BUZZ_*` reaches a session.
5. Only `allowFrom` (default: the owner named in the auth tag) reaches Hex;
   its own events are ignored.
6. `server.ts` keeps `discord/server.ts`'s wording and structure wherever they
   share code, so heals stay small.

## Verification

`bun test external_plugins/buzz` runs the bot against an in-process relay,
including channel windows with paging, thread drill-in, search, and refusal
of channels Hex isn't in and of other direct messages, reactions, deletions,
catching up after a restart, the canvas and presence; the activity and memory panels against a fake relay (including NIP-AE's and
NIP-AF's test vectors), and the provider against a fake ssh. `scripts/verify` builds the
bot, the channel and the provider.

## Removal

Remove this patch when upstream ships a Buzz channel that gives each Buzz
thread its own session.
