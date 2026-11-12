import type { InfoMap } from "./info-map";

/**
 * Score ↔ audio alignment. The aligner works per measure; manual markers can
 * pin any note onset inside a measure. Two clocks exist: score time (from the
 * info map) and recording time (the MP3). Name variables by which.
 */

/** A note onset inside a measure pinned to the recording (from a manual marker). */
export interface AlignmentPoint {
  /** fraction of the measure in score time, 0 < pos < 1 */
  pos: number;
  /** seconds in the recording */
  sec: number;
}

export interface MeasureAlignment {
  /** 1-based measure number */
  n: number;
  /** seconds in the recording */
  startSec: number;
  /** 0–100 */
  confidence: number;
  /** note-level anchors inside the measure, by `pos` (merged alignment only) */
  points?: AlignmentPoint[];
}

export interface ManualMarker {
  id: string;
  measure: number;
  /**
   * where in the measure the marker sits: the fraction of the measure in
   * score time of the note it pins (0 or absent = the downbeat)
   */
  position?: number;
  /** seconds in the recording */
  startSec: number;
  createdAt: string;
  /** the user's name for it ("Horn entry"); absent = derived ("Bar 12, beat 3") */
  label?: string;
  /**
   * "time": `position` is a fraction of the bar in score seconds. Absent: a
   * legacy value (an OSMD musical fraction or a seconds fraction) that
   * normalizeMarkers converts once.
   */
  basis?: "time";
}

/** Longest marker label, in code points. */
export const MARKER_LABEL_MAX = 80;

/** A trimmed label of at most MARKER_LABEL_MAX code points, or undefined when empty or not a string. */
export function normalizeMarkerLabel(v: unknown): string | undefined {
  if (typeof v !== "string") return undefined;
  const t = v.replace(/\s+/g, " ").trim();
  if (!t) return undefined;
  const cps = Array.from(t);
  return cps.length > MARKER_LABEL_MAX ? cps.slice(0, MARKER_LABEL_MAX).join("").trimEnd() : t;
}

/** Positions closer than this are the same note. */
const POS_EPS = 1e-6;

/** The marker's position in its measure, 0 when it pins the downbeat. */
export function markerPosition(m: Pick<ManualMarker, "position">): number {
  const p = m.position ?? 0;
  return Number.isFinite(p) ? Math.max(0, Math.min(1 - POS_EPS, p)) : 0;
}

/** Same measure and same note. */
export function sameMarkerSpot(a: Pick<ManualMarker, "measure" | "position">, measure: number, position = 0): boolean {
  return a.measure === measure && Math.abs(markerPosition(a) - position) < POS_EPS;
}

/** What the aligner reports about its own run (internal agreement, not accuracy). */
export interface AlignmentDiagnostics {
  /** the joint tempo fit was accepted (false = the broad match was kept) */
  accepted: boolean;
  /** every optimizer stage met a tolerance before its evaluation limit */
  converged: boolean;
  /** mean joint cost of the broad 2 Hz match */
  broadCost: number;
  /** next distinct occurrence's cost minus the best one's; null when there was none */
  broadMargin: number | null;
  /** mean raw joint cost along the broad match and along the result */
  acousticBefore: number;
  acousticAfter: number;
  /** largest movement of the result away from the broad match, seconds */
  maxShiftSec: number;
  knots: number;
  tuningCents: number;
  note?: string;
}

export interface SyncState {
  /** what the last whole-piece run used */
  method: string;
  /** per bar: start and confidence from the last run covering it */
  auto: MeasureAlignment[];
  /** markers as the user sees and edits them */
  manual: ManualMarker[];
  /**
   * markers in effect for timing: applied by the last recompute that covered
   * them (ADR 0018). Absent = legacy data, where every marker was audible, so
   * it equals `manual`.
   */
  applied?: ManualMarker[];
  /** average confidence 0–100 over all measures, from the auto pass */
  averageConfidence: number;
  /** only from a whole-piece run */
  diagnostics?: AlignmentDiagnostics;
}

/** The markers timing uses. */
export function appliedOf(sync: Pick<SyncState, "manual" | "applied">): ManualMarker[] {
  return sync.applied ?? sync.manual;
}

