---
format: patch-md/v0.1
id: telegram-deps
summary: Lock the Telegram plugin to current releases of its dependencies; upstream's lockfile still pins the versions it shipped with.
baseline: d182ca456ca09d31d139f7d3818d1d333b103cce
patch_file: telegram-deps.patch
patch_sha256: f7d0bdb6854560c4924ecf507b586c1955a4f105c8f1df91bece15da1ee89f61
---

## Intent

Keep `external_plugins/telegram/bun.lock` on current releases within the
ranges `package.json` allows (MCP SDK 1.32.0, grammy 1.46.0 at the time of
writing). Upstream committed the lockfile when it added the plugin and has
never updated it.

## Invariants

1. Change only `bun.lock`. The version ranges in `package.json` stay
   upstream's.
2. The plugin stays on `@modelcontextprotocol/sdk` 1.x. The 2.x SDK
   (`@modelcontextprotocol/server`) speaks MCP revision 2026-07-28,
   on which Claude Code doesn't register channels.

## Verification

`scripts/verify` installs from the lockfile and builds `bot.ts` and
`server.ts`.

## Removal

The daily sync runs `bun update` and refreshes this patch, so it tracks the
newest releases on its own. Remove it when upstream keeps its lockfile
current.
