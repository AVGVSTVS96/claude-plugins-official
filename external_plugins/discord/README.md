# Discord

A fork of the official Discord channel where every thread in a server is its own Claude Code session, Claude-tag style: tag the bot in a channel and it starts a thread on your message, with a fresh session working inside it. Its intent, invariants and what changed from upstream live in [`patches/discord-threads/PATCH.md`](../../patches/discord-threads/PATCH.md).

- `bot.ts` holds the one gateway connection. It runs in the hub service (`bun hub/serve.ts`) next to Telegram, so a conversation can move between them. It runs sessions in `ASSISTANT_DIR`, `~/assistant` by default.
- `server.ts` is the channel each session loads. A session learns its thread from `ASSISTANT_THREAD`.

The bot token lives in `~/.claude/channels/discord-hub/.env` as `DISCORD_BOT_TOKEN=…`, and `access.json` there holds `allowFrom`, the Discord user ids allowed to talk to it. The bot needs the Message Content intent, and in its server: View Channels, Send Messages, Send Messages in Threads, Create Public Threads, Manage Threads, Read Message History, Attach Files and Add Reactions.
