# Sync page revamp: implementation plan (revision 9)

Date: 2026-11-09 · Base: `feat/integrated-sync` (uncommitted: ADRs 0014–0016, integrated aligner, engraved score).
Sources: `docs/plan/sync-page-revamp.md` (owner notes and answers), CLAUDE.md, STATE.md, `docs/spec/*`, ADRs 0012–0016, `.claude/rules/*`, and the code named in each task.
The owner's answers override earlier lead decisions. Where the owner notes contradict each other, the newest statement wins and the conflict is flagged in §7. Removed features are listed in §9.

## Review criteria

Reviewers score each criterion 0–10, and implementation starts when all are at 10. **G has the highest priority.** If a fix for another criterion conflicts with what the owner wants, G wins, and the conflict goes to the owner instead of being settled against their notes.

| ID | Criterion |
|---|---|
| A | Scope and spec fidelity: every item in the owner's notes covered, MVP scope and design principles respected |
| B | Technical correctness against the code |
| C | Large-score performance (42 parts, 480 bars) |
| D | Data and project-file integrity |
| E | UX and accessibility |
| F | Testability and incremental delivery |
| G | **What the owner wants, and fit with the product's syncing purpose.** The page does what the owner described, in the way they described it: their notes and clarifications in `docs/plan/sync-page-revamp.md`, and their standing constraints (follower not editor, note-level markers and navigation, large orchestral scores). Every piece serves syncing a score to a recording (auto alignment, manual markers, confidence per measure). Nothing drifts toward editing the score, the visualizer, or later-phase features. Lead decisions made on the owner's behalf are flagged where they might not match what the owner wants. |

---

## 0. Facts in the current code that shape the plan

1. **Per-frame re-renders.** `SyncEditor` and `Transport` (Transport.tsx:103) both subscribe to `usePlayback((s) => s.time)`. Both re-render every frame, and Transport redraws its Waveform SVG each time.
2. **Repeated merges.** Every `useProjectTiming()` call runs its own `mergeAlignment(sync.auto, sync.manual)` memo. Timing, playback, the Stage, and MP4 export (`http.exportMp4`, http.ts:349) all read this merge. Today, a marker edit is therefore audible at once.
3. **Musical vs time fractions.** OSMD onsets are **musical** fractions of the bar (engrave.ts:138). EngravedScore treats musical and seconds fractions as the same thing in five places: `pickedAt`, `describe`, `spotX`, the playhead (`fractionInBar` → `playheadX`, EngravedScore.tsx:429), and the range rects (~606). As a result, stored note markers are musical fractions when they come from clicks and seconds fractions when they come from Go to by time.
4. **`mergeAlignment` behavior.** It sets `confidence = 100` on anchored bars (asserted in merge.test.ts:47,64). Its final pass (sync.ts:170–180) pushes every knot past the previous one plus `MIN_ALIGNMENT_GAP`, **anchors included**.
5. **Edit bounds.** `neighborTimes` bounds an edit by every merged knot, automatic bar starts included.
6. **Aligner.**
   - The aligner has no anchor input. `optimizeMapping` has only a weak endpoint residual (optimize.ts:248); see also ADR 0014.
   - Integrated alignment needs at least 2 s (integrated/index.ts:135).
   - `runAlignment` falls back to chroma DTW and then returns `method: "chroma-dtw"` (select.ts).
7. **Writers.**
   - Jobs save `{ ...result, manual: project.sync?.manual ?? [] }` (http.ts:329, mock.ts:373).
   - Only the integrated aligner returns `diagnostics` (integrated/index.ts:208).
   - `openProjectFile` keeps `method` and `diagnostics` even when it discards `auto` (http.ts:449).
8. **Duplicate markers.** `addMarker` on a note that already has a marker creates a new marker (project.ts:415).
9. **Validation.** `parseSync` stores unknown keys. `assertProjectShape` only checks that `auto` and `manual` are arrays.
10. **Keys.**
    - `PlaybackShortcuts` listens on `window` and skips only `role="slider"`.
    - ←/→ only seek (Transport.tsx:58–67). Enter plays from the cue and Home seeks (68–71).
    - EngravedScore owns Cmd/Ctrl+G, PgUp/PgDn, and Esc in Go to.
11. **Score layout.** EngravedScore has a fixed height. `scale` follows the ResizeObserver width (EngravedScore.tsx:156), and each rescale costs 0.3–0.4 s on the stress score. The layout uses `max-w-[1440px]`.
12. **Node.** jsdom 30.1.3 needs Node `^22.22.2 || ^24.15.0`. CI runs Node 24; only local Node 22.14.0 fails.
13. **Audio and build.**
    - `toAlignAudio` downmixes the whole recording (decode.ts:149).
    - The `<audio>` element is not attached to the DOM (engine.ts:66).
    - `next build` writes `.next/diagnostics/route-bundle-stats.json`.
    - Playwright has one project with a config-level `webServer`.
    - `next.config.ts` has no `distDir`.
14. **Panels library.** `react-resizable-panels@4.21.0` has `resizePreviewMode="separator"` (d.ts:682, 1307).
15. **Fixtures.** There is no stress fixture. `scripts/lib/{demo-score,musicxml-writer,demo-audio}.ts` can generate one.
16. **E2E selectors tied to today's Sync page:**
    - region "Manual markers": workflow-recording:35, open-project:37, score-navigation:45
    - "+100 ms" and "+10 ms"
    - headings "Bar 4" and "Bar 2, beat …"
    - "1 manual marker"
    - "Re-run auto-alignment" and "Manual markers were kept." (workflow-recording:65–66)
    - region "Score over the recording" (score-navigation:20)
    - "Select bar N" and "Play from bar N"

---

## 1. Scope check

Everything is MVP, in the **Sync** or **Playback** rows.

| Piece | Verdict |
|---|---|
| One window with resizable, minimizable panes; layout remembered per browser | MVP |
| Confidence map with markers, current location, and bars holding pending markers | MVP |
| Score: left-click sets the start point; right-click opens one item, "Add marker" ("Edit marker…" on a marked note) | MVP |
| Joint playback: piano roll colored by section and lined up with the waveform; dragging a note's handle places a pending marker | MVP. The pitch view is a Sync editing aid only. |
| **Markers are visual until a recompute.** Placing, moving or deleting a marker changes nothing audible. A recompute (a re-sync) applies the pending markers and updates timing and confidence together. The app may suggest a recompute. | MVP (owner) |
| Waveform zoom, pause/resume, speed (recording only) | MVP |
| Lightroom-style sidebar: Measures (confidence and order, bar range), Markers, Sync | MVP |
| Marker labels; marker icons that open details everywhere, including Measures rows | MVP |
| Re-sync of a range or the whole piece through a **black-box sync function**. Smooth = today's tempo-fit aligner; Rigid shown disabled. | MVP |
| Suggested markers produced by the sync function; enforcing markers inside the fit | **Later** (owner, §9) |

---

## 2. Architecture

### 2.1 Component tree

```
(workflow)/projects/[projectId]/layout.tsx
└ WorkflowMain (client)            # segment "sync" → full-bleed, fixed height
  └ SyncPage                       # unchanged states: NeedsScore · no recording · first alignment · failed
     └ SyncWorkspace               # sync/workspace/: slots, pane-scoped keys
        ├ SyncToolbar              # meta ("N manual markers · K pending"), RecomputeSuggestion, save state, Shortcuts (?), Continue
        ├ Panes horizontal         # ui/Panes.tsx: the only importer of react-resizable-panels
        │  ├ Panes vertical
        │  │  ├ ConfidencePane     # sync/confidence/: PaneHeader · MarkerLane · ConfidenceStrip
        │  │  ├ ScorePane          # sync/score/: NoteContextMenu > ScoreView mode="sync" fill
        │  │  └ JointPlaybackPane  # sync/joint/: RollToolbar (Key popover) · PianoRoll · LandingLine · WaveformLane · Transport scrubber={false}
        │  └ SyncSidebar           # sync/sidebar/: Measures · Markers · Sync
        └ MarkerPopover            # sync/markers/: one instance → MarkerDetails
```

**Markers.** Every marker opens the same `MarkerPopover`. Each is drawn in one of two styles:
- **applied:** filled brass pin
- **pending:** hollow pin with a dashed brass outline, token `--marker-pending`, contrast ≥ 3:1. Both styles appear in every legend.

