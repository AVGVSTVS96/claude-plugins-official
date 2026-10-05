---
format: patch-md/v0.1
id: plugin-deps
summary: Lock the forked Telegram and Discord plugins to current releases of their dependencies; upstream's lockfiles still pin the versions they shipped with.
baseline: d4226d062928f8d9505dbdeadd10217d23361052
patch_file: plugin-deps.patch
patch_sha256: 9ba57cdd6024519d26f3751bac049ebfa8540d5fcb18d3fcfe305a70b994bbfb
---

## Intent

Keep `bun.lock` in `external_plugins/telegram` and `external_plugins/discord`
on current releases within the ranges each `package.json` allows (MCP SDK
1.32.0, grammy 1.46.0, discord.js 14.27.0 at the time of writing). Upstream
committed the lockfiles when it added the plugins and has never updated them.

## Invariants

1. Change only `bun.lock`. The version ranges in `package.json` stay
   upstream's.
2. Both plugins stay on `@modelcontextprotocol/sdk` 1.x. The 2.x SDK
   (`@modelcontextprotocol/server`) speaks MCP revision 2026-07-28,
   on which Claude Code doesn't register channels.

## Verification

`scripts/verify` installs from the lockfiles and builds each plugin's `bot.ts` and
`server.ts`.

## Removal

The daily sync runs `bun update` and refreshes this patch, so it tracks the
newest releases on its own. Remove it when upstream keeps its lockfiles
current.