/** A marker change that a recompute has not applied yet. */
export interface PendingItem {
  id: string;
  kind: "new" | "moved" | "deleted";
  /** the bars it touches: its edited bar and its applied bar */
  bars: number[];
  /** the marker as edited (absent when deleted) */
  intended?: ManualMarker;
  /** the marker as applied (absent when new) */
  applied?: ManualMarker;
}

function sameTiming(a: ManualMarker, b: ManualMarker): boolean {
  return a.measure === b.measure && Math.abs(markerPosition(a) - markerPosition(b)) < POS_EPS && Math.abs(a.startSec - b.startSec) < 1e-9;
}

/** Markers whose edited version differs in timing from the applied one, by id. A label change is not pending. */
export function pendingOf(manual: ManualMarker[], applied: ManualMarker[]): PendingItem[] {
  const out: PendingItem[] = [];
  const byId = new Map(applied.map((m) => [m.id, m]));
  const seen = new Set<string>();
  for (const m of manual) {
    seen.add(m.id);
    const a = byId.get(m.id);
    if (!a) out.push({ id: m.id, kind: "new", bars: [m.measure], intended: m });
    else if (!sameTiming(m, a)) out.push({ id: m.id, kind: "moved", bars: m.measure === a.measure ? [m.measure] : [m.measure, a.measure], intended: m, applied: a });
  }
  for (const a of applied) if (!seen.has(a.id)) out.push({ id: a.id, kind: "deleted", bars: [a.measure], applied: a });
  return out;
}

/** Bars holding a pending item. */
export function pendingBars(items: PendingItem[]): Set<number> {
  const bars = new Set<number>();
  for (const it of items) for (const b of it.bars) bars.add(b);
  return bars;
}

/**
 * The applied set after a recompute over `range` (null = the whole piece):
 * pending items whose bars all lie inside the range take their edited form
 * (or leave, when deleted); everything else keeps its applied form.
 */
export function resolveRange(manual: ManualMarker[], applied: ManualMarker[], range: { from: number; to: number } | null): ManualMarker[] {
  if (!range) return manual.map((m) => ({ ...m }));
  const inside = (bars: number[]) => bars.every((b) => b >= range.from && b <= range.to);
  const next = new Map(applied.map((m) => [m.id, m]));
  const items = pendingOf(manual, applied);
  const resolving = new Set(items.filter((it) => inside(it.bars)).map((it) => it.id));
  for (const it of items) {
    if (!resolving.has(it.id)) continue;
    if (it.kind === "deleted") next.delete(it.id);
    else {
      const t = it.intended!;
      // never two applied markers on one note: wait while another, unresolved one still holds it
      const held = [...next.values()].some((o) => o.id !== it.id && !resolving.has(o.id) && sameMarkerSpot(o, t.measure, markerPosition(t)));
      if (!held) next.set(it.id, { ...t });
    }
  }
  // keep a stable order: by bar, then position
  return [...next.values()].sort((a, b) => a.measure - b.measure || markerPosition(a) - markerPosition(b));
}

export type ConfidenceBandId = "high" | "mid" | "low";

export interface ConfidenceBand {
  id: ConfidenceBandId;
  /** inclusive lower bound */
  min: number;
  label: string;
  description: string;
  token: string;
}

/** Band edges live here only; the legend and the "Next uncertain" button read from this. */
export const CONFIDENCE_BANDS: ConfidenceBand[] = [
  { id: "high", min: 90, label: "Confident", description: "90–100%", token: "var(--conf-high)" },
  { id: "mid", min: 60, label: "Check", description: "60–89%", token: "var(--conf-mid)" },
  { id: "low", min: 0, label: "Uncertain", description: "below 60%", token: "var(--conf-low)" },
];

export const UNCERTAIN_THRESHOLD = 90;

export function confidenceBand(confidence: number): ConfidenceBand {
  for (const band of CONFIDENCE_BANDS) {
    if (confidence >= band.min) return band;
  }
  return CONFIDENCE_BANDS[CONFIDENCE_BANDS.length - 1];
}

/** Smallest gap between consecutive measure starts or anchors after a merge, seconds. */
export const MIN_ALIGNMENT_GAP = 0.01;

/** Span of measure i in the recording (the last one borrows its predecessor's). */
function spanOf(list: Array<{ startSec: number }>, i: number): number {
  const next = list[i + 1];
  if (next) return next.startSec - list[i].startSec;
  const prev = list[i - 1];
  return prev ? list[i].startSec - prev.startSec : 1;
}