| Where | Rendered as |
|---|---|
| Confidence lane, score, Markers rows | DOM `MarkerIcon` buttons |
| Measures rows | A `MarkerIcon` button in its own grid cell (T12) |
| Roll and waveform lane | Canvas pins, clustered on the waveform lane. A pending pin sits at its **intended** time, and the dotted landing line still shows the applied landing, so the gap between the two is visible. The pins follow the roll's single focus model: one tab stop; a press under 4 px opens the popover, anything more is a drag; the popover anchors via a `virtualRef`; focus returns to the roll; the selection is announced ("Bar 12, beat 3 · pending marker at 1:23.456"). |

### 2.2 State ownership

| State | Owner | Persisted |
|---|---|---|
| `sync.auto`, `sync.manual` (the markers as the user sees them), `sync.applied` (markers in effect for timing), `method`, `diagnostics` | `useProject` | Server and `.ovproj` |
| Audible timing = `mergeAlignment(auto, applied)`, plus final times and markers that can't be kept exactly | `mergedAlignment(sync)`: a WeakMap keyed by the `sync` object | Derived |
| Pending items and pending bars | `pendingOf(manual, applied)` | Derived |
| `time`, `playing`, `rate`, `cue`, `range` | `usePlayback` | No |
| Selected note (= cue), open popover, reassign mode, roll view and Follow, filters, Measures sort and filter, Sync form, undo slot | `useSyncUi`, reset when the project changes | No |
| Pane sizes, collapsed panes, sidebar, open sections, single-key shortcuts on/off | `useSyncLayout` | localStorage `ov:sync-layout:v1` |

`useSyncLayout`:
- Reads synchronously inside try/catch, with defaults on failure.
- Writes only on user changes, never responsive overrides.
- `SyncWorkspace` mounts after `useProject.status === "ready"`, so the stored layout is applied before first paint.

### 2.3 Pending and applied markers (owner: "visual until recompute")

**Design: two lists.**
- `manual` holds the markers the user sees and edits.
- `applied` holds the markers that timing uses. It is a snapshot taken at the last recompute that covered them.
- Everything audible reads `mergeAlignment(auto, applied)`: playback, seeking, the cue's transport time, Preview, Customize, the Stage, and MP4 export.
- The score, roll, waveform pins and lists draw `manual`.

**Pending items are derived by id:**
- **new:** in `manual`, not in `applied`
- **moved:** in both, with a different `measure`, `position` or `startSec`
- **deleted:** in `applied`, not in `manual`

A label-only change is not pending, because a label doesn't affect timing. A pending item's bars are its `manual` bar and its `applied` bar.

**Why two lists rather than per-marker flags or tombstones:**
- Edits never touch `applied`, so Undo only restores `manual` and is exact.
- A deleted applied marker is not a tombstone inside `manual` that every consumer would have to filter out.
- The pending mark on a bar is a pure function of the two lists. No `changed` list and no `movedBars` diff are needed.
- The mark survives a reload because both lists are persisted.
- No bar is ever marked unless it holds a pending item, and a run clears only what it applies.

**Editing:**

```
UI action → useMarkerCommands
   · markerBounds check (against the manual set) → on error: live message, no change
   · store command on `manual` (add / update / remove / restore); `applied` is never touched
   · toast "… · Undo" (inverse command, ≥ 10 s) + polite live announcement; Cmd/Ctrl+Z in the workspace
→ editSync → debounced save (400 ms); audible timing does not change
```

- `addMarker` on an occupied note updates that marker and keeps its `id`, `label` and `createdAt`.
- An existing marker moves through its pin: drag it, press `[` / `]`, or press `P`. Esc cancels the move.
- A drag has no re-merge. Its bounds are computed once at drag start, and the pin moves by ref.

**Recompute.**
- A recompute is the black-box run (§2.4) over a range or the whole piece.
- The default range covers the pending bars plus 2 bars each side, clamped. This follows the owner's "the marker's bar plus a few around it".
- On success:
  1. `auto` is spliced for the range.
  2. Each pending item **whose bars all lie inside the range** is resolved: its `manual` version is copied into `applied`, or it is removed from `applied` if deleted.
  3. Timing and confidence update together.
  4. Pending items that touch bars outside the range stay pending.
  5. The undo slot and toast are cleared, because a run can't be undone from there.

**Suggest a recompute (owner: "the app may suggest").** After a marker commit, a non-blocking suggestion appears in the toolbar and the Sync section when either condition holds:
- the marker's intended time is more than 250 ms from the current landing, or
- 5 or more markers are pending.

It reads "Recompute bars 8–16 to apply 3 markers", with a **Recompute** button that runs the default range. It is announced once and never runs automatically.

**Confidence.**
- The merge never changes confidence; every bar shows `sync.auto[i].confidence`.
- Bars with a pending item get a hatch on the confidence map (legend: "Pending marker: recompute to apply"), `data-pending` plus the text "pending" in the Measures cell, and "N markers pending" in the Sync section.

### 2.4 The sync function (a black box for now)

The black box owns **every** use of markers in a run. That includes how it picks its audio window.

```ts
// src/lib/align/sync-function.ts (orchestrates on the page; heavy work in the existing worker)
export interface SyncFunctionInput {
  infoMap: InfoMap;
  /** decoded recording (LRU cache) */
  recording: AudioBufferLike;
  /** current audible timing: merge(auto, applied) */
  aligned: MeasureAlignment[];
  /** null = whole piece */
  range: { from: number; to: number } | null;
  style: SyncStyle;
  /** the applied set this run will produce */
  markers: ManualMarker[];
  onProgress?: AlignProgress;
  signal?: AbortSignal;
}
export interface SyncFunctionOutput {
  /** range bars (or all), global numbers and seconds */
  auto: MeasureAlignment[];
  /** what actually ran ("chroma-dtw" after a fallback) */
  method: string;
  fellBack: boolean;
  diagnostics?: AlignmentDiagnostics;
}
export function runSync(input: SyncFunctionInput): Promise<SyncFunctionOutput>;
```

**Today's implementation:**
- **Whole piece:** `toAlignAudio(recording)`, then `alignInWorker` → `runAlignment`. This is exactly today's call.
- **Range:**
  1. `planRangeWindow` picks the window. The inner window runs from the merged start of `from` to the merged start of `to+1`; it starts at 0 for bar 1 and ends at the recording end for the last bar. Padding is clamp(0.15 × span, 2 s, 8 s), or 0.25 s on a side pinned by a downbeat marker in `markers`.
  2. `toAlignAudio(recording, window)` downmixes only the window.
  3. `sliceInfoMap`, then run.
  4. Offset results back to global. If the integrated aligner throws, run chroma DTW on the inner window.
- The fit itself does **not** yet use the markers. That is the owner's "comes later" (§9). Merging the applied markers then pins timing to them.

**The job** (`http.startAlignment` and the mock):
1. `saveNow`, then load and normalize the server copy.
2. Compute `applied′` (the resolution rule in §2.3).
3. Call `runSync` with `markers: applied′`.
4. `spliceAuto`: bars outside the range are kept by reference; seams that break the order are clamped and capped at 59; the average is recomputed.
5. Write (§3.5).

Marker editing stays locked while a run is in progress.

### 2.5 Score time and recording time in the roll

- **x-axis:** recording time, shared with the waveform.
- **Notes:** placed at `scoreToRecordingTime(infoMap, aligned, note.time)` (audible timing), in O(1) per note via `buildBarMaps`. Bars are re-mapped only after a recompute or load.
- **Visible window:** `[recordingToScoreTime(t0), recordingToScoreTime(t1)]` plus a binary search.
- **Colors:** `display.sectionColors`, with `display.sections` reassignment applied. The chips are the legend.
- **Landing line:** the selected or hovered note's dotted line runs from its onset down through the waveform lane to its **current (applied)** landing. It is one DOM element (`data-testid="landing-line"`), moved by ref.
- **Handles:** a solid handle per onset in view. Dragging one places a pending pin at the intended time, so the handle and pin move together while the landing line stays at the current landing until a recompute.
- **Pitch:**
  - Sounding pitch.
  - Gutter ticks with note names at every C, plus E and A when there's room.
  - Hz on hover and in the Key popover.
  - A percussion band.
  - "Fit pitch to view".
  - Shift+wheel or ↑/↓ scroll the pitch range.

