---
name: integrated-aligner-traps
description: Traps found reviewing the integrated aligner parity/jumps/marker-localize work on feat/redline-sync (2026-11-15) — slope-based jump detection after anchorMapping, per-measure wedge stops, filterbank memory, shared working tree
metadata:
  type: project
---
Found reviewing `a02d85a..9a3bf7b` on `feat/redline-sync` (2026-11-15). Re-check these on later aligner diffs:

- **Jump detection by seed slope.** `optimize.ts` marks a seed segment as a DTW jump when its slope is above 2.05 or below 1/2.05. DTW (1,2) steps have slope exactly 2. Once `anchorMapping` stretches a stretch by more than 2.5% (or the 30 s taper adds a correction/30 slope), those ordinary steps cross the threshold. A 4% stretch flagged 200 of 599 segments, so the continuity term disappears exactly where markers sit. Jumps should be passed as spans from the DTW step codes, not inferred from slopes.
- **Wedge stop at a bar's start.** `parse.ts` resets `lastEvent` per measure, so a `<wedge type="stop">` before the first note of a bar drops the hairpin. That is the usual encoding for a hairpin that ends at a barline. The hairpins fixture keeps every stop inside its own bar, so the tests miss it.
- **Filterbank memory.** `pitchFeatures` allocates a Float64 work buffer the length of the 22050 Hz signal (about 190 MB for 18 minutes), plus the decimated copies and the source samples, all inside the worker.
- **Production code importing the experiment.** `integrated/features.ts` imports `resampleTo` from `redline/audio`, but ADR 0023 says the redline module is removable.
- **The working tree is shared with other agents.** Other agents edited files and committed (ADR 0024 landed) while this review ran. Run tests and typecheck in a `git worktree` at the reviewed commit, with node_modules symlinked in, not in the main checkout. Run `npm run typecheck` rather than bare tsc, because bare tsc skips next typegen and reports `PageProps` errors.

**Why:** All tests passed with these problems in place. Synthetic-audio accuracy tests don't cover anchored stretches or real-world MusicXML encodings.

**How to apply:** When a diff touches `optimize.ts` break handling, wedge parsing or the filterbank, check these first. Related: [[sync-revamp-traps]], [[plan-review-pitfalls]].
