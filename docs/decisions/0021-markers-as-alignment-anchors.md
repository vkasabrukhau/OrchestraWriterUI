# 0021. Markers are fixed anchors inside the aligners

Date: 2026-11-12
Status: proposed (amends 0019; keeps 0018)

## Context
Before this change, the aligners never saw manual markers (ADR 0019: "the fit does not use the markers yet").
`mergeAlignment` pinned the result to them afterwards, re-timing the aligner's bars proportionally between markers.
After the last marker, every bar was shifted by that marker's offset. A marker fixed its own bar but did not help the aligner find the bars after it, and a correction never fed back into the fit.

## Decision
- `runSync` turns the markers a run applies into anchors: pairs of score seconds and recording seconds (`markerAnchors`, `src/lib/align/anchors.ts`).
  - A range run moves them into its slice and window (`shiftAnchors`). An anchor on the next bar's downbeat sits on the slice's end and is kept.
  - Anchors are passed in `AlignOptions.anchors`, so they reach the Web Worker.
- **Integrated tempo** (ADR 0014):
  - The 2 Hz broad match may not cross an anchor. Each score row is fenced to the right side of every anchor, ±1 column (0.5 s).
  - The seed is then re-timed to pass through each anchor exactly (`anchorMapping`): proportionally between anchors, shifted outside them. The ±4 s corridor follows it.
  - The joint fit puts a knot on each anchor and holds it fixed (`DirectInput.fixed`). The tempo between and after anchors is refitted against the audio.
  - If the fit is rejected, it falls back to the seed, which already passes through the anchors.
- **Chroma DTW** (ADR 0009):
  - The band's center line runs through the anchors, and rows are fenced as above (±1 frame).
  - The measure starts are re-timed through the anchors exactly (`pinStarts`).
  - A jump step's middle cell must now lie inside its row's band too. Before, a band edge could leak by one column.
- Anchors are cleaned first: sorted, one per note (the later edit wins), and dropped when they would make time run backwards. `mergeAlignment` stays as the final pass. It changes nothing at honoured anchors and still lists any unhonoured ones.

## Consequences
- A marker now improves its neighbourhood. On the warped demo, a marker placed 0.6 s late is honoured exactly, and the bars 6–15 after it return to within 150 ms of the truth. With a merge alone, every one of those bars was off by about 0.6 s (`tests/unit/align/anchors.test.ts`).
- Confidence still comes only from sync runs (ADR 0018). A run with anchors reports the confidence of the anchored fit, so a wrong marker can lower its neighbours' confidence after a recompute. Adding a marker without a recompute changes nothing.
- `auto` now depends on the markers applied at the last run. A deleted marker still shapes `auto` until the next recompute covering it, which deletions already wait for (ADR 0018).
- The broad match, the fit and the confidence are unchanged when there are no markers.
- To revisit:
  - soft anchors (a weight instead of a hard constraint) if users place rough markers;
  - anchors outside a fitted range (the last bar's notes in chroma DTW) are left to the merge.
