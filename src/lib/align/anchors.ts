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
import { MIN_ALIGNMENT_GAP, markerPosition, type ManualMarker, type MeasureAlignment } from "@/shared/sync";
import { interp } from "./integrated/signal";

export interface AlignAnchor {
  /** seconds in the info map handed to the aligner */
  scoreSec: number;
  /** seconds in the audio handed to the aligner */
  sec: number;
}

/** Anchors closer than this in score time are one note; the later edit is kept. */
const SAME_NOTE_SEC = 1e-6;
/** Score seconds over which an anchor's correction fades out beyond the outermost anchors (anchorMapping). */
export const ANCHOR_TAPER_SEC = 30;
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
 * mergeAlignment does); before the first and after the last, shifted by that
 * anchor's correction fading to nothing over ANCHOR_TAPER_SEC of score.
 * Anchor points are inserted. The input must be increasing in both clocks.
 */
export function anchorMapping(mapping: { score: number[]; recording: number[] }, anchors: AlignAnchor[]): { score: number[]; recording: number[] } {
  const lo = mapping.score[0];
  const hi = mapping.score[mapping.score.length - 1];
  const inside = anchors.filter((a) => a.scoreSec >= lo - 1e-9 && a.scoreSec <= hi + 1e-9);
  if (inside.length === 0) return mapping;
  const base = (s: number) => interp(s, mapping.score, mapping.recording);
  const at = inside.map((a) => ({ s: a.scoreSec, b: base(a.scoreSec), r: a.sec }));
  // Outside the outermost anchors the correction fades out over TAPER_SEC of
  // score: an anchor's residual against a coarse path is mostly that path's
  // slack near the anchor, not evidence about bars far from it.
  const fade = (d: number) => Math.max(0, 1 - d / ANCHOR_TAPER_SEC);
  const warp = (s: number): number => {
    const x = base(s);
    if (s <= at[0].s) return x + (at[0].r - at[0].b) * fade(at[0].s - s);
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
    return x + (last.r - last.b) * fade(s - last.s);
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

/** a bar whose start moved less than this between two runs counts as unchanged (localizeMarkerRun) */
export const MARKER_REACH_TOLERANCE_SEC = 0.05;

/**
 * Keep a marker run's changes where the markers reach (ADR 0024).
 *
 * A run with new or moved markers re-solves the whole piece, so it can also
 * move bars no marker supports: the broad path re-routes and the joint fit
 * settles differently far away. Starting at each marker's bar (and the next
 * one, for a marker inside a bar), the new timing is taken as far as it
 * departs from the previous run by more than MARKER_REACH_TOLERANCE_SEC, plus
 * one bar to close the seam; the previous timing stands elsewhere. A marker
 * that exposes a large error therefore re-times as far as the departure
 * runs, the whole piece if it does.
 *
 * `prev` and `next` are the aligner's bars (1-based `n`, same score). With no
 * usable previous run, `next` is returned unchanged.
 */
export function localizeMarkerRun(prev: MeasureAlignment[], next: MeasureAlignment[], markerBars: number[]): MeasureAlignment[] {
  if (prev.length !== next.length || prev.length === 0 || markerBars.length === 0) return next;
  for (let i = 0; i < prev.length; i++) if (prev[i].n !== next[i].n) return next;
  const n = next.length;
  const moved = next.map((a, i) => Math.abs(a.startSec - prev[i].startSec) > MARKER_REACH_TOLERANCE_SEC);
  const take = new Uint8Array(n);
  for (const bar of markerBars) {
    for (const seed of [bar - 1, bar]) {
      if (seed < 0 || seed >= n) continue;
      let lo = seed;
      let hi = seed;
      while (lo > 0 && moved[lo - 1]) lo--;
      while (hi < n - 1 && moved[hi + 1]) hi++;
      for (let i = Math.max(0, lo - 1); i <= Math.min(n - 1, hi + 1); i++) take[i] = 1;
    }
  }
  const out = next.map((a, i) => (take[i] ? a : prev[i]));
  // seams between kept and re-solved bars stay in order
  for (let i = 1; i < n; i++) {
    const min = out[i - 1].startSec + MIN_ALIGNMENT_GAP;
    if (out[i].startSec < min) out[i] = { ...out[i], startSec: min };
  }
  return out;
}

/** Bars of markers added, moved or removed between two applied sets (by id, bar, position and time). */
export function changedMarkerBars(before: ManualMarker[], after: ManualMarker[]): number[] {
  const key = (m: ManualMarker) => `${m.id}|${m.measure}|${markerPosition(m)}|${m.startSec}`;
  const a = new Set(before.map(key));
  const b = new Set(after.map(key));
  const bars = new Set<number>();
  for (const m of after) if (!a.has(key(m))) bars.add(m.measure);
  for (const m of before) if (!b.has(key(m))) bars.add(m.measure);
  return [...bars].sort((x, y) => x - y);
}
