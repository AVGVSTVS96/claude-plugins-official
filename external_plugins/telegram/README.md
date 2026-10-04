# Telegram

A fork of the official Telegram channel where every forum topic in a group is its own Claude Code session. Its intent, invariants and what changed from upstream live in [`patches/telegram-topics/PATCH.md`](../../patches/telegram-topics/PATCH.md).

- `bot.ts` holds the one bot connection and runs as a service: `bun run bot`. It runs sessions in `ASSISTANT_DIR`, `~/assistant` by default.
- `server.ts` is the channel each session loads. A session learns its topic from `ASSISTANT_THREAD`.

The bot token lives in `~/.claude/channels/telegram-hub/.env` as `TELEGRAM_BOT_TOKEN=…`, and `access.json` there holds `allowFrom`, the Telegram user ids allowed to talk to it.
