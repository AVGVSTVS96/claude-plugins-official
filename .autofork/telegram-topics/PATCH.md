Telegram's channel gives every forum topic its own session, through the hub
(`0-hub`), from one bot connection the service owns: sessions never poll
Telegram. hex lives in a Telegram forum. General is its main thread, each
topic is a piece of work with a session of its own, and a DM to the bot is a
separate conversation (a fresh thread, in the hub's terms), not General.

Upstream's single-session `server.ts` splits in two. The bot half (polling,
the allowlist, attachments and the Telegram calls) runs in the hub service
and maps each topic, or a plain chat, to a thread. The channel half keeps
upstream's tools and instructions as the channel the hub serves each session
over HTTP, so `.mcp.json` points at the hub instead of running
`bun server.ts`. Keep upstream's wording and structure wherever the code is
shared, so rebuilds stay small. Tools act on the caller's own thread unless
they name another, so they take no `chat_id`.

On top of upstream, a session can open a topic with a fresh session (or a
Discord or Buzz thread, through the hub), hand its conversation to Discord or
Buzz and close the topic (from General, a copy continues there instead), close
its topic, post into another topic by name, rename a topic or change its icon
(every new topic gets a random one), pin, forward, delete, send polls whose
votes come back as messages, and change a file's caption or replace the file.
A new topic starts with the request that asked for it and the replies since,
forwarded. Typing follows the session's real busy state, and a session that
fails to start says why in its topic. `reply` takes ordinary Markdown, sent as
Telegram's rich message so sessions never escape MarkdownV2 (a code block cut
between chunks is closed and reopened); buttons, where a tap comes back as the
label and the message keeps only the chosen button, disabled; silent sends;
and files without text, with photos over Telegram's 10MB cap sent as
documents. It refuses to attach channel state or any `.env`. `reply` and
`react` are always loaded, so a session's first reaction needs no tool search.

What reaches a session is fuller than upstream's. A reply says which message
it answers, with its author, text, highlighted part and photo or file, even
in another chat (upstream drops this, issue #2788). Edits arrive again marked
`edited`, forwards name their sender, links keep their address (Telegram puts
it in the entities), and locations, venues, contacts, polls, dice and games
arrive as text instead of being dropped. A voice message arrives as its
transcript when the hub has a transcriber. A photo album is one message:
Telegram never says an album is complete, so the bot waits a second after its
last item. The user's reactions reach the thread of the message they're on;
Telegram's update names neither the topic nor the text, so the hub remembers
both for every message it sees until the thread is forgotten.

Permission prompts go to the asking session's own topic with Allow and Deny.
Only an allowlisted user's tap answers, and it goes to Claude Code as the
verdict, not to the session as a message. A prompt still open when its session
goes idle with no background agents out was answered in the session itself,
so it says it's no longer waiting.

Telegram details a rebuild has to keep: messages to a forum's General go
without a topic id, but typing in General needs topic 1; inside a topic every
message is a reply to the topic's creation message, and those carry no reply
meta; the Bot API has no event for a deleted topic, so a call that fails
because its topic is gone forgets it; and a session's channel opens a second
after it lists its tools, since Claude Code starts listening tens of
milliseconds later and never says so. Once polling, the bot writes its
username to `bot.json` so the voice app can link to the DM. The instructions
drop upstream's line that the Bot API has no history: hex keeps every
conversation, so a session looks there.

Dropped from upstream on purpose, not to be ported back: pairing and
`/telegram:access` (one user; `access.json` holds `allowFrom`), bot commands,
the permission relay to every allowlisted DM, and the `bot.pid` takeover.

This patch is done when upstream's Telegram channel routes forum topics to
separate sessions on its own.
