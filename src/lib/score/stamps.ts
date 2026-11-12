import type { InfoMap } from "@/shared/info-map";
import { markerPosition, type ManualMarker, type SyncState } from "@/shared/sync";

/**
 * Note positions inside a bar (ADR 0018). OSMD gives a bar's onsets as
 * **musical** fractions (beats over the bar's length); markers, the merge and
 * the clocks use **time** fractions (score seconds over the bar's duration).
 * They differ only in bars with a tempo change inside them.
 */

/** Tempo changes strictly inside bar n (score time), with the tempo in force at its start. */
function tempoInBar(infoMap: InfoMap, measure: number): { start: number; end: number; segs: Array<{ time: number; bpm: number }> } | null {
  const m = infoMap.measures[measure - 1];
  if (!m) return null;
  const start = m.startTime;
  const end = m.startTime + m.duration;
  const tempo = infoMap.timing?.tempo ?? [];
  let current = tempo.length ? tempo[0].bpm : infoMap.tempo || 120;
  const segs: Array<{ time: number; bpm: number }> = [];
  for (const t of tempo) {
    if (t.time <= start + 1e-9) current = t.bpm;
    else if (t.time < end - 1e-9) segs.push({ time: t.time, bpm: t.bpm });
  }
  return { start, end, segs: [{ time: start, bpm: current }, ...segs] };
}

/** Beats (quarters) elapsed from the bar's start to score time t, and the bar's total. */
function beatsTo(seg: Array<{ time: number; bpm: number }>, end: number, t: number): number {
  let q = 0;
  for (let i = 0; i < seg.length; i++) {
    const a = seg[i].time;
    const b = i + 1 < seg.length ? seg[i + 1].time : end;
    if (t <= a) break;
    q += ((Math.min(t, b) - a) * seg[i].bpm) / 60;
  }
  return q;
}

/** A musical fraction of bar `measure` as a time fraction (identity when the tempo is constant in the bar). */
export function musicalToTimeFraction(infoMap: InfoMap, measure: number, f: number): number {
  const bar = tempoInBar(infoMap, measure);
  if (!bar || bar.segs.length < 2 || bar.end <= bar.start) return f;
  const total = beatsTo(bar.segs, bar.end, bar.end);
  if (total <= 0) return f;
  let want = Math.max(0, Math.min(1, f)) * total;
  for (let i = 0; i < bar.segs.length; i++) {
    const a = bar.segs[i].time;
    const b = i + 1 < bar.segs.length ? bar.segs[i + 1].time : bar.end;
    const q = ((b - a) * bar.segs[i].bpm) / 60;
    if (want <= q || i === bar.segs.length - 1) {
      const t = a + (want / (bar.segs[i].bpm / 60));
      return (Math.min(t, bar.end) - bar.start) / (bar.end - bar.start);
    }
    want -= q;
  }
  return f;
}

/** A time fraction of bar `measure` as a musical fraction (inverse of musicalToTimeFraction). */
export function timeToMusicalFraction(infoMap: InfoMap, measure: number, f: number): number {
  const bar = tempoInBar(infoMap, measure);
  if (!bar || bar.segs.length < 2 || bar.end <= bar.start) return f;
  const total = beatsTo(bar.segs, bar.end, bar.end);
  if (total <= 0) return f;
  const t = bar.start + Math.max(0, Math.min(1, f)) * (bar.end - bar.start);
  return beatsTo(bar.segs, bar.end, t) / total;
}

/** Time fractions of every distinct onset in bar `measure`, ascending (computed per info map, cached). */
const onsetCache = new WeakMap<InfoMap, Map<number, number[]>>();
export function barOnsets(infoMap: InfoMap, measure: number): number[] {
  let byBar = onsetCache.get(infoMap);
  if (!byBar) {
    const raw = new Map<number, number[]>();
    for (const inst of infoMap.instruments) {
      for (const n of inst.notes) {
        const m = infoMap.measures[n.measure - 1];
        if (!m || m.duration <= 0) continue;
        const f = (n.time - m.startTime) / m.duration;
        if (f < -1e-9 || f >= 1) continue;
        const list = raw.get(n.measure) ?? [];
        list.push(Math.max(0, f));
        raw.set(n.measure, list);
      }
    }
    byBar = new Map();
    for (const [bar, list] of raw) {
      list.sort((a, b) => a - b);
      const dedup: number[] = [];
      for (const f of list) if (dedup.length === 0 || f - dedup[dedup.length - 1] > 1e-6) dedup.push(f);
      byBar.set(bar, dedup);
    }
    onsetCache.set(infoMap, byBar);
  }
  return byBar.get(measure) ?? [0];
}

