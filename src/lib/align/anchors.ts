/**
 * Manual markers as fixed anchors for the aligners (ADR 0021).
 *
 * A marker pins a note onset (its bar plus a time fraction of that bar) to a
 * recording time. The aligners take it as a pair of clocks: score seconds
 * (from the info map they are given) and recording seconds (in the audio they
 * are given). Both aligners make their fit pass through every anchor:
 *
 * - the coarse search (subsequence DTW, or chroma DTW) may only use cells on
 *   the right side of each anchor, within a small tolerance of it;
 * - the integrated joint fit holds a knot fixed at each anchor;
 * - the seed between anchors is re-timed proportionally, so the ±4 s corridor
 *   follows the user's correction.
 */
import type { InfoMap } from "@/shared/info-map";
import { markerPosition, type ManualMarker } from "@/shared/sync";
import { interp } from "./integrated/signal";

export interface AlignAnchor {
  /** seconds in the info map handed to the aligner */
  scoreSec: number;
  /** seconds in the audio handed to the aligner */
  sec: number;
}

/** Anchors closer than this in score time are one note; the later edit is kept. */
const SAME_NOTE_SEC = 1e-6;
/** Smallest recording gap per second of score between consecutive anchors (a 20× speed-up). */
const MIN_RATE = 0.05;

/**
 * Score/recording pairs of the markers, sorted. Markers on unknown bars are
 * skipped; one that would run time backwards against an earlier kept anchor
 * is dropped (mergeAlignment still lists it as unhonoured).
 */
export function markerAnchors(infoMap: InfoMap, markers: ManualMarker[]): AlignAnchor[] {
  const byNumber = new Map(infoMap.measures.map((m, i) => [m.number, i]));
  const raw: AlignAnchor[] = [];
  for (const m of markers) {
    const i = byNumber.get(m.measure);
    if (i === undefined || !Number.isFinite(m.startSec)) continue;
    const bar = infoMap.measures[i];
    raw.push({ scoreSec: bar.startTime + markerPosition(m) * bar.duration, sec: m.startSec });
  }
  return cleanAnchors(raw);
}

/** Sorted by score time, one per note, strictly increasing in both clocks. */
export function cleanAnchors(list: AlignAnchor[]): AlignAnchor[] {
  const sorted = list.filter((a) => Number.isFinite(a.scoreSec) && Number.isFinite(a.sec)).sort((a, b) => a.scoreSec - b.scoreSec);
  const out: AlignAnchor[] = [];
  for (const a of sorted) {
    const last = out[out.length - 1];
    if (last && a.scoreSec - last.scoreSec < SAME_NOTE_SEC) {
      out[out.length - 1] = a;
      continue;
    }
    if (last && a.sec - last.sec < MIN_RATE * (a.scoreSec - last.scoreSec)) continue;
    out.push(a);
  }
  // a replaced duplicate can break the order with its predecessor: drop those
  return out.filter((a, k) => k === 0 || a.sec - out[k - 1].sec >= MIN_RATE * (a.scoreSec - out[k - 1].scoreSec));
}

/**
 * Anchors moved into a slice: score seconds from `scoreStart`, recording
 * seconds from `audioStart`. Only anchors inside [0, scoreDuration] ×
 * [0, audioDuration] are kept (an anchor on the next bar's downbeat sits
 * exactly at the slice's end and is kept).
 */
export function shiftAnchors(
  anchors: AlignAnchor[],
  scoreStart: number,
  scoreDuration: number,
  audioStart: number,
  audioDuration: number,
): AlignAnchor[] {
  const eps = 1e-6;
  return anchors
    .map((a) => ({ scoreSec: a.scoreSec - scoreStart, sec: a.sec - audioStart }))
    .filter((a) => a.scoreSec >= -eps && a.scoreSec <= scoreDuration + eps && a.sec >= 0 && a.sec <= audioDuration)
    .map((a) => ({ scoreSec: Math.max(0, Math.min(scoreDuration, a.scoreSec)), sec: a.sec }));
}

/**
 * Per-row column bounds for a DTW whose rows are score frames and columns
 * recording frames: a row before an anchor stays at or left of its column, a
 * row after it at or right of it, each with `tolerance` columns of slack.
 * Rows with no constraint get [0, cols − 1].
 */
export function anchorColumnBounds(
  anchors: Array<{ row: number; col: number }>,
  rows: number,
  cols: number,
  tolerance: number,
): { lo: Int32Array; hi: Int32Array } {
  const lo = new Int32Array(rows).fill(0);
  const hi = new Int32Array(rows).fill(cols - 1);
  const sorted = [...anchors].sort((a, b) => a.row - b.row);
  // lo: the latest anchor at or before the row
  let k = -1;
  for (let i = 0; i < rows; i++) {
    while (k + 1 < sorted.length && sorted[k + 1].row <= i) k++;
    if (k >= 0) lo[i] = Math.max(0, Math.min(cols - 1, sorted[k].col - tolerance));
  }
  // hi: the earliest anchor at or after the row
  k = sorted.length;
  for (let i = rows - 1; i >= 0; i--) {
    while (k - 1 >= 0 && sorted[k - 1].row >= i) k--;
    if (k < sorted.length) hi[i] = Math.max(0, Math.min(cols - 1, sorted[k].col + tolerance));
  }
  for (let i = 0; i < rows; i++) if (hi[i] < lo[i]) hi[i] = lo[i];
  return { lo, hi };
}

/**
 * A score→recording mapping re-timed so it passes through every anchor:
 * proportionally between two anchors (in the mapping's own time, as
 * mergeAlignment does), shifted before the first and after the last. Anchor
 * points are inserted. The input must be increasing in both clocks.
 */
export function anchorMapping(mapping: { score: number[]; recording: number[] }, anchors: AlignAnchor[]): { score: number[]; recording: number[] } {
  const lo = mapping.score[0];
  const hi = mapping.score[mapping.score.length - 1];
  const inside = anchors.filter((a) => a.scoreSec >= lo - 1e-9 && a.scoreSec <= hi + 1e-9);
  if (inside.length === 0) return mapping;
  const base = (s: number) => interp(s, mapping.score, mapping.recording);
  const at = inside.map((a) => ({ s: a.scoreSec, b: base(a.scoreSec), r: a.sec }));
  const warp = (s: number): number => {
    const x = base(s);
    if (s <= at[0].s) return x + (at[0].r - at[0].b);
    for (let k = 0; k + 1 < at.length; k++) {
      const a = at[k];
      const c = at[k + 1];
      if (s <= c.s) {
        const span = c.b - a.b;
        // proportional in the mapping's own time; linear in score time when it is flat
        const f = span > 1e-9 ? (x - a.b) / span : (s - a.s) / (c.s - a.s || 1);
        return a.r + Math.max(0, Math.min(1, f)) * (c.r - a.r);
      }
    }
    const last = at[at.length - 1];
    return x + (last.r - last.b);
  };
  const score = [...mapping.score];
  for (const a of at) score.push(a.s);
  score.sort((a, b) => a - b);
  const uniq = score.filter((s, k) => k === 0 || s - score[k - 1] > 1e-9);
  const recording = uniq.map((s) => {
    const exact = at.find((a) => Math.abs(a.s - s) <= 1e-9);
    return exact ? exact.r : warp(s);
  });
  return { score: uniq, recording };
}
