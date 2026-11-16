import type { MeasureInfo } from "@/shared/info-map";

/**
 * Playhead geometry for engraved notation. Geometry only: it never changes
 * audio or alignment times. Each bar is resolved on its own, so the line
 * never slides diagonally across a system break.
 */

/** A note or rest onset in a drawn bar: `stamp` is the fraction of the bar (0–1), `x` in CSS pixels. */
export interface Onset {
  stamp: number;
  x: number;
}

/** Sort by stamp and keep the leftmost x for each stamp (staves of one column differ slightly). */
export function normalizeOnsets(onsets: Onset[]): Onset[] {
  const byStamp = new Map<number, number>();
  for (const o of onsets) {
    if (!Number.isFinite(o.stamp) || !Number.isFinite(o.x)) continue;
    const key = Math.round(o.stamp * 1e6) / 1e6;
    const prev = byStamp.get(key);
    if (prev === undefined || o.x < prev) byStamp.set(key, o.x);
  }
  const out = [...byStamp].map(([stamp, x]) => ({ stamp, x })).sort((a, b) => a.stamp - b.stamp);
  // engraving can place a later onset left of an earlier one (cross-staff, grace notes): drop those
  const mono: Onset[] = [];
  for (const o of out) if (!mono.length || o.x >= mono[mono.length - 1].x) mono.push(o);
  return mono;
}

/** Playback bar (1-based) whose score-time span holds `t`. */
export function barAtScoreTime(measures: MeasureInfo[], t: number): number {
  let lo = 0;
  let hi = measures.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (measures[mid].startTime <= t) lo = mid;
    else hi = mid - 1;
  }
  return measures[lo]?.number ?? 1;
}

/** How far through bar `m` score time `t` is, 0–1. */
export function fractionInBar(m: MeasureInfo, t: number): number {
  if (!(m.duration > 0)) return 0;
  return Math.max(0, Math.min(1, (t - m.startTime) / m.duration));
}

/**
 * Playhead x for a fraction of the bar. Continuous mode glides between
 * onsets (and from the last onset to the bar's right edge); stepped mode
 * sits on the latest onset reached.
 */
export function playheadX(onsets: Onset[], left: number, right: number, frac: number, stepped = false): number {
  if (onsets.length === 0) return left + Math.max(0, Math.min(1, frac)) * (right - left);
  let i = 0;
  while (i + 1 < onsets.length && onsets[i + 1].stamp <= frac) i++;
  const a = onsets[i];
  if (frac <= a.stamp || stepped) return a.x;
  const b = onsets[i + 1] ?? { stamp: 1, x: Math.max(a.x, right - 4) };
  if (b.stamp <= a.stamp) return a.x;
  const w = (frac - a.stamp) / (b.stamp - a.stamp);
  return a.x + Math.max(0, Math.min(1, w)) * (b.x - a.x);
}

/** Bar fraction of the onset nearest to a click at `x` (falls back to the linear position). */
export function fractionAtX(onsets: Onset[], left: number, right: number, x: number): number {
  if (onsets.length === 0) return right > left ? Math.max(0, Math.min(1, (x - left) / (right - left))) : 0;
  let best = onsets[0];
  for (const o of onsets) if (Math.abs(o.x - x) < Math.abs(best.x - x)) best = o;
  return best.stamp;
}