function nearest(onsets: number[], f: number): { f: number; d: number } {
  let best = { f, d: Infinity };
  for (const o of onsets) {
    const d = Math.abs(o - f);
    if (d < best.d) best = { f: o, d };
  }
  return best;
}

/** Snap a time fraction to the nearest onset in the bar when within 1e-3 (so a score click and a roll drag on one note agree). */
export function canonicalPosition(infoMap: InfoMap, measure: number, timeFraction: number): number {
  if (timeFraction <= 1e-6) return 0;
  const n = nearest(barOnsets(infoMap, measure), timeFraction);
  return n.d <= 1e-3 ? n.f : timeFraction;
}

/** A legacy position: snap under both readings (musical, time) and keep the one whose onset is strictly closer as musical. */
function legacyToTime(infoMap: InfoMap, measure: number, p: number): number {
  const onsets = barOnsets(infoMap, measure);
  const asTime = nearest(onsets, p);
  const asMusical = nearest(onsets, musicalToTimeFraction(infoMap, measure, p));
  return asMusical.d < asTime.d ? asMusical.f : asTime.f;
}

function normalizeOne(infoMap: InfoMap, m: ManualMarker): ManualMarker {
  const p = markerPosition(m);
  let position: number;
  if (p <= 0) position = 0;
  else if (m.basis === "time") position = canonicalPosition(infoMap, m.measure, p);
  else position = legacyToTime(infoMap, m.measure, p);
  const out: ManualMarker = { ...m, basis: "time" };
  if (position > 0) out.position = position;
  else delete out.position;
  return out;
}

function noteKey(m: ManualMarker): string {
  return `${m.measure}:${markerPosition(m).toFixed(6)}`;
}

/** Markers kept after dropping all but the latest per note; returns the dropped ids. */
function dedupe(list: ManualMarker[]): Set<string> {
  const best = new Map<string, ManualMarker>();
  for (const m of list) {
    const k = noteKey(m);
    const cur = best.get(k);
    if (!cur || m.createdAt >= cur.createdAt) best.set(k, m);
  }
  const keep = new Set([...best.values()].map((m) => m.id));
  return new Set(list.filter((m) => !keep.has(m.id)).map((m) => m.id));
}

function same(a: ManualMarker[], b: ManualMarker[]): boolean {
  if (a.length !== b.length) return false;
  return a.every((m, i) => {
    const o = b[i];
    return o.id === m.id && o.measure === m.measure && o.position === m.position && o.startSec === m.startSec && o.basis === m.basis && o.label === m.label;
  });
}

/**
 * Bring stored markers to the current form (idempotent, ADR 0018): positions
 * become canonical time fractions, duplicates on one note collapse to the
 * latest (the same ids leave both lists, so no pending item appears), and a
 * legacy state without `applied` gets `applied = manual` (they were audible).
 * Returns the same object when nothing changed.
 */
export function normalizeMarkers(sync: SyncState, infoMap: InfoMap): SyncState {
  const inRange = (m: ManualMarker) => m.measure >= 1 && m.measure <= infoMap.measures.length;
  let manual = sync.manual.filter(inRange).map((m) => normalizeOne(infoMap, m));
  const legacy = sync.applied === undefined;
  let applied = legacy ? manual.map((m) => ({ ...m })) : sync.applied!.filter(inRange).map((m) => normalizeOne(infoMap, m));
  const dropped = dedupe(manual);
  manual = manual.filter((m) => !dropped.has(m.id));
  applied = applied.filter((m) => !dropped.has(m.id));
  const droppedApplied = dedupe(applied);
  applied = applied.filter((m) => !droppedApplied.has(m.id));
  if (!legacy && same(manual, sync.manual) && same(applied, sync.applied!)) return sync;
  return { ...sync, manual, applied };
}
