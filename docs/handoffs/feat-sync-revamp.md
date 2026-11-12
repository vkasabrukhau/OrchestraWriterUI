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