/**
 * Merge markers over the automatic alignment. Markers win; the result stays
 * monotonic. A marker pins a note onset (`position` in its measure) to a
 * recording time; everything between two markers is re-timed proportionally
 * (in the automatic alignment's time), so one correction fixes its
 * neighborhood. Markers inside a measure become that measure's `points`.
 * Confidence is always the aligner's: markers never change it (ADR 0018).
 *
 * Final pass: anchors stay where they were put when there is room for the
 * knots between them (MIN_ALIGNMENT_GAP each); an anchor without room is
 * pushed later, as before, and listed in `unhonoured`. Other knots are
 * clamped between their anchors.
 */
export function mergeAlignmentDetailed(
  auto: MeasureAlignment[],
  manual: ManualMarker[],
): { aligned: MeasureAlignment[]; finals: Map<string, number>; unhonoured: string[] } {
  const finals = new Map<string, number>();
  if (manual.length === 0 || auto.length === 0) return { aligned: auto, finals, unhonoured: [] };
  const indexOf = new Map(auto.map((a, i) => [a.n, i]));

  // anchors in auto time → recording time, one per note (the last edit wins)
  const byKey = new Map<string, { i: number; pos: number; autoSec: number; sec: number; ids: string[] }>();
  for (const m of manual) {
    const i = indexOf.get(m.measure);
    if (i === undefined || !Number.isFinite(m.startSec)) continue;
    const pos = markerPosition(m);
    const key = `${i}:${pos.toFixed(6)}`;
    const autoSec = auto[i].startSec + pos * spanOf(auto, i);
    const ids = byKey.get(key)?.ids ?? [];
    ids.push(m.id);
    byKey.set(key, { i, pos, autoSec, sec: m.startSec, ids });
  }
  const anchors = [...byKey.values()].sort((a, b) => a.i - b.i || a.pos - b.pos);
  if (anchors.length === 0) return { aligned: auto, finals, unhonoured: [] };

  /** merged recording time of an auto time: piecewise linear through the anchors */
  const map = (x: number): number => {
    const first = anchors[0];
    if (x <= first.autoSec) return x + (first.sec - first.autoSec);
    for (let k = 0; k + 1 < anchors.length; k++) {
      const a = anchors[k];
      const b = anchors[k + 1];
      if (x <= b.autoSec) {
        const span = b.autoSec - a.autoSec;
        return span > 0 ? a.sec + ((x - a.autoSec) / span) * (b.sec - a.sec) : b.sec;
      }
    }
    const last = anchors[anchors.length - 1];
    return x + (last.sec - last.autoSec);
  };

  const result: MeasureAlignment[] = auto.map((a) => ({ n: a.n, startSec: map(a.startSec), confidence: a.confidence }));
  // knots in order: each measure start, then its points; anchors know their ids
  const anchorAt = new Map<string, (typeof anchors)[number]>();
  for (const a of anchors) {
    const r = result[a.i];
    if (a.pos < POS_EPS) {
      r.startSec = a.sec;
      anchorAt.set(`${a.i}:s`, a);
    } else {
      (r.points ??= []).push({ pos: a.pos, sec: a.sec });
      anchorAt.set(`${a.i}:${a.pos.toFixed(6)}`, a);
    }
  }
  type Knot = { get: () => number; set: (v: number) => void; anchor?: (typeof anchors)[number] };
  const knots: Knot[] = [];
  result.forEach((r, i) => {
    knots.push({ get: () => r.startSec, set: (v) => (r.startSec = v), anchor: anchorAt.get(`${i}:s`) });
    for (const p of r.points ?? []) knots.push({ get: () => p.sec, set: (v) => (p.sec = v), anchor: anchorAt.get(`${i}:${p.pos.toFixed(6)}`) });
  });

  // 1. anchors, forward: room for the knots between them, or pushed (old behavior)
  const unhonoured: string[] = [];
  let lastIdx = -1;
  let lastFinal = -MIN_ALIGNMENT_GAP; // a virtual anchor just before 0
  knots.forEach((k, idx) => {
    if (!k.anchor) return;
    const need = lastFinal + MIN_ALIGNMENT_GAP * (idx - lastIdx);
    const final = Math.max(k.get(), need);
    if (final > k.get() + 1e-9) unhonoured.push(...k.anchor.ids);
    k.set(final);
    for (const id of k.anchor.ids) finals.set(id, final);
    lastIdx = idx;
    lastFinal = final;
  });
  // 2. other knots: after the previous knot, leaving room before the next anchor
  let floor = -Infinity;
  let nextAnchor = 0;
  knots.forEach((k, idx) => {
    if (k.anchor) {
      floor = k.get();
      return;
    }
    while (nextAnchor < knots.length && (nextAnchor <= idx || !knots[nextAnchor].anchor)) nextAnchor++;
    const cap = nextAnchor < knots.length ? knots[nextAnchor].get() - MIN_ALIGNMENT_GAP * (nextAnchor - idx) : Infinity;
    const lo = Math.max(0, floor + MIN_ALIGNMENT_GAP);
    const v = Math.max(lo, Math.min(k.get(), cap));
    k.set(v);
    floor = v;
  });
  return { aligned: result, finals, unhonoured };
}