### 2.6 Performance budget

Stress fixture: 42 parts, 480 bars, about 18 min. Production profiling build (§T0), Chromium, 1080p, DPR capped at 2.

| Area | Approach | Budget |
|---|---|---|
| React | Time readouts by ref/rAF; `useCurrentMeasure()` changes only at bar changes | SyncWorkspace and Transport: 0 commits per frame. The counter must be non-zero after a bar change. |
| Long tasks | New code yields every 8 ms | No new task over 50 ms at mount or during 30 s of playback. OSMD chunk layout is excluded by its marks. |
| Confidence map | Rects memoized on confidence, marker and pending flags; view box and playhead by ref | ≤ 4 ms render; 0 commits during roll pan/zoom |
| Pending derivation | `pendingOf` diff by id | ≤ 2 ms at 2,000 markers |
| Score | `fill` height; `resizePreviewMode="separator"`; keyboard resize debounced 150 ms | Horizontal drag ≤ 16 ms/frame with one rescale on release; vertical drag ≤ 16 ms/frame; sidebar toggle ≤ 0.4 s |
| Roll index | Time-sliced k-way merge; per-section occupancy bins at 0.05, 0.25, 1 and 4 s | ≤ 200 ms total; slices ≤ 8 ms |
| Roll draw | Three canvases; rects up to 4 per px, bins above that; landing line and dragged pin moved by ref; no merge during drag | Pan/zoom p95 ≤ 16 ms (whole piece and 30 s views); drag p95 ≤ 8 ms; 0 commits while hovering across notes; re-map after a recompute ≤ 5 ms |
| Waveform | Min/max Float32 pyramid, about 2.0 MB per 18 min | ≤ 6 s from a cold decode; ≤ 0.5 s when cached |
| Lists | Rendered in full (virtualized above 2,000); memoized rows; current row tracked by ref | ≤ 4 ms commit after a marker edit; a bar change re-renders only the old and new current rows |
| Memory | CDP `Performance.getMetrics`; the 3-entry audio LRU stays | ≤ decoded buffer + 30 MB over the T0 baseline |

- Per-frame measures assert p95 ≤ budget × 1.25. One-shot totals assert ≤ 2× budget.
- `npm run test:perf` is a manual gate before merging T8, T11a, T11b and T12.

---

## 3. Data changes

### 3.1 `src/shared/sync.ts`

```ts
export const MARKER_LABEL_MAX = 80; // code points

export interface ManualMarker {
  id: string;
  measure: number;
  position?: number;
  startSec: number;
  createdAt: string;
  /** user's name ("Horn entry"); absent = derived ("Bar 12, beat 3") */
  label?: string;
  /** "time": position is a fraction of the bar in score seconds. Absent: legacy value to normalize. */
  basis?: "time";
}

export interface SyncState {
  /** what the last whole-piece run used */
  method: string;
  /** per bar: start and confidence from the last run covering it */
  auto: MeasureAlignment[];
  /** markers as the user sees and edits them */
  manual: ManualMarker[];
  /** markers in effect for timing (applied by the last recompute covering them); absent = legacy, equals manual */
  applied?: ManualMarker[];
  averageConfidence: number;
  /** only from a whole-piece run */
  diagnostics?: AlignmentDiagnostics;
}

export function appliedOf(sync: SyncState): ManualMarker[]; // sync.applied ?? sync.manual
export interface PendingItem { id: string; kind: "new" | "moved" | "deleted"; bars: number[]; intended?: ManualMarker; applied?: ManualMarker }
export function pendingOf(manual: ManualMarker[], applied: ManualMarker[]): PendingItem[];
export function resolveRange(manual, applied, range: { from: number; to: number } | null): ManualMarker[]; // applied′
export function normalizeMarkerLabel(v: unknown): string | undefined;
export function mergeAlignmentDetailed(auto, markers): { aligned: MeasureAlignment[]; finals: Map<string, number>; unhonoured: string[] };
export function mergeAlignment(auto, markers): MeasureAlignment[];
export function markerBounds(auto, manual, spot, opts: { excludeId?: string; durationSec: number }): { low: number; high: number };
export function parseSyncState(v: unknown, mode: "strict" | "lenient"): { sync: SyncState; dropped: number }; // validation only
```

**Merge final pass.**
1. Anchors go forward: `final = max(sec, prevFinal + gap·(j+1))`, where j is the number of downbeats between the two anchors. A raised anchor keeps the old push behavior and is listed in `unhonoured`, so the result is never non-monotonic.
2. Non-anchor knots are clamped between their anchors' finals.
3. Confidence is copied from `auto`.

**Bounds and ordering.**
- `markerBounds` checks an edit against the **manual** set. It merges `auto` with `manual` minus `excludeId`, then returns `low = prevFinal + gap·(j+1)` (virtual anchor at 0) and `high = nextFinal − gap·(j′+1)` (virtual anchor at the duration).
- So the set a full recompute would apply is always in order.
- A partial recompute can mix applied markers outside the range with resolved ones inside it. The merge's push-and-flag keeps that mix monotonic, and any crossing shows as "can't be kept exactly" (§5). This is covered by a property test.

**`parseSyncState`.**
- Unknown keys are dropped. Wrong types throw in strict mode and are dropped in lenient mode.
- Marker ids must be unique **within each list**. Strict mode rejects duplicates; lenient mode re-ids the later duplicate and counts it.

| Object | Allowed keys and limits |
|---|---|
| top level | `method`, `auto`, `manual`, `applied`, `averageConfidence`, `diagnostics` |
| `auto[]` | `n`, `startSec`, `confidence`; ≤ 20,000 |
| `manual[]`, `applied[]` | `id` (≤ 100), `measure` (1–20,000), `position` [0, 1], `startSec`, `createdAt`, `label` (≤ 80 code points), `basis`; ≤ 20,000 each |
| `diagnostics` | the `AlignmentDiagnostics` fields |

### 3.2 Positions and normalization (`src/lib/score/stamps.ts`)

- `musicalToTimeFraction(infoMap, measure, f)` and its inverse integrate `infoMap.timing.tempo` across the bar.
- `canonicalPosition(infoMap, measure, timeFraction)` snaps to the nearest onset within 1e-3.
- All five EngravedScore sites (fact 3) convert through these, in T1.

**`normalizeMarkers(sync, infoMap)`** is idempotent and runs on **both lists**. It runs in `useProject.load`/`refresh`, in `openProjectFile`, and on the server copy before any merge in `exportMp4` and in the sync job.
1. **Legacy marker, position > 0:** snap under both readings; take the musical reading only if its onset is strictly closer. Then canonicalize and set `basis: "time"`.
2. **Legacy downbeat:** set `basis: "time"`.
3. **Already `basis: "time"`:** canonicalize only.
4. **Duplicates on one note:** keep the latest `createdAt`. A duplicate id gets a fresh id.
5. **`applied` absent (legacy):** set `applied` to a copy of the normalized `manual`. These markers were audible before, so nothing becomes pending.
6. **Order:** nothing is dropped for its order.

Normalization applies the same deterministic changes to an id in both lists, so it never creates a pending item. A store load that changed anything schedules a save. The file stays **version 1**, because `applied` is additive and optional.

### 3.3 Store actions (`src/lib/store/project.ts`)

```ts
type MarkerEditResult = { ok: true; id: string } | { ok: false; reason: "not-found" | "occupied" | "out-of-order"; message: string };
addMarker(measure, startSec, position?, label?): MarkerEditResult   // occupied note → update startSec, keep id/label/createdAt
updateMarker(id, patch: Partial<Pick<ManualMarker, "measure" | "position" | "startSec" | "label">>): MarkerEditResult
removeMarkerById(id): ManualMarker | null
restoreMarker(m): MarkerEditResult                                   // re-checks bounds and occupancy
```

- All four act on `manual` only. Each canonicalizes, sets `basis: "time"`, and checks `markerBounds`.
- `nudgeMarker` without a marker starts from the current landing.

### 3.4 Methods and job parameters

