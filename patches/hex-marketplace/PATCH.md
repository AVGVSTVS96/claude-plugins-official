---
format: patch-md/v0.1
id: hex-marketplace
summary: Name the marketplace hex, so it installs beside the official one and its plugins load as telegram@hex.
baseline: d4226d062928f8d9505dbdeadd10217d23361052
patch_file: hex-marketplace.patch
patch_sha256: 01d313d8d7c30ccbb28a333362fd39735d4d8f5b786f07532376b7f5911099ef
---

## Intent

Rename the marketplace in `.claude-plugin/marketplace.json` from
`claude-plugins-official` to `hex`. That lets this fork install next to
the official marketplace without a name clash, and its plugins load as
`<plugin>@hex`, the identity managed settings allowlist as a channel
(`allowedChannelPlugins`).

## Invariants

1. Change only the marketplace `name`. Upstream's plugin list stays as it is.

## Verification

`scripts/verify` checks the name and that the `telegram` entry exists.

## Removal

Remove this patch when the fork is no longer installed as a marketplace
beside the official one.