/** The merged alignment (see mergeAlignmentDetailed). */
export function mergeAlignment(auto: MeasureAlignment[], manual: ManualMarker[]): MeasureAlignment[] {
  return mergeAlignmentDetailed(auto, manual).aligned;
}

/**
 * Recording times a marker at (measure, position) may take so that, once
 * applied, it lands exactly there: after the previous anchor's final time plus
 * room for the knots between, and before the next one's (ADR 0018). Checked
 * against the given marker set (the edited set), without the marker itself.
 */
export function markerBounds(
  auto: MeasureAlignment[],
  manual: ManualMarker[],
  spot: { measure: number; position?: number },
  opts: { excludeId?: string; durationSec: number },
): { low: number; high: number } {
  const position = markerPosition(spot);
  const others = manual.filter((m) => m.id !== opts.excludeId && !sameMarkerSpot(m, spot.measure, position));
  const { aligned, finals } = mergeAlignmentDetailed(auto, others);
  const anchorSec = new Set<string>();
  for (const m of others) {
    const f = finals.get(m.id);
    if (f !== undefined) anchorSec.add(`${m.measure}:${markerPosition(m).toFixed(6)}`);
  }
  // knots in order, flagged by whether they are anchors and whether they come before the spot
  let low = 0;
  let between = 0;
  let high = opts.durationSec;
  let after = 0;
  let foundNext = false;
  const flat: Array<{ n: number; pos: number; sec: number; anchor: boolean }> = [];
  for (const a of aligned) {
    flat.push({ n: a.n, pos: 0, sec: a.startSec, anchor: anchorSec.has(`${a.n}:${(0).toFixed(6)}`) });
    for (const p of a.points ?? []) flat.push({ n: a.n, pos: p.pos, sec: p.sec, anchor: anchorSec.has(`${a.n}:${p.pos.toFixed(6)}`) });
  }
  const isBefore = (k: { n: number; pos: number }) => k.n < spot.measure || (k.n === spot.measure && k.pos < position - POS_EPS);
  let prevFinal: number | null = null;
  for (const k of flat) {
    if (isBefore(k)) {
      if (k.anchor) {
        prevFinal = k.sec;
        between = 0;
      } else between++;
    } else if (k.n === spot.measure && Math.abs(k.pos - position) < POS_EPS) {
      continue; // the spot's own downbeat knot (not an anchor here): the marker replaces it
    } else if (k.anchor) {
      high = k.sec - MIN_ALIGNMENT_GAP * (after + 1);
      foundNext = true;
      break;
    } else after++;
  }
  low = prevFinal === null ? MIN_ALIGNMENT_GAP * between : prevFinal + MIN_ALIGNMENT_GAP * (between + 1);
  if (!foundNext) high = opts.durationSec - MIN_ALIGNMENT_GAP * after;
  return { low: Math.max(0, low), high };
}

/** Map a recording time to a measure number using the merged alignment. */
export function measureAtRecordingTime(aligned: MeasureAlignment[], t: number): number {
  if (aligned.length === 0) return 1;
  let lo = 0;
  let hi = aligned.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (aligned[mid].startSec <= t) lo = mid;
    else hi = mid - 1;
  }
  return aligned[lo].n;
}

/* ------------------------------------------------------------------ */
/* Alignment contract (see .claude/skills/score-audio-alignment)        */
/* ------------------------------------------------------------------ */