```ts
// src/lib/align/methods.ts
export type SyncStyle = "smooth" | "rigid";
export interface SyncMethod { id: AlignMethod; style: SyncStyle; label: string; description: string; available: boolean }
export const SYNC_METHODS = [
  { id: "integrated-tempo", style: "smooth", label: "Smooth", description: "Tempo fitted to the recording (ADR 0014)", available: true },
] as const; // Rigid renders disabled ("Not available yet") until registered
export function methodForStyle(style: SyncStyle): SyncMethod | null;

// src/shared/jobs.ts
export interface AlignJobInput { range?: { from: number; to: number }; style?: SyncStyle } // no range = whole piece
AlignResult += { range?: { from: number; to: number }; applied: number; stillPending: number; fellBack: boolean; seamClamped?: number }
OpenProjectResult += { warnings?: string[] }
```

**Adding Rigid later:** implement it behind `runSync` and `AlignMethod`, add a `case`, register it with `style: "rigid"`, and write an ADR.

### 3.5 Writers

| Writer | Behavior |
|---|---|
| Server `PUT /projects/:id/sync`, mock `saveSync` | `parseSyncState(body, "strict")`; `SyncShapeError` → 400 |
| Whole-piece run (http, mock) | Writes `{ method: out.method, auto: out.auto, averageConfidence, diagnostics: out.diagnostics, manual, applied: manual }` (everything resolved) |
| Range run (http, mock) | Writes `{ method: previous.method, auto: spliced, averageConfidence, diagnostics: previous.diagnostics, manual, applied: applied′ }`. A fallback is reported only in the result message (owner: "result message is enough"). |
| `exportMp4` (http) | Normalizes, then merges `auto` with **`applied`**. Export plays what the user hears. |
| File load | `assertProjectShape` array checks, then a lenient parse. `openProjectFile` normalizes and filters both lists to the score's bars, then PUTs. |
| File import with a different measure count | `auto` discarded, `diagnostics` dropped, `method: "none"`, `averageConfidence: 0`, `applied` = filtered `manual` |
| Old clients during rollout | An old job or tab may drop `applied`. The next load treats that as legacy (`applied = manual`), so pending markers become audible without a run. This is safe and monotonic, and it is documented in ADR 0018. |

No SQL migrations and no preferences changes.

---

## 4. Tasks

Lane A (data and processing) and lane B (UI) don't share files. The one exception is **T1, which also edits `EngravedScore.tsx`**, so T8 and T10 start after T1.

Spec files are owned per task: T8 `sync-layout`, T10 `sync-score-markers`, T11a/T11b `sync-roll`, T12 `sync-sidebar`, T13 `sync-range` (all `.spec.ts`). Helpers live in `tests/e2e/sync-helpers.ts` (created in T8). Every UI task's gate runs `workflow-recording`, `score-navigation` and `open-project`.

```
T0 → T1 ─┬─ A: T4 → T6
         ├─ A: T7
         └─ B: T2 → T3 → T8 → T9 ─┬─ T10 → T11a → T11b    (T11a also needs T6, T7)
                                  └─ T12 → T13             (T13 also needs T4)
T14 last
```

### T0 Groundwork — `chore/sync-revamp-groundwork`
- **Prerequisite:** commit and open the PR for `feat/integrated-sync`, then branch from it.
- **Node:** `.nvmrc` 24; `engines.node` `"^22.22.2 || ^24.15.0"`. Verify with `npx vitest run --project dom`. From here on, jsdom tests are required gates.
- **Fixtures:**
  - `scripts/make-stress-fixture.ts` writes the stress `.musicxml` and `.mp3`. The perf run fails if either is missing.
  - Add `fixtures/scores/quirks/mid-bar-tempo.musicxml`.
- **Route size:** `scripts/route-size.ts` reads `.next/diagnostics/route-bundle-stats.json`.
- **Perf setup:**
  - `next.config.ts`: `distDir: process.env.NEXT_DIST_DIR ?? ".next"`.
  - The default `playwright.config.ts` adds `testIgnore: "perf/**"`.
  - New `playwright.perf.config.ts`:
    - `testDir: tests/e2e/perf`, port 3100, `reuseExistingServer: false`
    - `webServer`: `NEXT_DIST_DIR=.next-perf NEXT_PUBLIC_PERF=1 next build --profile && NEXT_DIST_DIR=.next-perf next start -p 3100`
    - env mirrors the CI e2e env (ci.yml:42–58), with `PORT=3100` and `BETTER_AUTH_URL=http://localhost:3100`
  - Add the script `test:perf`.
- **Perf spec** (`tests/e2e/perf/sync-stress.spec.ts`): a smoke check (health, then sign-in) runs first. It collects marks, `longtask` entries, CDP metrics, and `window.__ovRenders`.
- **Baseline:** perf and route-size on today's Sync page, recorded in the handoff.

### T1 Marker data, pending/applied, score positions — `feat/sync-marker-data` (lane A + named exception)

**Files:**
- `src/shared/sync.ts`, `src/lib/score/stamps.ts`, `src/lib/store/project.ts`
- `src/lib/store/useProjectTiming.ts`: one line, so that timing reads `appliedOf(sync)`. This keeps the guarantee in the same PR as the data change.
- `src/server/routes/projects.ts`, `src/lib/export/project-file.ts`
- `src/lib/api/{http,mock}.ts`: open, save, and the `exportMp4` applied merge
- `src/shared/jobs.ts`
- `src/components/music/EngravedScore.tsx` (fact 3)
- `src/components/import/ImportPage.tsx`: warning toast "1 marker on bar 12 can't be kept exactly. See Markers on the Sync page."
- `tests/unit/sync/merge.test.ts`: lines 47 and 64 now expect the aligner's confidence
- `fixtures/projects/legacy-v1.ovproj`: an OSMD-basis marker in a mid-bar-tempo bar, a Go-to-by-time marker, two markers on one note, two markers too close together, no labels, no `applied`

**Unit tests** (`tests/unit/sync/markers.test.ts`):
- `label: 79 chars + emoji kept whole; > 80 code points cut`
- `merge copies confidence from auto`
- `pendingOf: new, moved, deleted; a label-only change is not pending`
- `timing uses applied only: adding, moving or deleting a manual marker leaves mergedAlignment unchanged`
- `resolveRange: resolves items whose bars are all inside; an item moved from bar 5 to 15 stays pending for a run over 10–20`
- `whole-piece resolve: applied equals manual`
- `property: any time inside markerBounds is the merged anchor time when applied`
- `property: any mix of applied (out of range) and resolved (in range) markers merges strictly increasing by ≥ gap; violators listed`
- `parseSyncState strict: unknown keys dropped; bad types and duplicate ids per list rejected; caps enforced`

**Stamp tests:**
- `musical ↔ time round-trip on the mid-bar fixture`
- `canonicalPosition within 1e-3`
- `legacy snap picks the closer reading`
- `normalizeMarkers idempotent on both lists, never creates a pending item`
- `legacy load (no applied): applied = manual, nothing pending`

**Store tests:**
- `edits change manual only`
- `Undo restores manual exactly; applied untouched`
- `deleting an applied marker is pending; audible timing unchanged`
- `duplicates collapse (latest wins)`
- `addMarker on an occupied note keeps id, label, createdAt`
- `updateMarker rejects occupied and out-of-order`
- `restoreMarker re-checks bounds`

**Writer tests (http and mock):**
- `exportMp4 merges applied markers only`
- `open with a different measure count drops diagnostics, method "none", applied = manual`
- `applied survives save → reload`

**API tests:**
- label accepted
- `applied` accepted
- > 80 code points, > 20,000 markers in either list, an id over 100 characters, or a duplicate id within a list → 400
- unknown keys dropped
- old rows read unchanged

**E2E:**
- `open-project.spec.ts` with `legacy-v1.ovproj`: one marker per note, the toast, nothing pending.
- `score-positions.spec.ts`: a score-only project from `mid-bar-tempo.musicxml`. The cue beat matches the info-map onset, and the playhead x is inside the note's bounding box.

**jsdom:** `ImportPage.test.tsx`: warning toast.

**Gate:** `npm test`, `test:api`, typecheck, and the three Sync specs.

### T4 Black-box sync function, recompute, method registry — `feat/sync-range-run` (lane A)

**Files:**
- `src/lib/align/{sync-function,range,methods,select,worker,worker-client,protocol}.ts`
- `src/lib/audio/decode.ts` (`toAlignAudio(buffer, window?)`)
- `src/shared/jobs.ts`
- `src/lib/api/{types,http,mock}.ts`
- `scripts/eval-align.ts --range a-b`

