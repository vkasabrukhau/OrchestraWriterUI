import type { InfoMap, MeasureInfo } from "@/shared/info-map";

/**
 * Score navigation from the info map alone (no engraving): landmarks for the
 * overview ruler, the "Go to" field, and note-by-note / bar-by-bar stepping.
 * Times are score seconds; bars are 1-based playback bars.
 */

export interface Landmark {
  /** 1-based playback bar */
  measure: number;
  kind: "rehearsal" | "tempo";
  text: string;
}

/** Rehearsal marks and tempo changes, in playback order. */
export function landmarks(infoMap: InfoMap): Landmark[] {
  const out: Landmark[] = [];
  for (const m of infoMap.measures) if (m.rehearsal) out.push({ measure: m.number, kind: "rehearsal", text: m.rehearsal });
  const tempo = infoMap.timing?.tempo ?? [];
  for (let k = 1; k < tempo.length; k++) {
    if (Math.abs(tempo[k].bpm - tempo[k - 1].bpm) < 0.5) continue;
    out.push({ measure: barAt(infoMap.measures, tempo[k].time), kind: "tempo", text: `♩ = ${Math.round(tempo[k].bpm)}` });
  }
  return out.sort((a, b) => a.measure - b.measure || (a.kind === "rehearsal" ? -1 : 1));
}

/** Playback bar (1-based) whose score-time span holds `t`. */
export function barAt(measures: MeasureInfo[], t: number): number {
  let lo = 0;
  let hi = measures.length - 1;
  if (hi < 0) return 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (measures[mid].startTime <= t + 1e-9) lo = mid;
    else hi = mid - 1;
  }
  return measures[lo].number;
}

export type GoTo =
  | { kind: "bar"; measure: number; /** score seconds of the bar's downbeat */ scoreTime: number }
  | { kind: "time"; /** transport seconds */ sec: number }
  | { kind: "error"; message: string };

/** The playback occurrence of a bar matching `test` nearest to `current` (repeats print a bar twice). */
function nearest(measures: MeasureInfo[], current: number, test: (m: MeasureInfo) => boolean): MeasureInfo | null {
  let best: MeasureInfo | null = null;
  for (const m of measures) {
    if (!test(m)) continue;
    if (!best || Math.abs(m.number - current) < Math.abs(best.number - current)) best = m;
  }
  return best;
}

/**
 * Resolve what someone typed into "Go to": a printed bar number ("42",
 * "12a"), a rehearsal mark ("B", "letter B", "rB", "[B]"), or a time in the
 * recording ("1:23", "83s"). Bar numbers are printed numbers, as engraved.
 */
export function resolveGoTo(query: string, infoMap: InfoMap, current = 1, durationSec = Infinity): GoTo {
  const q = query.trim();
  if (!q) return { kind: "error", message: "Type a bar number, a rehearsal mark or a time." };
  const ms = infoMap.measures;
  const bar = (m: MeasureInfo): GoTo => ({ kind: "bar", measure: m.number, scoreTime: m.startTime });

  const time = /^(?:(\d+):)?(\d{1,2}(?:\.\d+)?)$/.exec(q);
  if (time && time[1] !== undefined) {
    const sec = Number(time[1]) * 60 + Number(time[2]);
    if (sec > durationSec) return { kind: "error", message: `The recording is shorter than ${q}.` };
    return { kind: "time", sec };
  }
  const seconds = /^(\d+(?:\.\d+)?)\s*s(?:ec)?$/i.exec(q);
  if (seconds) {
    const sec = Number(seconds[1]);
    if (sec > durationSec) return { kind: "error", message: `The recording is shorter than ${q}.` };
    return { kind: "time", sec };
  }

  // rehearsal mark, explicitly marked: "letter B", "rehearsal 12", "[B]", "rB", "r12"
  const explicit = /^(?:letter|rehearsal)\s+(.+)$/i.exec(q) ?? /^\[(.+)\]$/.exec(q) ?? /^r(\d+|[a-z])$/i.exec(q);
  const byMark = (text: string) => nearest(ms, current, (m) => m.rehearsal?.trim().toLowerCase() === text.trim().toLowerCase());
  if (explicit) {
    const hit = byMark(explicit[1]);
    return hit ? bar(hit) : { kind: "error", message: `No rehearsal mark "${explicit[1].trim()}" in this score.` };
  }

  // printed bar number (label) first, then the playback number
  const label = q.toLowerCase();
  const printed = nearest(ms, current, (m) => (m.label ?? String(m.number)).toLowerCase() === label);
  if (printed) return bar(printed);
  // a plain rehearsal mark ("B", "Coda")
  const hit = byMark(label);
  if (hit) return bar(hit);
  if (/^\d+$/.test(q)) {
    const n = Number(q);
    const last = ms[ms.length - 1]?.label ?? String(ms.length);
    return { kind: "error", message: `Bar ${n} is not in this score (it ends at bar ${last}).` };
  }
  return { kind: "error", message: `Nothing called "${q}" in this score.` };
}

/** Distinct note onsets (score seconds) of the given parts, sorted; every part when `parts` is omitted. */
export function noteOnsets(infoMap: InfoMap, parts?: Set<string>): number[] {
  const seen = new Set<number>();
  for (const inst of infoMap.instruments) {
    if (parts && parts.size > 0 && !parts.has(inst.id)) continue;
    for (const n of inst.notes) seen.add(Math.round(n.time * 1e4) / 1e4);
  }
  for (const m of infoMap.measures) seen.add(Math.round(m.startTime * 1e4) / 1e4);
  return [...seen].sort((a, b) => a - b);
}

/**
 * The next (dir = 1) or previous (dir = -1) onset from score time `t`. Going
 * back from just after an onset (within `slack`, e.g. while playing) skips it,
 * so repeated presses keep moving.
 */
export function stepOnset(onsets: number[], t: number, dir: 1 | -1, slack = 0.05): number {
  if (onsets.length === 0) return t;
  if (dir > 0) {
    for (const o of onsets) if (o > t + 1e-4) return o;
    return onsets[onsets.length - 1];
  }
  for (let k = onsets.length - 1; k >= 0; k--) if (onsets[k] < t - slack) return onsets[k];
  return onsets[0];
}

/** Downbeat (score seconds) of the bar after or before the one holding `t`. */
export function stepBar(measures: MeasureInfo[], t: number, dir: 1 | -1, slack = 0.05): number {
  if (measures.length === 0) return t;
  const n = barAt(measures, t);
  const m = measures[n - 1];
  if (dir > 0) return measures[Math.min(measures.length - 1, n)].startTime;
  // within the first moments of a bar, go to the previous one
  if (t - m.startTime > slack) return m.startTime;
  return measures[Math.max(0, n - 2)].startTime;
}

/** "Bar 42, beat 3" style position: 1-based beat in quarter-note-length steps of the bar's own beat. */
export function beatIn(m: MeasureInfo, t: number, beatsPerBar: number): number {
  if (!(m.duration > 0) || beatsPerBar <= 0) return 1;
  const frac = Math.max(0, Math.min(0.9999, (t - m.startTime) / m.duration));
  return Math.floor(frac * beatsPerBar) + 1;
}

/** Beats per bar from a "3/4" time signature (fallback 4). */
export function beatsOf(timeSignature: string): number {
  const n = Number(timeSignature.split("/")[0]);
  return Number.isFinite(n) && n > 0 ? n : 4;
}