/** Mono PCM of the recording, as decoded by the browser. */
export interface AlignAudio {
  sampleRate: number;
  samples: Float32Array;
  durationSec: number;
}

export type AlignProgress = (progress: number, message: string) => void;

/**
 * align(infoMap, audio) -> { measures: [{ n, startSec, confidence }], method }.
 * Implementations live in src/lib/align/. Applied markers reach the aligners
 * as fixed anchors through runSync (ADR 0021); mergeAlignment() still pins
 * timing to them afterwards and keeps it monotonic.
 */
export interface Aligner {
  readonly method: string;
  align(infoMap: import("./info-map").InfoMap, audio: AlignAudio, onProgress?: AlignProgress, signal?: AbortSignal): Promise<SyncState>;
}

/* ------------------------------------------------------------------ */
/* Clock conversion (recording time ↔ score time)                      */
/* ------------------------------------------------------------------ */

/**
 * Recording-time knots of measure i: the downbeat, its note-level points and
 * the next downbeat.
 */
function knotsOf(infoMap: InfoMap, aligned: MeasureAlignment[], i: number): Array<{ pos: number; sec: number }> {
  const a = aligned[i];
  const next = aligned[i + 1];
  const knots = [{ pos: 0, sec: a.startSec }, ...(a.points ?? [])];
  // the last measure runs for its score length, as before note-level points
  const end = next ? next.startSec : a.startSec + (infoMap.measures[i]?.duration ?? 1);
  const last = knots[knots.length - 1];
  knots.push({ pos: 1, sec: Math.max(end, last.sec + 1e-3) });
  return knots;
}

export function recordingToScoreTime(infoMap: InfoMap, aligned: MeasureAlignment[], t: number): number {
  if (aligned.length === 0) return t;
  const n = measureAtRecordingTime(aligned, t);
  const i = n - 1;
  const m = infoMap.measures[i];
  if (!aligned[i] || !m) return t;
  const knots = knotsOf(infoMap, aligned, i);
  let frac: number;
  if (t <= knots[0].sec) frac = 0;
  else {
    let k = 0;
    while (k + 2 < knots.length && knots[k + 1].sec <= t) k++;
    const a = knots[k];
    const b = knots[k + 1];
    const span = b.sec - a.sec;
    // past the end of the last measure: keep the last segment's speed (capped)
    frac = span > 0 ? a.pos + ((t - a.sec) / span) * (b.pos - a.pos) : b.pos;
  }
  return m.startTime + Math.max(0, Math.min(1.2, frac)) * m.duration;
}

export function scoreToRecordingTime(infoMap: InfoMap, aligned: MeasureAlignment[], scoreT: number): number {
  if (aligned.length === 0) return scoreT;
  const ms = infoMap.measures;
  let lo = 0;
  let hi = ms.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (ms[mid].startTime <= scoreT) lo = mid;
    else hi = mid - 1;
  }
  const m = ms[lo];
  if (!aligned[lo] || !m) return scoreT;
  const frac = m.duration > 0 ? (scoreT - m.startTime) / m.duration : 0;
  const knots = knotsOf(infoMap, aligned, lo);
  if (frac <= 0) return knots[0].sec + frac * (knots[knots.length - 1].sec - knots[0].sec);
  let k = 0;
  while (k + 2 < knots.length && knots[k + 1].pos <= frac) k++;
  const a = knots[k];
  const b = knots[k + 1];
  const w = b.pos > a.pos ? (frac - a.pos) / (b.pos - a.pos) : 0;
  return a.sec + w * (b.sec - a.sec);
}

/* ------------------------------------------------------------------ */
/* Validation (server, mock and project files share one validator)     */
/* ------------------------------------------------------------------ */

export const MAX_SYNC_MEASURES = 20_000;

export class SyncShapeError extends Error {}

const DIAGNOSTIC_KEYS = ["accepted", "converged", "broadCost", "broadMargin", "acousticBefore", "acousticAfter", "maxShiftSec", "knots", "tuningCents", "note"] as const;

/**
 * Check a SyncState and keep only known keys. "strict" throws SyncShapeError on
 * the first bad value (API writes); "lenient" drops bad entries and counts them
 * (project files). Marker ids must be unique within each list: strict rejects
 * a duplicate, lenient gives the later one a fresh id. Validation only: no
 * position conversion (that is normalizeMarkers, with a freshly parsed score).
 */