**What:** `runSync` (§2.4) owns window planning, including marker use. The job follows §2.4, and the writers follow §3.5.

**Tests** (`sync-function.test.ts`, `range.test.ts`):
- `whole-piece runSync output deep-equals runAlignment on the same recording (no change vs today)`
- `markers are passed in; today's fit ignores them; window narrowing is the only use and lives inside runSync`
- `fallback reported: method "chroma-dtw", fellBack true`
- `sliceInfoMap renumbers, shifts, keeps the tempo in effect, clips fermatas`
- `planRangeWindow pads 2–8 s, 0.25 s at a marked downbeat, starts at 0 for bar 1, ends at the recording end for the last bar`
- `spliceAuto keeps auto outside identical and recomputes the average`
- `seam clamp`
- `bars 20–30 within 150 ms on synthesized audio`
- `integrated throws on a short window → chroma on the inner window within 150 ms`
- `transferred samples = window length`
- `every SYNC_METHODS entry has a case`, `methodForStyle("rigid") is null`
- mock and http:
  - `range recompute applies pending markers fully inside, leaves others pending, keeps method and diagnostics, updates the stored average`
  - `whole-piece recompute applies all`
  - `after a recompute, audible timing = merge(new auto, new applied)`

### T6 Peak pyramid — `feat/sync-waveform-zoom` (lane A)
- **Files:** `src/lib/audio/peaks.ts`; `src/lib/api/{types,http,mock}.ts` (`loadRecordingPeaks`).
- **Tests:**
  - `levels keep min/max`
  - `coarsest level with ≥ 1 bucket per column`
  - `max over channels without a downmix`
  - `yields every 1M samples`

### T7 Roll model — `feat/sync-roll-model` (lane A; new files only)
- **Files:** `src/lib/sync/{roll,roll-draw,viewport}.ts`:
  - `buildRollIndex`, `buildBarMaps`, `mapRange`, `queryWindow`, `partMask`
  - `sectionColorsFor(display)`, `pitchTicks`
  - `hitTest` (4 px threshold), `clusterPins` (applied and pending), the draw functions
  - `zoomAt`, `pan`, `follow`, `fitPitch`
- **Tests:**
  - `sounding pitch (clarinet −2)`
  - `onsets deduped with canonical positions`
  - `queryWindow finds notes that start before the window`
  - `bar maps equal scoreToRecordingTime`
  - `note color = section color from display settings, incl. a reassigned part`
  - `LOD bins use the same colors`
  - `pitchTicks label every C, add E/A when there's room`
  - `pending pins drawn at intended time, landing at applied time`
  - `zoomAt keeps the anchor`
  - `hitTest < 4 px is a press`
  - stress (node): index ≤ 200 ms with slices ≤ 8 ms; full map ≤ 5 ms

### T2 Render hygiene — `perf/sync-timing` (lane B)
- **Files:**
  - `useProjectTiming.ts`: a WeakMap over `mergeAlignmentDetailed(auto, appliedOf(sync))`, plus `useCurrentMeasure`
  - `SyncPage.tsx`
  - `Transport.tsx`: ref/rAF time leaves; `scrubber?: boolean`
- **Tests:**
  - `mergedAlignment stable per sync object, unchanged by manual-only edits`
  - jsdom `Transport.test.tsx`: `0 Transport commits across 60 ticks`

### T3 Recording-only speed and key ownership — `feat/recording-rate` (lane B)
- **Files:** `playback.ts`, `engine.ts`, `Transport.tsx`.
- **What:**
  - `effectiveRate()` returns `rate` only when `engine?.kind === "recording"`, else 1.
  - The `<audio>` element is attached hidden (`data-ov="recording"`) and removed on `destroy()`.
  - The speed menu appears only with a recording.
  - `data-local-keys` marks the keys a component owns, and `PlaybackShortcuts` skips those, plus arrow keys on separators.
  - `stepTarget(e, nav)` is extracted for reuse.
- **Tests:**
  - `setRate never reaches a score engine`
  - `tick uses the effective rate`
  - `dispose removes audio[data-ov=recording]`
  - `ExportMp4Options has no rate`
  - jsdom: `owned keys skipped`, `Space still toggles inside an owner`, `Enter/Home skipped in a grid owner`
- **E2E (workflow-recording):**
  - `playbackRate === 0.75`
  - the `currentTime` delta over `performance.now()` is 0.75 ± 30%
  - no speed control on a score-only project

### T8 Workspace shell — `feat/sync-workspace-layout` (lane B; after T1 and T3)
- **Dependency:** `react-resizable-panels@4.21.0`, pinned, with ADR 0017.
  - Spike: confirm that `resizePreviewMode="separator"` applies sizes only on release.
  - If it doesn't, ScorePane ignores width changes while a horizontal separator is active and applies them on pointer-up.
- **Files:**
  - `package.json`
  - `ui/Panes.tsx` + test
  - `src/lib/store/sync-layout.ts`
  - `shell/WorkflowMain.tsx` and the workflow `layout.tsx`
  - `sync/workspace/*`
  - slot files holding today's components: `confidence/ConfidencePane.tsx`, `score/ScorePane.tsx`, `joint/JointPlaybackPane.tsx`, `sidebar/SyncSidebar.tsx`
  - `EngravedScore.tsx` (`fill`), `ScoreView.tsx`, `SyncPage.tsx`, `globals.css`
  - `tests/e2e/sync-helpers.ts`, `sync-layout.spec.ts`
- **Sizes:**

  | Pane | Min | Collapsed | Default |
  |---|---|---|---|
  | Confidence | 64 px | 32 px | 14% |
  | Score | 220 px (160 px under 640 px tall) | 32 px | 50% |
  | Joint | 240 px | 56 px | 36% |
  | Sidebar | 280 px | hidden (40 px rail) | 320 px |

  The last expanded pane can't collapse. Under 1024 px wide, the sidebar becomes a non-modal overlay. Under 640 px tall, Confidence auto-collapses (not persisted).
- **Tests:**
  - jsdom `Panes.test.tsx`: `arrows/Home/End resize`, `Enter collapses/restores`, `collapse focuses the header`, `last pane can't collapse`
  - unit: `bad/blocked localStorage → defaults`, `responsive overrides not written`
- **E2E:**
  - score-navigation:20 region renamed to "Score"
  - `sync-layout.spec.ts`: drag, keys, collapse; reload with bounding boxes stable from the first frame; 900 px overlay, and widening restores the layout
- **Gate:** route size ≤ 15 KB gzip over baseline; the perf step for horizontal drag.

### T9 Marker core — `feat/sync-marker-core` (lane B)
- **Files:**
  - `src/lib/store/sync-ui.ts`
  - `sync/markers/{MarkerIcon,MarkerDetails,MarkerPopover,useMarkerCommands,markerName,RecomputeSuggestion}.ts(x)`
  - `ui/{Popover,ContextMenu}.tsx`
  - `sync/workspace/{ShortcutsPopover,useWorkspaceKeys}.tsx`
  - `SyncPage.tsx`, `sidebar/SyncSidebar.tsx`, `score/ScorePane.tsx`
- **MarkerDetails:**
  - **Fields:**
    - Name: Enter saves, Esc reverts.
    - Time: −100/−10/+10/+100 ms, `[` / `]`, "Set to playhead", and an Advanced ms or m:ss.mmm field.
    - Note: a bar via `resolveGoTo`, previous/next note, "Pick in score/roll".
    - Actions: Jump to, Delete.
  - **Status line:**
    - Applied: "Applied. Confidence 58% (from the last sync)."
    - Pending: "Pending: recompute to apply (now lands at 1:23.100)", plus a **Recompute bars 10–14** button.
  - **Messages:**
    - "Must be between …"
    - "This marker is too close to the one on bar N to keep exactly. Move one of them."
  - **During a run:** everything is disabled, and the reason is shown.
