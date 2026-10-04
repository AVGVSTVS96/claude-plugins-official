---
format: patch-md/v0.1
id: assistant-marketplace
summary: Name the marketplace assistant, so it installs beside the official one and its plugins load as telegram@assistant.
baseline: d182ca456ca09d31d139f7d3818d1d333b103cce
patch_file: assistant-marketplace.patch
patch_sha256: 0eb5374abe0191a67fda639700e1283b4ece73fdd59a200727dfb19dde30a0d0
---

## Intent

Rename the marketplace in `.claude-plugin/marketplace.json` from
`claude-plugins-official` to `assistant`. That lets this fork install next to
the official marketplace without a name clash, and its plugins load as
`<plugin>@assistant`, the identity managed settings allowlist as a channel
(`allowedChannelPlugins`).

## Invariants

1. Change only the marketplace `name`. Upstream's plugin list stays as it is.

## Verification

`scripts/verify` checks the name and that the `telegram` entry exists.

## Removal

Remove this patch when the fork is no longer installed as a marketplace
beside the official one.
