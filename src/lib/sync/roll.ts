import type { InfoMap } from "@/shared/info-map";
import type { DisplaySettings } from "@/shared/project-file";
import type { Section } from "@/shared/sections";
import { scoreToRecordingTime, type MeasureAlignment } from "@/shared/sync";
import { soundingTranspose } from "@/shared/score/transpose";
import { barOnsets } from "@/lib/score/stamps";

/**
 * The piano roll's model (ADR 0020): every note as a bar at its sounding
 * pitch, placed on the recording's clock through the audible timing, and
 * every distinct onset as a handle that can be dragged to where it really
 * sounds. Pure; the component draws it on a canvas.
 */
export interface RollNote {
  /** recording seconds */
  start: number;
  end: number;
  /** sounding MIDI pitch */
  pitch: number;
  part: number;
  section: Section;
  measure: number;
}

export interface RollOnset {
  measure: number;
  /** time fraction of the bar (marker position) */
  position: number;
  /** recording seconds where it plays now */
  at: number;
}

export interface RollIndex {
  /** sorted by start */
  notes: RollNote[];
  /** longest note, for window queries that start before the window */
  maxDur: number;
  minPitch: number;
  maxPitch: number;
  onsets: RollOnset[];
  /** part id → index into notes[].part */
  parts: string[];
}

export function sectionOf(display: DisplaySettings | null, id: string, fallback: Section): Section {
  return display?.sections?.[id] ?? fallback;
}

/** Colors per section from the display settings, so the roll matches Customize. */
export function sectionColorsFor(display: DisplaySettings | null): Record<string, string> {
  return { ...(display?.sectionColors ?? {}) };
}

export function buildRollIndex(infoMap: InfoMap, aligned: MeasureAlignment[], display: DisplaySettings | null): RollIndex {
  const toRec = (t: number) => (aligned.length ? scoreToRecordingTime(infoMap, aligned, t) : t);
  const notes: RollNote[] = [];
  let minPitch = 127;
  let maxPitch = 0;
  let maxDur = 0;
  const parts = infoMap.instruments.map((i) => i.id);
  infoMap.instruments.forEach((inst, part) => {
    const shift = soundingTranspose(inst);
    const section = sectionOf(display, inst.id, inst.section);
    for (const n of inst.notes) {
      const start = toRec(n.time);
      const end = Math.max(start + 0.02, toRec(n.time + n.duration));
      const pitch = n.pitch + shift;
      notes.push({ start, end, pitch, part, section, measure: n.measure });
      if (pitch < minPitch) minPitch = pitch;
      if (pitch > maxPitch) maxPitch = pitch;
      if (end - start > maxDur) maxDur = end - start;
    }
  });
  notes.sort((a, b) => a.start - b.start);
  const onsets: RollOnset[] = [];
  infoMap.measures.forEach((m) => {
    for (const f of barOnsets(infoMap, m.number)) onsets.push({ measure: m.number, position: f, at: toRec(m.startTime + f * m.duration) });
  });
  onsets.sort((a, b) => a.at - b.at);
  if (minPitch > maxPitch) {
    minPitch = 48;
    maxPitch = 84;
  }
  return { notes, maxDur, minPitch, maxPitch, onsets, parts };
}

/** First index whose value is ≥ x in a sorted list. */
function lowerBound<T>(list: T[], x: number, key: (v: T) => number): number {
  let lo = 0;
  let hi = list.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (key(list[mid]) < x) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/** Notes sounding in [t0, t1], including those that started before t0. */
export function queryWindow(index: RollIndex, t0: number, t1: number): RollNote[] {
  const from = lowerBound(index.notes, t0 - index.maxDur, (n) => n.start);
  const out: RollNote[] = [];
  for (let i = from; i < index.notes.length; i++) {
    const n = index.notes[i];
    if (n.start > t1) break;
    if (n.end >= t0) out.push(n);
  }
  return out;
}

/** Onsets in [t0, t1]. */
export function onsetsInWindow(index: RollIndex, t0: number, t1: number): RollOnset[] {
  const from = lowerBound(index.onsets, t0, (o) => o.at);
  const out: RollOnset[] = [];
  for (let i = from; i < index.onsets.length && index.onsets[i].at <= t1; i++) out.push(index.onsets[i]);
  return out;
}

/** The onset nearest to recording time t (for keyboard stepping and selection). */
export function nearestOnset(index: RollIndex, t: number): RollOnset | null {
  if (index.onsets.length === 0) return null;
  const i = lowerBound(index.onsets, t, (o) => o.at);
  const a = index.onsets[Math.max(0, i - 1)];
  const b = index.onsets[Math.min(index.onsets.length - 1, i)];
  return Math.abs(a.at - t) <= Math.abs(b.at - t) ? a : b;
}

/** Note names for the pitch gutter: every C, plus E and A when there is room. */
export function pitchTicks(minPitch: number, maxPitch: number, pxPerSemitone: number): Array<{ pitch: number; label: string; hz: number }> {
  const names = ["C", "C♯", "D", "E♭", "E", "F", "F♯", "G", "A♭", "A", "B♭", "B"];
  const out: Array<{ pitch: number; label: string; hz: number }> = [];
  for (let p = Math.ceil(minPitch); p <= maxPitch; p++) {
    const pc = ((p % 12) + 12) % 12;
    if (pc === 0 || (pxPerSemitone >= 6 && (pc === 4 || pc === 9))) out.push({ pitch: p, label: `${names[pc]}${Math.floor(p / 12) - 1}`, hz: 440 * 2 ** ((p - 69) / 12) });
  }
  return out;
}

/** Zoom around an anchor time, keeping the anchor's screen position. */
export function zoomAt(view: { t0: number; t1: number }, anchor: number, factor: number, limits: { min: number; max: number }): { t0: number; t1: number } {
  const span = Math.max(limits.min, Math.min(limits.max, (view.t1 - view.t0) * factor));
  const f = (anchor - view.t0) / Math.max(1e-9, view.t1 - view.t0);
  const t0 = anchor - f * span;
  return { t0, t1: t0 + span };
}
