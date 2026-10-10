---
format: patch-md/v0.1
id: fork-readme
summary: Open the README with a note that says what this fork is, what its patches do, and how it stays current.
baseline: b8e53f1c05dff3b6d751297f6527990ffc81c2f4
patch_file: fork-readme.patch
patch_sha256: f270d221aa4038bf3061ba5b985c3a6760922ea2c780196e11fc6015703c77d2
---

## Intent

Put a note at the very top of `README.md` that says this is an auto-patched
fork of `anthropics/claude-plugins-official`, what it's for, what each patch
package changes (linking each `PATCH.md`), and how the daily sync keeps it on
the latest upstream. Everything after the note is the upstream README,
unchanged.

## Invariants

1. The note comes first and ends by saying the rest is upstream's README.
2. Nothing below the note differs from upstream.

## Verification

The note is the first block of `README.md`, its links resolve, and the rest
of the file matches upstream byte for byte.

## Removal

Remove this patch when the fork is retired.
