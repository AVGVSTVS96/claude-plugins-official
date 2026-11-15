---
format: patch-md/v0.1
id: hex-marketplace
summary: Name the marketplace hex, so it installs beside the official one and its plugins load as telegram@hex, and list the Buzz and voice channels.
baseline: b5b01ac4f889fec0c4c6bb89f27ca7c8574473f6
patch_file: hex-marketplace.patch
patch_sha256: 33602be417be9421bc8c09a29366730037d28abe9fbbebf427c98269f3c00e9e
---

## Intent

Rename the marketplace in `.claude-plugin/marketplace.json` from
`claude-plugins-official` to `hex`. That lets this fork install next to
the official marketplace without a name clash, and its plugins load as
`<plugin>@hex`, the identity managed settings allowlist as a channel
(`allowedChannelPlugins`).

List `buzz`, the Buzz channel this fork adds in `external_plugins/buzz`
(`buzz-threads`), so it installs as `buzz@hex`, and `voice`, the voice call
channel in `external_plugins/voice` (`voice`), as `voice@hex`.

## Invariants

1. Change only the marketplace `name` and add the `buzz` and `voice` entries. Upstream's
   plugin entries stay as they are.

## Verification

`scripts/verify` checks the name and that the `telegram`, `discord` and
`buzz` entries exist.

## Removal

Remove this patch when the fork is no longer installed as a marketplace
beside the official one.