- **MarkerPopover:** non-modal Radix. Esc or Tab-out closes it and returns focus to the trigger.
- **RecomputeSuggestion:** follows the §2.3 rule. It sits in the toolbar and the Sync section, is non-blocking, and is announced once.
- **Tests:**
  - jsdom `MarkerDetails.test.tsx`:
    - `Enter saves`, `Esc reverts`, `[ / ] nudge`, `bounds error`
    - `a nudge makes the marker pending; confidence line unchanged`
    - `pending line shows the current landing and a Recompute button`
  - jsdom `MarkerPopover.test.tsx`: `focus returns to the trigger`
  - jsdom `RecomputeSuggestion.test.tsx`: `appears when intended − landing > 250 ms or ≥ 5 pending`, `range = pending bars ± 2, clamped`, `never runs by itself`
  - unit:
    - `Undo inverse for add/move/retime/reassign/delete restores manual exactly`
    - `Cmd/Ctrl+Z undoes the last marker command`
    - `Undo toasts ≥ 10 s`
    - `a successful run clears the undo slot and toast; manual and applied untouched by a later Cmd/Ctrl+Z`

### T10 Score and confidence marker UI — `feat/sync-marker-ui` (lane B)
- **Files:**
  - `EngravedScore.tsx`: `MarkerIcon` buttons for bars in view (applied and pending), `onSpotContextMenu`
  - `ScoreStrip.tsx`
  - `score/{ScorePane,NoteContextMenu}.tsx`
  - `confidence/{ConfidencePane,MarkerLane}.tsx`
  - `ConfidenceStrip.tsx`: pending hatch plus its legend entry
  - `src/lib/sync/markers-view.ts`
  - `globals.css` (`--marker-pending`)
  - `sync-score-markers.spec.ts`
- **Score keys:** with focus in the Score pane, ←/→ seek as today (`stepTarget`), move the cue, and announce the move.
- **NoteContextMenu:**
  - One item: "Add marker", or "Edit marker…" when the note already has one. During a run it is disabled and gives the reason.
  - Pointer: a menu opens only for a matching tracked `pointerdown`. Other native `contextmenu` events are prevented.
  - Keyboard: Shift+F10 or the ContextMenu key calls preventDefault and stopPropagation, sets a one-shot flag, and dispatches one synthetic event at the cue's rect.
  - With no cue: "Select a note first" (the same for `A`).
- **Tests:**
  - jsdom `NoteContextMenu.test.tsx`:
    - `Shift+F10 opens once at the cue`
    - `native keyboard contextmenu ignored`
    - `no cue → "Select a note first"`
    - `Edit when marked`
    - `disabled reason`
  - jsdom `ScorePane.test.tsx`: `arrows set the cue`, `announcement includes the marker state`. Both suites stub `@/components/music/ScoreView` (ADR 0015).
  - unit:
    - `clusterMarkers`
    - `pending hatch only on bars with a pending item`
    - `--marker-pending contrast ≥ 3:1 on --score-paper and --paper-2`
- **E2E (`sync-score-markers.spec.ts`):**
  - **context menu:** exactly one `role=menu` after Shift+F10.
  - **add marker is visual only:** seek to bar 15, then read the transport time and the bar's `data-confidence`. Add a marker 1 s later than the landing. Seeking to bar 15 gives the same time and the same confidence. The pin is pending and the bar is hatched.
  - **popover edit**
  - **keyboard only (score):** no `click()`. Focus Score, press → ×3, check the cue label, Shift+F10, Add, rename, nudge, collapse a pane, resize a separator.
  - `toMatchAriaSnapshot` for regions, separators, and one applied and one pending marker icon.

### T11a Roll, read only — `feat/sync-roll-view` (lane B)
- **Files:** `joint/{JointPlaybackPane,PianoRoll,LandingLine,WaveformLane,RollToolbar,RollFilters,useRollViewport}.tsx/ts`, `sync-roll.spec.ts`. Delete `MeasureTimeline.tsx`.
- **What:**
  - The roll owns ←/→ (step and set the cue), ↑/↓ (pitch), and Enter (details).
  - The landing line (applied landing) is moved by ref.
  - Pitch ticks.
  - Follow, and "Back to playhead".
  - Section chips that act as the legend, a parts popover, "Only parts shown in Customize".
  - A Key popover covering the landing line, the handle, applied vs pending pins, the at-bound color, LOD bins and Hz.
  - Clustered waveform pins.
  - "Preparing notes…" while the index builds.
- **E2E:**
  - `roll follows playback`
  - `filter chip hides a section`
  - `chip color matches the section color set in Customize`
  - `selecting a note shows its landing line at its current landing`
  - `click a pin opens details`
  - `Enter on a marked note opens details; Esc returns focus to the roll`
- **Perf:** pan/zoom; confidence map commits = 0; 0 commits while hovering.

### T11b Roll handles — `feat/sync-roll-handles` (lane B)
- **Files:** `joint/{PianoRoll,WaveformLane,useRollDrag}.tsx/ts`, `src/lib/sync/roll.ts`, `sync-roll.spec.ts` (`describe("handles")`).
- **What:**
  - **Drag:** ≥ 4 px starts a drag. The handle and pending pin move by ref, and the landing line stays put. Bounds are computed once at drag start; at a bound the pin shows "Can't pass bar 13 (1:24.100)". Esc cancels.
  - **Commit:** a drop places or moves a **pending** marker.
  - **Keys:** `[` / `]` ±10 ms, Shift ±100 ms, committed on key-up. `P` sets to playhead.
  - **During a run:** `not-allowed`, with the reason.
- **E2E:**
  - `a 10 px drag moves a pin`
  - `drag handle +300 ms → pending marker at +0.300 ± 0.02; landing line, transport time at that note and confidence unchanged; no worker started`
  - `drag an existing pin → same id, now pending`
  - `score marker, then drag the same note's handle → one Markers row`
  - `keyboard only (roll)`
- **Perf:** drag p95 ≤ 8 ms.

### T12 Sidebar: Measures and Markers — `feat/sync-sidebar` (lane B)
- **Files:**
  - `sidebar/{SyncSidebar,SidebarSection,MeasuresSection,MarkersSection}.tsx`
  - `src/lib/sync/measures.ts`
  - `sync-sidebar.spec.ts`
  - updates to workflow-recording:35–60, score-navigation:37–45, open-project:37–39
- **Lightroom-style panel:**
  - Stacked disclosure headers; any number can be open, and the open state is remembered.
  - Alt-click (or Alt+Enter) solos a section.
  - The whole panel hides with Cmd/Ctrl+\\ or the rail.
- **Measures (`role="grid"`):**
  - `filterMeasures(aligned, { sort: "order" | "confidence", bands, from?, to? })`.
  - **Bar cell:** "Bar 12 · 58% Uncertain · pending", with `data-confidence` and `data-pending`. Enter or click selects the downbeat as the cue and seeks.
  - **Marker cell:** a `MarkerIcon` button with `tabIndex=-1`.
  - **Keys:** `aria-activedescendant`; ↑/↓ rows, ←/→ cells, Home/End first/last row. Enter or Space on the marker cell opens the popover, and closing it returns focus to the same cell.
  - **Rows:** memoized.
  - **"Next uncertain" (N):** skips bars with any marker, applied or pending (owner).
- **Markers:**
  - "Selected: Bar 12, beat 3" with "Add marker (A)".
  - Markers listed by recording time, with "pending" and "not kept exactly" badges.
  - A pending deletion shows as a struck-through row labelled "Deleted: recompute to apply", with Undo while the slot holds it.
  - Details in a fixed panel below.
  - A dismissible note when markers are too close together.
- **Tests:**
  - unit: `filterMeasures`, `markers sorted by startSec`, `Next uncertain skips bars with a marker`, `pending deletions listed`
  - jsdom `SyncSidebar.test.tsx`:
    - `focus after delete → next/previous/empty`
    - `grid: ↑/↓ rows, ←/→ cells, Home/End`
    - `Enter on the marker cell opens the popover; closing returns to the same cell`
    - `Enter in the bar cell seeks`
    - `Alt-click solos`
    - `open sections remembered`
- **E2E (`sync-sidebar.spec.ts`):**
  - "measures"
  - "marker icon in a Measures row opens details"
  - "markers" (Delete, then Undo)
  - `keyboard only (sidebar)`
  - labels round-trip through export and open
  - pending markers and the pending mark survive a reload
- **Perf (manual gate, stress fixture):** edit a marker, then play across a bar change; assert both list budgets.

