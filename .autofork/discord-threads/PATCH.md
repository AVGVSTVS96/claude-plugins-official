Discord's channel gives every thread its own session, through the hub
(`0-hub`), from one gateway connection the service owns, split from upstream's
`server.ts` the same way `telegram-topics` splits Telegram's: the gateway half
runs in the hub service and maps each thread to a session by its channel id,
and the channel half keeps upstream's tools and instructions as the channel
the hub serves each session over HTTP. Keep upstream's wording and structure
wherever the code is shared, so rebuilds stay small. Without
`DISCORD_BOT_TOKEN`, Discord stays off and the rest of the service runs.

Discord is where hex does deeper work, Claude-tag style. Tagging the bot in a
text or announcement channel starts a thread on that message with a fresh
session, which names the thread in one word; inside a thread every message
reaches its session, no tag needed. Forum posts get sessions like any thread,
and a new post's title comes with it instead of a rename. A DM is its own
conversation (a fresh thread), separate from every thread. Answers can be
longer and structured: the instructions say what Discord's Markdown renders
(headings, code blocks with a language, `-#` subtext, masked links, `<link>`
without a preview) and that it has no tables, and a code block cut across
messages is closed and reopened so both halves render. User, nickname and
role mentions are stripped from a message and from the thread name it starts.

A session reads the whole server, not just its own thread: messages name
their channel, it can list channels, page through a channel's top-level
messages with each thread's reply count and last reply, read any thread by
its starter message or name, list a forum's posts, and search the server
through Discord's guild search (which says when Discord is still indexing).
It reads only what the bot can see in its own server, never a DM. Posting
stays in the caller's thread or one it names, always as the bot itself.

A session can open a thread (its `about` line first, then the request that
asked for it and the replies since, forwarded as Discord forwards; in a forum,
a post with the tags it names; in Telegram or Buzz, through the hub), hand its
conversation to a Telegram topic or Buzz thread, close a thread (archived and
forgotten once its session stops; a new message brings it back with a fresh
session), post into another thread, delete, react and unreact, pin, forward,
poll, and edit a message's files. `reply` can be silent and carry buttons that
lock on the choice, or a menu that takes several picks at once. Every question
asked with buttons, a menu or a poll goes in the hub's ledger, as Telegram's
do, so hex's voice app can list it; one answered elsewhere (the app, a call)
locks on a line saying where and reaches the thread as the owner's tap would,
and one taken back is put back. Tools that take a message id find a thread's
starter message in the channel it hangs off, so a session can download the
screenshot a tag started the thread from.

What reaches a session: which message a reply answers, edits marked `edited`,
forwards with their text and attachments, voice messages as transcripts when
the hub has a transcriber, stickers and polls described, images downloaded on
arrival like Telegram's photos, and in a thread with a session the sender's
reactions, deletes (Discord doesn't say who deleted, so the bot's own deletes
are the only ones not reported) and votes on the bot's polls. A deleted
thread is forgotten with its questions. Typing follows the session's real busy
state, and a session that fails to start says why in its thread.

Permission prompts ask in the session's own thread, with the tool, its input
and Allow and Deny buttons that lock on the choice; one still open when the
turn ends with no background agents out was answered in the session itself.
Slash commands, registered on connect for the server and the bot's DM,
control a thread outside its conversation and answer only the owner,
privately: `/model`, `/effort`, `/compact` and `/stop`. A tap is answered
before anything is fetched, inside Discord's three seconds. A first login that
fails, as with no network at boot, is retried with backoff; only a bad token
is final. Once connected, the bot writes its server's id to `guild.json` so
the voice app can link to threads.

The owner joining one of the server's voice channels calls hex there: the bot
joins with `@discordjs/voice` (with DAVE end-to-end encryption, which Discord
requires) and hands the call to the voice plugin's call engine through the
hub, so it's the same session, record and task board as a phone call. It
passes the owner's audio decoded to 24 kHz mono, sending their quiet as
silence since the voice takes its turn on hearing it, and plays the voice's
audio widened to 48 kHz stereo in stretches of speech, so the bot shows as
speaking only while it talks. One call at a time, and only the owner is
heard. Leaving or moving channels, or hex hanging up, ends it.

Dropped from upstream on purpose, not to be ported back: pairing and
`/discord:access` (one user; `access.json` holds `allowFrom`) and the
per-channel opt-in. Permission relay came back, asked in the session's own
thread instead of every allowlisted DM.

This patch is done when upstream's Discord channel routes threads to separate
sessions on its own.
