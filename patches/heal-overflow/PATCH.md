---
format: patch-md/v0.1
id: heal-overflow
summary: Healed changes not yet attributed to a named patch package.
baseline: ea10b213686c90bb1984b2016937310e05336cf3
patch_file: heal-overflow.patch
patch_sha256: 820ee01c91d956c22d05dfcbe77dce1d6fc609cef1a580f065aaa678bee622a6
---

## Intent

Preserve heal output that no named patch package claims, so the next
deterministic sync reproduces the full verified tree unchanged.

## Verification

`git apply` succeeds against the baseline and the synced tree passes
`scripts/verify`.

## Removal

Reassign these hunks to the named packages whose intents they
implement; refresh deletes this package automatically once no
unassigned changes remain.
