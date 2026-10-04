# PATCH.md format

`PATCH.md` is the authoritative, human-readable contract for a patch. A
unified diff is only its deterministic fast path: consumers should try the
diff first, then use the contract to reconstruct the change if it no longer
applies.

## Version `patch-md/v0.1`

Every document uses YAML frontmatter with these core fields:

```yaml
---
format: patch-md/v0.1
id: example-patch
summary: A concise description of the user-visible change.
baseline: 0123456789abcdef0123456789abcdef01234567
---
```

The external form adds these fields to the same frontmatter:

```yaml
patch_file: example-patch.patch
patch_sha256: 0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef
```

`baseline` is the full commit SHA the patch was generated against.
`patch_file` is a sibling unified diff, and `patch_sha256` is the lowercase
SHA-256 of that file. The diff stays directly usable with `git apply`.

The body contains these sections:

- `## Intent` describes the behavior the patch must provide.
- `## Invariants` is optional and records behavior that must survive healing.
- `## Verification` states how to prove the implementation is correct.
- `## Removal` gives the exact condition for deleting the patch.

An all-in-one document may omit `patch_file` and `patch_sha256` and instead
contain one unified diff fence under `## Patch`. A document must use exactly
one form: external or inline. This repository uses external diffs so its
automation can call `git apply` directly, and each package directory contains
exactly its `PATCH.md` and referenced `.patch` file.

Discovery order, dependency ordering, overlap policy, trusted paths, and
whether a healed result may publish automatically are consumer policies, not
part of the document format.

This repository's sync workflow publishes heals unconditionally once `scripts/verify` passes. When a heal
changes paths no package claims (upstream renames or file splits), the
refresh step sweeps those hunks into an auto-managed `patches/heal-overflow/`
package so the next deterministic sync reproduces the full verified tree.
Reassign its hunks to the right named package; refresh deletes the overflow
package once nothing unassigned remains.
