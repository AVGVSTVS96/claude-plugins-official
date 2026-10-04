---
format: patch-md/v0.1
id: assistant-marketplace
summary: Name the marketplace assistant, so it installs beside the official one and its plugins load as telegram@assistant.
baseline: 2f189354595613190f575ab1f7510f3a94150022
patch_file: assistant-marketplace.patch
patch_sha256: 038c475a92e74df6de1c0e7cd1898cf56f8017b938032e31a7c5c1964c1f52bd
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
