---
format: patch-md/v0.1
id: assistant-marketplace
summary: Name the marketplace assistant, so it installs beside the official one and its plugins load as telegram@assistant.
baseline: d4226d062928f8d9505dbdeadd10217d23361052
patch_file: assistant-marketplace.patch
patch_sha256: 075d7c3ed21246b17be00ef147d654a51ee57b000b8337033566640e72554882
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