export function parseSyncState(v: unknown, mode: "strict" | "lenient"): { sync: SyncState; dropped: number } {
  let dropped = 0;
  const bad = (msg: string): null => {
    if (mode === "strict") throw new SyncShapeError(msg);
    dropped++;
    return null;
  };
  const isObj = (x: unknown): x is Record<string, unknown> => typeof x === "object" && x !== null && !Array.isArray(x);
  const finite = (x: unknown): x is number => typeof x === "number" && Number.isFinite(x);
  if (!isObj(v)) throw new SyncShapeError("sync must be an object");
  if (!Array.isArray(v.auto) || !Array.isArray(v.manual)) throw new SyncShapeError("sync.auto and sync.manual must be arrays");
  if (v.applied !== undefined && !Array.isArray(v.applied)) throw new SyncShapeError("sync.applied must be an array");
  for (const key of ["auto", "manual", "applied"] as const) {
    const list = v[key];
    if (Array.isArray(list) && list.length > MAX_SYNC_MEASURES) throw new SyncShapeError(`${key} must hold at most ${MAX_SYNC_MEASURES} entries`);
  }

  const auto: MeasureAlignment[] = [];
  v.auto.forEach((a: unknown, i) => {
    if (!isObj(a) || !finite(a.n) || a.n < 1 || !finite(a.startSec) || a.startSec < 0 || !finite(a.confidence)) return bad(`auto[${i}] is invalid`);
    auto.push({ n: a.n, startSec: a.startSec, confidence: Math.max(0, Math.min(100, a.confidence)) });
  });

  const markers = (list: unknown[], key: string): ManualMarker[] => {
    const out: ManualMarker[] = [];
    const ids = new Set<string>();
    list.forEach((m: unknown, i) => {
      const where = `${key}[${i}]`;
      if (!isObj(m)) return bad(`${where} must be an object`);
      if (typeof m.id !== "string" || m.id.length < 1 || m.id.length > 100) return bad(`${where}.id must be 1–100 characters`);
      if (!finite(m.measure) || m.measure < 1 || m.measure > MAX_SYNC_MEASURES || !Number.isInteger(m.measure)) return bad(`${where}.measure is invalid`);
      if (m.position !== undefined && (!finite(m.position) || m.position < 0 || m.position > 1)) return bad(`${where}.position must be in [0, 1]`);
      if (!finite(m.startSec) || m.startSec < 0) return bad(`${where}.startSec is invalid`);
      if (m.label !== undefined && (typeof m.label !== "string" || Array.from(m.label).length > MARKER_LABEL_MAX)) {
        if (mode === "strict") throw new SyncShapeError(`${where}.label must be at most ${MARKER_LABEL_MAX} characters`);
      }
      if (m.basis !== undefined && m.basis !== "time") return bad(`${where}.basis is invalid`);
      let id = m.id;
      if (ids.has(id)) {
        if (mode === "strict") throw new SyncShapeError(`${where}.id is a duplicate`);
        dropped++;
        let k = 2;
        while (ids.has(`${m.id}-${k}`)) k++;
        id = `${m.id}-${k}`;
      }
      ids.add(id);
      const marker: ManualMarker = { id, measure: m.measure, startSec: m.startSec, createdAt: typeof m.createdAt === "string" ? m.createdAt : new Date(0).toISOString() };
      if (m.position !== undefined) marker.position = m.position as number;
      const label = normalizeMarkerLabel(m.label);
      if (label) marker.label = label;
      if (m.basis === "time") marker.basis = "time";
      out.push(marker);
    });
    return out;
  };

  const sync: SyncState = {
    method: typeof v.method === "string" ? v.method.slice(0, 100) : "unknown",
    auto,
    manual: markers(v.manual, "manual"),
    averageConfidence: finite(v.averageConfidence) ? Math.max(0, Math.min(100, v.averageConfidence)) : 0,
  };
  if (Array.isArray(v.applied)) sync.applied = markers(v.applied, "applied");
  if (isObj(v.diagnostics)) {
    const d: Record<string, unknown> = {};
    for (const k of DIAGNOSTIC_KEYS) if (v.diagnostics[k] !== undefined) d[k] = v.diagnostics[k];
    sync.diagnostics = d as unknown as AlignmentDiagnostics;
  }
  return { sync, dropped };
}
