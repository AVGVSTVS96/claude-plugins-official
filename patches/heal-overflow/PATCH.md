---
format: patch-md/v0.1
id: heal-overflow
summary: Healed changes not yet attributed to a named patch package.
baseline: ea10b213686c90bb1984b2016937310e05336cf3
patch_file: heal-overflow.patch
patch_sha256: 7d50488191fef7c037374d28b7c36b3082a02ca1e14b4d2f5ea623bf020c827c
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
