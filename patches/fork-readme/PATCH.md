---
format: patch-md/v0.1
id: fork-readme
summary: Open the README with a note that says what this fork is, what its patches do, and how it stays current.
baseline: d182ca456ca09d31d139f7d3818d1d333b103cce
patch_file: fork-readme.patch
patch_sha256: 3675f2a2bf0146cb1067fbe79d16911c742e181c74e9d96237b878aa37cd7290
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
