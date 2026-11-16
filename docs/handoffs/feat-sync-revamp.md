# Handoff log — feat/sync-revamp

Append-only. Newest entry at the bottom. Written by `/handoff`.

---

## 2026-11-10 — Sync page revamp (owner's workspace) built on top of the score-navigation work

**Done**
- **Data (`src/shared/sync.ts`, `src/lib/score/stamps.ts`, `src/lib/store/project.ts`, `useProjectTiming.ts`, `src/server/routes/projects.ts`, `src/lib/api/{http,mock,sync-run}.ts`):**
  - markers are pending until a recompute (`manual` vs `applied`); the merge keeps the aligner's confidence and never goes non-monotonic;
  - marker labels; one shared validator (`parseSyncState`);
  - legacy positions normalized; the score converts OSMD musical fractions in all five places;
  - import warnings; export plays applied markers only.
- **Sync function (`src/lib/align/{sync-function,range,methods,select}.ts`, `src/lib/audio/{decode,peaks}.ts`):** a black-box `runSync` with range runs (window planned from the timing the run will produce, splice, seam clamp) and Smooth/Rigid; the peak pyramid for the zoomable waveform.
- **UI:**
  - **Workspace (`src/components/sync/**`, `ui/Panes.tsx`, `shell/WorkflowMain.tsx`):** one box with sections divided by lines (confidence map / score / joint playback), plus a sidebar with Measures, Markers and Sync.
  - **Markers:** the one-item right-click menu, a marker popover, Undo (Cmd/Ctrl+Z), the recompute suggestion, and the Continue guard.
  - **Joint playback:** the piano roll over the waveform with drag handles and time, pitch and peak zoom.
  - **Elsewhere:** Help; a pending-markers notice on Preview and Export; speed applies to the recording only; `MeasureTimeline.tsx` and `neighborTimes` are deleted.
- **Tests:**
  - new unit tests: `tests/unit/sync/{markers,workspace-logic}.test.ts`, `tests/unit/score/stamps.test.ts`, `tests/unit/align/range.test.ts`;
  - new e2e: `tests/e2e/sync-workspace.spec.ts`;
  - updated e2e: `workflow-recording`, `score-navigation`, `open-project`.
- **Docs:**
  - plan: `docs/plan/sync-page-revamp-plan.md` (revisions 1–9, round-8 fixes and the owner's layout changes);
  - owner notes and answers: `docs/plan/sync-page-revamp.md`;
  - rules: `.claude/rules/sync.md`.

**Decisions**
- ADR 0017 (workspace; in-house panes instead of `react-resizable-panels`, so no new dependency).
- ADR 0018 (markers are visual until a recompute; confidence only from runs).
- ADR 0019 (black-box sync function, range runs, Smooth now and Rigid later).
- ADR 0020 (joint playback).
- All four are "proposed". Owner answers are recorded in `docs/plan/sync-page-revamp.md`.

**Open questions / blockers**
- **Nothing is committed.** This branch was cut from `feat/integrated-sync` with all of that branch's uncommitted work too (ADRs 0014–0016). That branch's work needs its own commit and PR first (plan T0).
- **Owner to confirm defaults:**
  - the recompute suggestion threshold (> 250 ms, or 5 or more pending);
  - deletions also wait for a recompute;
  - the layout is remembered per browser.
- **Not done from the plan:**
  - the perf suite (`playwright.perf.config.ts`, stress fixture, route-size script, baseline);
  - the roll's time-sliced index and level-of-detail bins (check on the owner's 354-bar Tchaikovsky score);
  - the sidebar overlay under 1024 px;
  - the shortcuts list (only Help for now);
  - jsdom component tests (local Node 22.14 can't run jsdom; CI's Node 24 can; `.nvmrc` not added);
  - the `legacy-v1.ovproj` and `mid-bar-tempo.musicxml` fixtures and their e2e checks.

**Next steps**
1. Open the owner's 354-bar project on Sync and check speed: roll index build, drag smoothness, list commits. Add time-slicing or level-of-detail bins if needed.
2. Commit `feat/integrated-sync`, open its PR, then commit this branch on top.
3. T0 perf setup and baseline; the stress fixture.
4. Add the legacy-file and mid-bar-tempo fixtures and e2e steps; add the jsdom component tests (run in CI or with Node 24).
5. The sidebar overlay for narrow windows; the shortcuts popover.

**Verified by**
- `npx tsc --noEmit -p .`: clean.
- `npx eslint src tests/unit tests/e2e`: clean.
- `npx vitest run --project unit`: 343 passed.
- `npx playwright test` on `workflow-recording`, `score-navigation`, `open-project`, `sync-workspace` and `workflow-score-only`: all passed. `sync-workspace` passed 3 more times with `--repeat-each=3`.
- Checked by eye in Chromium screenshots at 1440×900.

## 2026-11-12 — Markers as fixed anchors; branch committed and rebased for one PR

**Done**
- Aligners (`src/lib/align/anchors.ts`, `dtw.ts`, `index.ts`, `integrated/{index,coarse,optimize}.ts`, `sync-function.ts`): applied markers are fixed anchors inside both aligners. The broad match and DTW may not cross them, the joint fit holds a knot on each, and the tempo around them is refitted. Tests in `tests/unit/align/anchors.test.ts`.
- `src/shared/sync.ts`: strict `parseSyncState` rejects an `averageConfidence` outside [0, 100] again (an API test caught the revamp clamping it).
- Git: all the uncommitted work (integrated sync + revamp) is now 5 commits on `feat/sync-revamp`, rebased onto `origin/main` (47a07ce). The owner chose one PR with several commits instead of separate `feat/integrated-sync` and revamp PRs. `feat/integrated-sync` is now unused.
- `docs/STATE.md` updated for this branch (the PR that merges it); `.claude/rules/sync.md` and ADR 0019 updated for anchors.

**Decisions**
- ADR 0021 (`docs/decisions/0021-markers-as-alignment-anchors.md`): markers are hard anchors in the fit; `mergeAlignment` stays as the final monotonic pass. Proposed.
- One PR for the integrated-sync and revamp work (owner, 2026-11-12).

**Open questions / blockers**
- Not pushed and no PR opened yet; waiting for the owner's OK.
- The anchors have only been tested on synthetic audio. They still need a check on the owner's 354-bar Tchaikovsky project with a real recording.
- Hard vs soft anchors: a rough marker now bends the fit around it. Revisit if users place markers loosely (ADR 0021).
- Local environment: `npm ci` fails with EACCES on `~/.npm/_cacache` in the sandbox (worked with `--cache` in a temp dir); `docker` is at `~/.docker/bin`, not on PATH.
- The defaults from the previous entry still need the owner's confirmation (recompute threshold, deletions waiting, per-browser layout).

**Next steps**
1. Optionally run the `reviewer` agent on `origin/main..HEAD`.
2. Push `feat/sync-revamp` and open the PR. Its body should note the OSMD dependency (BSD-3-Clause; Verovio excluded as LGPL-3.0).
3. On the Tchaikovsky project: place markers on wrong bars, recompute, check that the bars after them improve. Also check the roll and drag speed (previous entry, step 1).
4. Delete the stale `feat/integrated-sync` branch once the PR is up.
5. The remaining items from the previous entry (perf suite, fixtures, jsdom tests, narrow-window sidebar).

**Verified by**
- On the rebased branch: `npm run lint` clean; `npm run typecheck` clean.
- `npm test`: 353 passed (31 files).
- `npm run test:api` (Postgres + S3Mock via docker compose): 57 passed, after the strict-validation fix (1 failed before it).
- `npm run test:e2e`: 14 passed (2.6 min).
