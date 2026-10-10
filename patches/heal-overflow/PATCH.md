---
format: patch-md/v0.1
id: heal-overflow
summary: Healed changes not yet attributed to a named patch package.
baseline: b8e53f1c05dff3b6d751297f6527990ffc81c2f4
patch_file: heal-overflow.patch
patch_sha256: 1cc797d1563d1b98ff5c1fd34c059b35372b9501b49cbdf3c75beacb67936040
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
