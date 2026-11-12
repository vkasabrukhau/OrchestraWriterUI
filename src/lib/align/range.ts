import type { InfoMap } from "@/shared/info-map";
import { MIN_ALIGNMENT_GAP, markerPosition, type ManualMarker, type MeasureAlignment } from "@/shared/sync";

/** Seams that would break the order are clamped and their confidence capped here. */
export const SEAM_CONFIDENCE_CAP = 59;

/**
 * Bars [from, to] (1-based playback bars) as a score of their own: bars
 * renumbered from 1, times shifted to start at 0, the tempo in force at
 * `from` kept as the first entry, fermatas clipped.
 */
export function sliceInfoMap(infoMap: InfoMap, from: number, to: number): InfoMap {
  const a = Math.max(1, Math.min(from, infoMap.measures.length));
  const b = Math.max(a, Math.min(to, infoMap.measures.length));
  const first = infoMap.measures[a - 1];
  const last = infoMap.measures[b - 1];
  const t0 = first.startTime;
  const t1 = last.startTime + last.duration;
  const measures = infoMap.measures.slice(a - 1, b).map((m, i) => ({ ...m, number: i + 1, startTime: m.startTime - t0 }));
  const instruments = infoMap.instruments.map((inst) => ({
    ...inst,
    notes: inst.notes.filter((n) => n.measure >= a && n.measure <= b).map((n) => ({ ...n, time: n.time - t0, measure: n.measure - a + 1 })),
  }));
  let timing = infoMap.timing;
  if (timing) {
    let current = timing.tempo[0]?.bpm ?? infoMap.tempo;
    const inside: Array<{ time: number; bpm: number }> = [];
    for (const t of timing.tempo) {
      if (t.time <= t0 + 1e-9) current = t.bpm;
      else if (t.time < t1) inside.push({ time: t.time - t0, bpm: t.bpm });
    }
    timing = {
      tempo: [{ time: 0, bpm: current }, ...inside],
      fermatas: timing.fermatas.filter((f) => f.end > t0 && f.start < t1).map((f) => ({ start: Math.max(0, f.start - t0), end: Math.min(t1, f.end) - t0 })),
    };
  }
  return { ...infoMap, instruments, measures, duration: t1 - t0, timing };
}

export interface RangeWindow {
  /** the audio handed to the aligner */
  startSec: number;
  endSec: number;
  /** where bars [from, to] are expected to sit (no padding) */
  innerStartSec: number;
  innerEndSec: number;
}

/**
 * The recording window for a range run, planned from the timing the run will
 * produce (`aligned` = merge(auto, the markers it applies)), so an edge next to
 * a marker the run applies sits at that marker's new time. The inner window
 * starts at 0 for bar 1 and ends at the recording's end for the last bar.
 * Padding: clamp(0.15 × span, 2 s, 8 s), or 0.25 s on a side pinned by a
 * downbeat marker. The whole window is at least 2 s (the integrated minimum).
 */
export function planRangeWindow(
  aligned: MeasureAlignment[],
  range: { from: number; to: number },
  durationSec: number,
  markers: ManualMarker[],
): RangeWindow {
  const count = aligned.length;
  const innerStartSec = range.from <= 1 ? 0 : (aligned[range.from - 1]?.startSec ?? 0);
  const innerEndSec = range.to >= count ? durationSec : Math.min(durationSec, aligned[range.to]?.startSec ?? durationSec);
  const span = Math.max(0, innerEndSec - innerStartSec);
  const free = Math.min(8, Math.max(2, 0.15 * span));
  const downbeat = (bar: number) => markers.some((m) => m.measure === bar && markerPosition(m) === 0);
  const padStart = range.from > 1 && downbeat(range.from) ? 0.25 : free;
  const padEnd = range.to < count && downbeat(range.to + 1) ? 0.25 : free;
  let startSec = Math.max(0, innerStartSec - padStart);
  let endSec = Math.min(durationSec, innerEndSec + padEnd);
  if (endSec - startSec < 2) {
    const grow = (2 - (endSec - startSec)) / 2;
    startSec = Math.max(0, startSec - grow);
    endSec = Math.min(durationSec, Math.max(endSec + grow, startSec + 2));
  }
  return { startSec, endSec, innerStartSec, innerEndSec };
}

/**
 * Put a range run's bars into the previous alignment. Bars outside keep their
 * objects; a seam that would break the order is clamped and its confidence
 * capped. Returns the new list, the recomputed average and the clamp count.
 */
export function spliceAuto(prev: MeasureAlignment[], partial: MeasureAlignment[], range: { from: number; to: number }): { auto: MeasureAlignment[]; averageConfidence: number; seamClamped: number } {
  const byN = new Map(partial.map((p) => [p.n, p]));
  let seamClamped = 0;
  const auto = prev.map((a) => {
    if (a.n < range.from || a.n > range.to) return a;
    const p = byN.get(a.n);
    return p ? { n: a.n, startSec: p.startSec, confidence: p.confidence } : a;
  });
  // the order across both seams and inside the range
  for (let i = Math.max(1, range.from - 1); i < auto.length && i <= range.to; i++) {
    const prevStart = auto[i - 1].startSec;
    if (auto[i].startSec <= prevStart + MIN_ALIGNMENT_GAP) {
      const inRange = auto[i].n >= range.from && auto[i].n <= range.to;
      const target = inRange ? auto[i] : auto[i - 1];
      if (inRange) auto[i] = { ...target, startSec: prevStart + MIN_ALIGNMENT_GAP, confidence: Math.min(target.confidence, SEAM_CONFIDENCE_CAP) };
      else auto[i - 1] = { ...auto[i - 1], startSec: auto[i].startSec - MIN_ALIGNMENT_GAP, confidence: Math.min(auto[i - 1].confidence, SEAM_CONFIDENCE_CAP) };
      seamClamped++;
    }
  }
  const averageConfidence = auto.length ? Math.round(auto.reduce((s, a) => s + a.confidence, 0) / auto.length) : 0;
  return { auto, averageConfidence, seamClamped };
}

/**
 * Local recompute ranges: each pending bar ± `pad`, clamped, with
 * overlapping or touching ranges merged (owner: "the marker's bar plus a few
 * around it").
 */
export function recomputeRanges(bars: Iterable<number>, count: number, pad = 2): Array<{ from: number; to: number }> {
  const sorted = [...new Set(bars)].filter((b) => b >= 1 && b <= count).sort((a, b) => a - b);
  const out: Array<{ from: number; to: number }> = [];
  for (const b of sorted) {
    const from = Math.max(1, b - pad);
    const to = Math.min(count, b + pad);
    const last = out[out.length - 1];
    if (last && from <= last.to + 1) last.to = Math.max(last.to, to);
    else out.push({ from, to });
  }
  return out;
}
