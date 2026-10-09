---
format: patch-md/v0.1
id: telegram-topics
summary: Rework the Telegram channel so every forum topic in a group is its own Claude Code session, through the thread hub.
baseline: ac996c0dde7fb2a9f805cd5277ffc95ecd44a321
patch_file: telegram-topics.patch
patch_sha256: e17c74e5d5f956ee52be50f9b14a1a60106d0beb9cbae0eee939a5d9ec4e652e
---

## Intent

Split upstream's single-session `server.ts` in two, so one bot connection
serves a session per forum topic through `hub/`:

- `bot.ts` takes upstream's bot half: polling, the allowlist, attachments
  and the Telegram calls. It runs in the hub service (`hub/serve.ts`), embeds
  the hub, and maps each forum topic, or a plain chat, to a thread.
- `server.ts` keeps upstream's tools and instructions as the channel every
  session loads. It learns its thread and its hub's socket from the session's
  env (`HEX_THREAD`, `HEX_HUB`), connects only when
  `HEX_CHANNEL` names this plugin, and forwards its calls there.

On top of upstream:

- `new_thread(title, prompt)` opens a topic with a fresh session, or a
  Discord or Buzz thread with `app: "discord"` or `app: "buzz"`. Titles are
  1–2 words, enforced.
- `handoff(to: "discord" | "buzz")` moves a topic's session to a new thread
  there and closes the topic. From General, a copy continues there and main stays.
- `close_thread` closes a topic, stops its session once it's idle and
  forgets the topic. The Bot API has no event for a deleted topic, so a call
  that fails because its topic is gone forgets it too.
- `reply` can post into another topic by name.
- The typing indicator follows the session's real busy state.
- DMs to the bot are forwarded into the main thread (`HEX_MAIN_THREAD`).
- A session that fails to start says why, in its topic.
- `reply` refuses to attach channel state or any `.env` file.
- General is the hub's main thread, named after `HEX_NAME`.
- A message that replies to an earlier one says which, in `reply_to_*`
  meta: its id, author, text or caption, the part highlighted, and the photo
  (downloaded) or file it carried. Upstream drops this (issue #2788).
- An edited message reaches the session again, marked `edited`, and a
  forwarded one names its sender in `forwarded_from`.
- A link's address is kept: Telegram puts it in the message's entities, so
  `[text](url)` goes back into the text.
- Locations, venues and contacts arrive as text instead of being dropped.

## Invariants

1. One bot connection, owned by the service. Sessions never poll Telegram.
2. Tools act on the caller's own thread unless they name another one, so
   they take no `chat_id`.
3. Messages to a forum's General go without a topic id; only chat actions
   use topic 1, which Telegram needs to show typing inside General.
4. A session says hello a second after connecting: Claude Code starts
   listening for channel notifications about 30ms after its last request to
   the server and never signals it.
5. Deliberately dropped from upstream, never ported back: pairing and
   `/telegram:access` (single user; `access.json` holds `allowFrom`), bot
   commands, permission relay, and the `bot.pid` takeover.
6. Inside a topic, Telegram makes every message a reply to the topic's
   creation message; those carry no `reply_to_*` meta.
7. Keep upstream's wording and structure wherever code is shared, so heals
   stay small.

## Verification

Both halves build and the hub tests pass. Run `scripts/verify`.

## Removal

Remove this patch when upstream's Telegram channel routes forum topics to
separate sessions on its own.
