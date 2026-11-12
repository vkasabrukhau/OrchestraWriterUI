---
name: sync-data-conventions
description: Sync/marker data rules seen in the 2026-11-09 sync-revamp plan review (additive fields keep .ovproj v1, marker position semantics, anchored bars get confidence 100, perf-budget pitfalls)
metadata:
  type: project
---
Things to re-check on any change to `src/shared/sync.ts`, markers, range runs or the Sync page:

- **Additive optional fields keep `.ovproj` at version 1.** ADR 0016 added `ManualMarker.position` this way; the sync-revamp plan (ADR 0018) does the same for `label`. A version bump is expected only when a field is removed, renamed or changes meaning. Re-interpreting existing values (like snapping old positions) counts as a meaning change, so it needs a migrate-on-read step.
- **Marker position has two sources.** `ManualMarker.position` is a fraction of the bar in score seconds. OSMD's `pickInBar` returns a fraction in musical time. `sameMarkerSpot` uses `1e-6`, so one note can end up with two markers. Check that legacy rows and files get canonicalized too, not only new writes.
- **`mergeAlignment` sets confidence 100 on any bar with a manual anchor.** One-click "adopt" therefore hides uncertainty. The PR should state this.
- **Server `parseSync` stores the body as given.** Extra keys persist. The mock `saveSync` does no validation, so check parity claims.
- **Alignment jobs rebuild SyncState from the aligner result.** `http.ts startAlignment` writes `{ ...result, manual }`, and the mock does the same. Any new top-level SyncState field (for example a `positionBasis` flag) is silently dropped on a whole-piece re-run unless the job carries it over.
- **Width changes rescale OSMD with no re-layout.** ADR 0016 measures 0.3–0.4 s per resize, so a continuous horizontal drag still needs deferring. `<Profiler onRender>` does not fire in production builds unless the build uses `next build --profile`.
- **Spreading the previous sync under the aligner result** (`{ ...previous, ...result }`) keeps stale `diagnostics` when the result has none. The chroma DTW fallback returns no diagnostics; only the integrated aligner does.
- **Playwright `webServer` is top-level, not per project** (playwright.config.ts uses one server on :3000 with `reuseExistingServer` locally). A perf suite with its own production server needs its own config file and port.
- **`next start` runs with NODE_ENV=production.** `src/server/config/env.ts` then requires every DB, S3 and auth variable. `BETTER_AUTH_URL` defaults from `PORT`, not from the `-p` flag, and it sets `trustedOrigins`. A second server on another port needs an explicit env block, like the CI e2e job has.
- **Perf traps in this codebase.** `Transport` subscribes to `time` and re-renders its `Waveform` every frame. `toAlignAudio` downmixes the whole recording, which is about 200 MB for 18 minutes. Decoded `AudioBuffer` memory does not show in JS heap metrics. Any width change re-engraves OSMD.

**Why:** These were real gaps in the plan and the current code, and they come back whenever markers or the Sync UI change.

**How to apply:** Grep for these before reading a sync diff line by line. Related: [[recurring-review-findings]].
