# 0019. The sync function is a black box; range runs; methods

Date: 2026-11-10
Status: proposed (amends 0014)

## Context
Owner:
- "Select measure range. Run a syncing method. Can choose rigid or smooth."
- On markers inside a run: "we need to handle changing the syncing function itself... this comes later. just make it a black box for now."

## Decision
- **`runSync` (`src/lib/align/sync-function.ts`)** receives:
  - the score, the recording and the previous `auto`;
  - a range (or none, for the whole piece);
  - a style;
  - the markers the run will apply.

  It returns bars, the method that actually ran, and the fallback flag.
- **Today's implementation.**
  - **Whole piece:** exactly the existing call.
  - **Range:**
    - the score is sliced (`sliceInfoMap`);
    - the window is planned from the timing the run will produce (`planRangeWindow`): padded 2–8 s, or 0.25 s at a marked downbeat;
    - only the window is downmixed;
    - integrated alignment runs first, then chroma DTW on the inner window.
  - The fit uses the markers as fixed anchors (ADR 0021); the merge then pins timing to them.
- **Writing the result** (`src/lib/api/sync-run.ts`).
  - A range result is spliced into `auto`. Seams that would break the order are clamped and capped at 59%, and the average is recomputed.
  - A range run keeps the last whole-piece `method` and diagnostics. A fallback shows only in the result line ("the result message is enough", owner).
- **Default recompute ranges are local:** each pending bar ± 2, merged when they touch, one job per range.
- **Methods** (`src/lib/align/methods.ts`).
  - Smooth is the integrated tempo fit.
  - Rigid is shown and disabled until built. Adding it means: implement it behind `runSync`, add a `case` in `runAlignment`, register it, and write an ADR.

## Consequences
- Anchors inside or next to a range re-time the merged bars between the last anchor before it and the first after it.
- Changing how runs use markers is now a change inside `runSync` only.
