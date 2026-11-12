# 0018. Markers are visual until a recompute

Date: 2026-11-10
Status: proposed (amends 0016 note-level markers)

## Context
Owner, 2026-11-09:
- "visual until recompute. upon placing certain markers the app may suggest a recompute"
- "adding the marker shouldnt affect the confidence until its resyncd"

With far-off timestamps, re-timing the piece on every marker edit made adjustments hard.

## Decision
- **Two lists in `SyncState`.**
  - `manual` holds the markers as the user sees and edits them.
  - `applied` (optional) holds the markers timing uses. It is a snapshot taken at the last recompute covering each one.
  - Playback, Preview, Customize, the Stage and MP4 export read `mergeAlignment(auto, applied)` (`mergedAlignment` in `useProjectTiming`, cached per array pair).
- **Pending items are derived by id** (`pendingOf`):
  - new: in `manual`, not in `applied`;
  - moved: in both, with different timing;
  - deleted: in `applied`, not in `manual`.

  A label change is not pending. Bars holding one are hatched.
- **A recompute applies pending items** whose bars all lie inside its range (`resolveRange`). It never leaves two applied markers on one note. A whole-piece run applies everything.
- **Confidence always comes from the aligner.** The merge copies it, so markers never change it.
- **Merge final pass.** Anchors keep their time when there is room for the knots between them (`MIN_ALIGNMENT_GAP` each). Otherwise the anchor is pushed and listed in `unhonoured`, so the result is always monotonic. `markerBounds` checks an edit against the edited set, using the neighbours' final times.
- **Positions are time fractions** (`basis: "time"`). Legacy positions are converted once by `normalizeMarkers` (`src/lib/score/stamps.ts`):
  - each is snapped under both readings, keeping the closer onset;
  - duplicates are collapsed;
  - a missing `applied` becomes `manual`, so nothing becomes pending.

  The score converts OSMD's musical fractions in all five places it uses them.
- **Labels and validation.**
  - Markers have an optional `label` (≤ 80 code points).
  - One validator, `parseSyncState`: strict on API writes and the mock, lenient on files. Unknown keys are dropped and ids must be unique per list.
- **File version.** The project file stays version 1, because the new fields are optional.

## Consequences
- **Undo** restores `manual` exactly, and a run clears the undo slot.
- **Leaving Sync with pending markers** asks first. Preview and Export show a notice.
- **Old clients** that drop `applied` make pending markers audible on the next load. This is safe and monotonic.