### T13 Sidebar: Sync and recompute — `feat/sync-range-ui` (lane B)
- **Files:** `sidebar/SyncSection.tsx`, `SyncPage.tsx`, `sync-range.spec.ts`, workflow-recording:64–66.
- **What:**
  - **Pending summary:** "3 markers pending in bars 8–14", with **Recompute bars 6–16** (the default range) and "Whole piece".
  - **From/To fields** via `resolveGoTo`:
    - pre-filled from the default range, or from the selected passage (`usePlayback.range` → bars) when the user Shift-clicks two notes
    - one-way: typing doesn't change playback
    - they keep their last values when the passage clears
    - hint: "Shift-click two notes in the score to pick bars (this also repeats them)."
  - **Method `Segmented`:** Smooth (selected); Rigid disabled, "Not available yet".
  - **Run controls:** Run, `JobLine`, Cancel.
  - **Result line:** "Bars 6–16 recomputed · 3 markers applied · 1 still pending · 81% average", plus " (used the fallback aligner)" when it applies.
- **E2E (`sync-range.spec.ts`):**
  - `Shift-click bars 10 and 20 → Sync shows 10–20`
  - `Stop repeating → fields keep 10–20`
  - **core loop:**
    1. Read bar 15's `data-confidence` and the transport time at bar 15.
    2. Drag bar 15's handle +1 s. Confidence and time are unchanged, `data-pending="true"`, and the suggestion appears.
    3. Click its Recompute button. Bar 15's time now matches the marker within 20 ms, and its `data-confidence` equals `sync.auto[14].confidence` from `GET /api/projects/:id`.
    4. `data-pending` clears, while a pending marker placed earlier at bar 40 stays pending.
  - `auto outside the range unchanged`

### T14 Docs — `docs/sync-revamp`
- ADRs (§8).
- `.claude/rules/sync.md`:
  - markers are visual until a recompute
  - `manual` vs `applied`, and timing uses `applied`
  - confidence only from runs
  - the black-box sync function
  - fixed-anchor merge and bounds
  - per-marker basis
- Handoff. STATE.md changes only in the merging PR.
- Remove `neighborTimes`.

---

## 5. UX details

### Keyboard

Single-key shortcuts work only with focus in the listed pane, never in text fields, and can be turned off in the Shortcuts popover.

| Action | Mouse | Keyboard |
|---|---|---|
| Select note (= start point) | Left-click | ←/→ in Score (seek + cue) or Roll; elsewhere they only seek. Shift+←/→ (±5 s) only seeks. |
| Note menu | Right-click, long press | Shift+F10 or ContextMenu key (Score, Joint) |
| Add marker (pending) | Menu, button | **A** (Score, Joint, Markers) |
| Nudge (pending) | Drag, buttons | **[ / ]**, **Shift+[ / ]** (Joint, details) |
| Set to playhead | Button | **P** (Score, Joint) |
| Recompute (apply pending) | Suggestion, Sync section, details | **R** (workspace) runs the default range |
| Zoom / pan; pitch | Ctrl+wheel / wheel; Shift+wheel | **− / =**, **, / .**; **↑/↓** (Joint) |
| Next uncertain (skips marked bars) | Button | **N** (Confidence, Measures) |
| Measures grid | Click | ↑/↓, ←/→, Home/End, Enter/Space |
| Delete marker (pending) | Trash | **Delete/Backspace** on a row or icon |
| Panes | Drag, header button | Separator: arrows, Home/End, Enter |
| Sidebar | Rail | **Cmd/Ctrl+\\**; Alt+Enter on a header solos it |
| Undo last marker change | Toast Undo (≥ 10 s) | **Cmd/Ctrl+Z** (cleared after a run) |
| Speed, Back to playhead | Menu / button | — |
| Shortcut list | Toolbar | **?** |

**Esc**, innermost first, one action per press:
1. revert a field
2. close a popover or menu
3. cancel a drag or reassign
4. close the overlay sidebar

### Focus
- Menus and popovers return focus to their trigger (for the Measures grid, the same cell).
- After "Add marker", focus goes to "Set to playhead".
- After a delete, focus goes to the next row, else the previous one, else the empty state.
- Collapsing a pane focuses its header.
- The overlay sidebar focuses its first header; Esc returns focus to the rail.
- After a recompute finishes, focus stays where it was, and the result is announced.

### Accessible names and announcements
- Regions: "Confidence map", "Score", "Joint playback", "Sync sidebar".
- Separators: "Resize score and joint playback".
- Marker icons: "Marker ‘Horn entry’, bar 12 beat 3 at 1:23.456, applied — edit" or "…, pending: recompute to apply — edit".
- The roll is a `role="group"` with `aria-roledescription="piano roll"`.
- One polite live region announces commits, bound errors, the selection, the recompute suggestion, and run results.

### Legends
- Confidence colors, plus the pending hatch.
- Section chips.
- Applied vs pending pin.
- The roll's Key popover.

### States
- Existing alignment states.
- Score loading, and the schematic fallback.
- "Preparing notes…".
- "Loading detailed waveform…" or "Zoomed waveform unavailable".
- Empty filter: "Show all".
- No markers yet.
- No measures match: "Clear filters".
- Run error, with Retry and Cancel.
- "Not saved · Retry".
- Disabled reasons during a run.
- Import warnings: a toast (T1), then the Markers note and badges (T12).
- Collapsed panes show the selection.

---

## 6. Testing strategy

- **Unit (node):** every pure module.
- **Component (jsdom, Node 24, required):** Transport, Panes, MarkerDetails, MarkerPopover, RecomputeSuggestion, NoteContextMenu, ScorePane, SyncSidebar, ImportPage, and the updated SyncPage test.
- **API:** strict sync validation, including `applied`.
- **E2E (default config):** the per-task specs, plus `score-positions` and the legacy `open-project` step (T1). The owner's core loop (place → nothing audible changes → recompute → timing and confidence update together) is checked in T13 against the server's stored run output.
- **Perf:** `npm run test:perf` (separate config, port, server and dist dir). It is a manual gate before merging T8, T11a, T11b and T12, compared against the T0 baseline.
- **Gate per PR:** lint (React Compiler rules), typecheck, `npm test`, `test:api` when the server is touched, and the three existing Sync specs.

---

## 7. Risks, open questions and lead decisions to confirm

| # | Item | Needs a human? | Default |
|---|---|---|---|
| Q1 | Pitch roll vs the later-phase "pitch" display | Confirm | Proceed, Sync only |
| Q2 | Audience (STATE question 4) | Yes, existing | Doesn't block |
| G-flag 1 | One-item context menu; arrows in Score move the cue; markers that can't be kept exactly are pushed and flagged; layout stored in localStorage | Kept by the owner without comment | As described |
| G-flag 2 | The owner notes still say a drag "recomputes by merging the markers again" and "adding or moving a marker adjusts timing". Both contradict the newest decision, "visual until recompute". | Confirm the notes can be updated | Follow the newest decision |
| G-flag 3 | Recompute suggestion threshold (> 250 ms from the landing, or ≥ 5 pending) and default range (pending bars ± 2) | Confirm values | As stated |
| G-flag 4 | A pending item touching bars outside a range recompute stays pending. A deleted marker stays audible until a recompute covers it. | Confirm | As stated |
| R1 | Panes library size; separator preview | No | ≤ 15 KB gzip plus the T8 spike, else in-house or the width freeze |
| R2 | A partial recompute mixes applied and resolved markers | No | Merge push-and-flag, never non-monotonic; shown as "can't be kept exactly" |
| R3 | Legacy positions | No | Snap under both readings, take the closer |
| R4 | Range seams | No | Clamp, cap at 59, count |
| R5 | Edits during a run | No | Locked, with the reason shown |
| R6 | OSMD private geometry | No | Re-run the score specs on any upgrade |
| R7 | Recording memory | No | Keep the LRU, measure, fall back to 22.05 kHz peaks |
| R8 | Stacking on uncommitted work | Team | T0 prerequisite |
| R9 | Old clients dropping `applied` during rollout | No | Next load treats it as legacy (`applied = manual`): pending becomes audible, still monotonic; documented |
| R10 | Until the sync function honours markers, a recompute may disagree with a marker between bars | No (owner: comes later) | The merge pins timing to the applied markers; confidence is the run's own |

---

## 8. ADRs

- **0017 Sync workspace and `react-resizable-panels`.**
  - MIT, React `^18 || ^19` peers, no dependencies, `sideEffects: false`; measured size; pinned at 4.21.0.
  - The separator spike and the width-freeze fallback.
  - The in-house fallback behind `ui/Panes.tsx`.
  - Layout in localStorage, written only on user changes.
