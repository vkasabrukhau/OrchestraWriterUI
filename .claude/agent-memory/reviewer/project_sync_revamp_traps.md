---
name: sync-revamp-traps
description: Code-level traps found reviewing the Sync page revamp plan (2026-11-09, rounds 1-4) to re-check when its PRs land: marker bounds vs merge floor, chroma DTW pinned ends on range windows, OSMD stamp vs info-map fraction, task-file overlap
metadata:
  type: project
---
These came up reviewing `docs/plan/sync-page-revamp-plan.md` on 2026-11-09. Re-check them when the T1/T4/T10/T11 PRs arrive.

- **Marker bounds and the merge floor.** `mergeAlignment`'s final pass forces `MIN_ALIGNMENT_GAP` between every bar start and point. Bounds that only look at manual anchors let the floor push a manual anchor off its time, so manual no longer wins. Bounds need gap × (knots between) of slack.
- **Chroma DTW is not subsequence.** Its open ends are cheap only over silence. On a padded range window it stretches the slice over the padding. The integrated broad match is subsequence, so it is fine there.
- **Range splice is not invisible outside the range.** A manual marker with position > 0 in bar from−1 gets its auto time from `spanOf(auto, i)`, which reads `auto[from]`. Changing the slice can move merged times before the range.
- **Range splice, more broadly.** When manual anchors sit inside the range, their auto times change, so merged times change on both sides out to the nearest anchor outside the range. Only with no anchors inside are the outside bars exactly unchanged.
- **Top-level SyncState flags get lost.** `http.startAlignment` saves `{ ...result, manual }`, which drops any top-level field that isn't in the aligner result (rev 2 added `positionBasis` and `runs`). Check that every whole-piece save path carries them over.
- **Fixed-anchor merge needs a fallback.** If anchors are out of order or too close together (legacy rows, API writes that skipped bounds), a final pass that never moves anchors can produce non-monotonic output.
- **Bounds next to an unhonoured anchor.** If a neighbouring anchor was pushed (it is in the unhonoured list), bounds computed from its `startSec` no longer guarantee the edit lands exactly. Bounds must use the neighbour's merged time.
- **Playwright `webServer` is top-level only.** A "perf project with its own webServer" needs a separate config file (`-c`), not a project entry (`playwright.config.ts` has a single chromium project today).
- **A second app server needs auth env.** Better Auth's `baseURL` and `trustedOrigins` come from `PORT` / `BETTER_AUTH_URL` (`src/server/config/env.ts:44,117`; `auth.ts:17`). `next start -p N` alone leaves them at :3000, so sign-in from the other port fails the origin check. Set `PORT` and `BETTER_AUTH_URL` explicitly.
- **Two position meanings.** OSMD `relInMeasureTimestamp/Duration` is a musical fraction. `ManualMarker.position` is a fraction in score seconds. They differ when the tempo changes inside a bar, beyond any small snap tolerance.
- **Plans with parallel tasks.** Check whether "parallel" tasks touch the same files (SyncPage.tsx, Transport.tsx) and whether shared stores or components are created in a task that the others depend on.

- **Changed-since-sync baseline (rev 7).** If a range run resets the whole baseline, the hatch clears on edited bars outside the range that were never re-synced. Segment boundaries merged away (under 4 bars / 2 s) mean that marker never constrained the fit, yet its bar shows as re-synced. Owner rule: confidence changes only after a re-sync *with* the marker. Rev 8 persists `SyncState.changed`. A range run must also *add* any bar outside the range whose merged time moved (see the range splice leak above), not only clear the bars inside it.

- **Pending/applied markers (rev 9).** The owner decided markers are "visual until recompute". Timing reads `merge(auto, applied)`. Things to check:
  - Range windows must be planned from `merge(auto, applied′)`, not the audible timing, or a far-off pending downbeat at the range edge falls outside the window with only 0.25 s of padding.
  - The default recompute range must stay local (the owner said "marker's bar plus a few around it"), not span every pending bar.
  - Continuing to Customize with pending markers needs a notice.

**Why:** The plan's "manual markers always win" and "bars outside the range unchanged" claims depend on these details.

**How to apply:** When reviewing diffs for markerBounds, range runs or canonicalPosition, look for tests that cover each item. Related: [[recurring-review-findings]].
