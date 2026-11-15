---
format: patch-md/v0.1
id: plugin-deps
summary: Lock the forked Telegram and Discord plugins to current releases of their dependencies; upstream's lockfiles still pin the versions they shipped with.
baseline: b5b01ac4f889fec0c4c6bb89f27ca7c8574473f6
patch_file: plugin-deps.patch
patch_sha256: 385308a81087c89f5801c224f38159f01327da9eb8c0fe4abb1b055bcb0b17df
---

## Intent

Keep `bun.lock` in `external_plugins/telegram` and `external_plugins/discord`
on current releases within the ranges each `package.json` allows (grammy
1.46.0, discord.js 14.27.0 at the time of writing), without the MCP SDK, which
the plugins dropped with `server.ts` (`telegram-topics`, `discord-threads`).
Upstream committed the lockfiles when it added the plugins and has never
updated them.

## Invariants

1. Change only `bun.lock`. The version ranges in `package.json` stay
   upstream's.

## Verification

`scripts/verify` installs from the lockfiles and builds each plugin's `bot.ts`.

## Removal

The daily sync runs `bun update` and refreshes this patch, so it tracks the
newest releases on its own. Remove it when upstream keeps its lockfiles
current.