- **0018 Markers: pending until recompute.**
  - `manual` vs `applied`, and why two lists (exact Undo, no tombstones, a derived pending mark that survives reload).
  - Timing, playback and export read `applied`.
  - The resolution rule.
  - Legacy loads give `applied = manual`; behavior when old clients drop `applied`.
  - `label`, per-marker `basis`, the both-readings snap, `canonicalPosition`, normalizing both lists.
  - Confidence comes only from runs.
  - `markerBounds` against `manual`; the fixed-anchor merge with push-and-flag.
  - One validator, explicit writers; the file stays at version 1.
- **0019 Black-box sync function and the method registry.**
  - `runSync` owns every use of markers: today that is only window narrowing at marked downbeats, and the fit doesn't use them yet.
  - The whole-piece result is unchanged from today.
  - Range: window rules, one audio slice, chroma fallback on the inner window, splice, seams, average.
  - An honest `method` for whole-piece runs; a fallback is reported in the result message only (owner).
  - Smooth = integrated; Rigid stays disabled until registered.
  - Amends 0014.
- **0020 Joint playback.**
  - Recording-time axis, bar maps, sounding pitch with named ticks.
  - Section colors.
  - The landing line (applied) vs the pending pin (intended).
  - Canvas layers, LOD bins, the single focus model, the press/drag threshold, no merge during a drag.
  - The peak pyramid.
  - Budgets and perf policy; speed applies to the recording only.
- **Amend 0016:**
  - the Sync right-click menu
  - arrows in the Score pane move the cue
  - the keyboard menu at the cue
  - stamp ↔ time conversion

---

## 9. Deferred — ask owner

- **Suggested markers:** later, the sync function itself will find markers and offer them, and the user will accept or delete them. Postponed until that's fully clear. The black-box output may carry proposed markers later; nothing is built for it now.
- **Enforcing markers inside the sync fit**, including how to treat markers that sit very close together. Comes later, with changes to the sync function.
- **Per-bar memory of which method ran.** The owner said the result message is enough.
- Layout saved to the profile.
- More context-menu items.
- Clearing markers in a range.
- Undo for a run.
- A with/without-marker filter.
- A stacked layout under 768 px.
- F6 to cycle panes.
- `F` for "Back to playhead".
- Speed keys `<` / `>`.
- Hover-linking between the roll and the score.
- Hiding the score's overview ruler on Sync.
- A nightly perf job.

---

## Earlier rounds

**Rounds 1–6:**
- Settled the localStorage layout, the one-item menu, and the fixed-anchor merge with its bounds.
- Introduced per-marker basis, with all score-position conversion done in T1.
- Added the shared validator, render hygiene and LOD, key ownership, grid and list semantics, Undo with Cmd/Ctrl+Z, and legends.
- Added the Node 24 and jsdom gates, lanes, per-task specs, the T11 split, and a separate perf suite.
- Applied owner answers: suggested markers deferred, confidence only from runs, the black-box sync function, Next uncertain skipping marked bars, the Measures marker button, section colors, the landing line, the From/To link, the Lightroom-style sidebar, and pitch names.

**Partly wrong findings,** corrected in the text: round 1 C7 and B3, round 2 B6, round 3 C3.

## Review responses (round 7 + owner answers)

| ID | Fix |
|---|---|
| Owner: "visual until recompute" | §2.3: two lists. `manual` is drawn; `applied` drives timing, playback, Preview and export (T1 makes `useProjectTiming` and `exportMp4` read `applied`). Recompute = the black-box run; on success, pending items fully inside the range are applied, and timing and confidence update together. A non-blocking suggestion (> 250 ms or ≥ 5 pending), never automatic, with a default range of pending bars ± 2, following the owner's "the marker's bar plus a few around it". Core-loop e2e in T13; "visual only" e2e in T10 and T11b. Removed as dead: `SyncState.changed`, `movedBars`, `restoreChanged`, the per-frame drag re-merge and its 12 ms budget (now 8 ms with no merge), and the "changed since last sync" text and tests. |
| Owner: method memory | None stored. Fallback is reported only in the result message (§3.5, T13). G-flag removed; added to §9. |
| Lead reading: differences | (1) Two lists instead of per-marker `pending`/`appliedSec` fields or tombstones. They give exact Undo, no tombstones for consumers to filter, and survive reload through every writer as one additive field (justified in §2.3 and ADR 0018). (2) Deletes are pending, not immediate, matching "visual until recompute" (G-flag 4). (3) Bounds are checked against the `manual` set, and partial-recompute mixes rely on push-and-flag, with a property test (§3.1). |
| B1 = F1 | Edits never touch `applied`, so Undo restores `manual` exactly and the pending mark follows automatically. A successful run clears the undo slot and toast. Tests: "Undo inverse … restores manual exactly", "a successful run clears the undo slot and toast" (T9). |
| D1 = G1 | Moot. The mark is "bar holds a pending item". A recompute applies only items whose bars are all inside the range, and merged re-timing outside the range is audible behavior of applied markers, not a mark (§2.3, `resolveRange` test). |
| E1 | Moot. Only bars holding a pending item are marked. Nothing marks the whole piece (`pendingOf`, T1 tests). |
| G2 nit | Window narrowing moved inside `runSync`, which now receives the recording, current timing and markers and owns every marker use. Test: "window narrowing is the only use and lives inside runSync" (§2.4, T4). |

## Round 8 findings folded into the build (owner approved the plan; these are applied during implementation)

Scores on revision 9: A 10, B 8, C 10, D 8, E 8, F 8, G 9.
- **Local recompute ranges (G1):** the default is per cluster — each pending item's bars ± 2, overlapping clusters merged; "Recompute all pending" runs one range job per cluster, in sequence.
- **Window from the timing the run will produce (B1 = D1 = G2):** `runSync` plans range windows from `mergeAlignment(auto, applied′)`, so an edge next to a resolved marker uses the marker's new time.
- **Continue guard (E1 = G3):** with pending markers, Continue asks "N markers aren't applied yet" with Recompute / Continue without them; Preview and Export show a one-line notice linking to Sync.
- **R key (E2):** focuses the Recompute button; it never starts a run by itself.
- **Pending deletions and Revert (E3):** deleted applied markers draw as a crossed-out ghost pin at the applied position; any pending item has "Revert" (copies the applied version back into `manual`).
- **One formatter for the suggestion copy (E4).**
- **Rollout (F1):** built and merged as one change, so there is no stretch where edits are silent before Recompute exists.
- **Merge cache keyed on the arrays (B2):** nested WeakMap `auto → applied`; store commands replace only `manual`.
- **normalizeMarkers dedupes over the union of ids (D2)** and applies one id mapping to both lists.
- **resolveRange never yields two applied markers on one note (D3):** an item whose target note is still held by an unresolved applied marker stays pending.
- G-flag 2 resolved (owner notes updated). G-flags 3 and 4 kept as defaults: > 250 ms or ≥ 5 pending triggers the suggestion; deletions wait for a recompute.

## Owner layout changes (2026-11-10, during the build)

Owner: reduce buffer space as much as possible.
- **No page title row.** "Sync the recording" and the recording/bars/confidence/markers line are removed from the top. The counts move into the sidebar (small text); Continue, the sidebar toggle and a **Help** button ("how to sync") sit in the sidebar's top corner (a thin rail when the sidebar is hidden).
- **One box for the whole workspace.** No rounded box per section: one bordered area, with a single 1 px line between sections (and between the sections and the sidebar). The lines are the resize handles.
- **No section title bars.** "Confidence map", "Score" and "Joint playback" headers are removed. Each section has a small minimize control inside its own top corner; a minimized section is a thin strip with its name, which restores it.
- **Score controls float over the score.** Page ‹ ›, Go to, zoom, Fit width/page and Follow sit in a compact bar overlaid on the top of the score window, not in a row above it. The overview ruler is hidden on Sync (the confidence map is the overview). The "Click a note to select it…" help line is removed (it moves into Help).
- **Hiding a section gives its room to the others**, the score in particular.
- **Joint playback is split by lines into parts** — filters, piano roll, waveform, transport — and the roll/waveform boundary is resizable. Each can be zoomed: time zoom shared by roll and waveform; vertical zoom of the roll (pitch range, buttons or Alt + wheel) and of the waveform (amplitude, buttons or Shift + wheel over the waveform: "make the peaks higher").
