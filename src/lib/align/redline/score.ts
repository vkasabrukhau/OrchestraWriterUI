/**
 * What redline/score.py hands the rest of the library, built from the info
 * map instead of re-reading MusicXML (the app parses once, at import):
 *
 * - notes: sounding pitch (written + <transpose>), position, ties merged,
 *   a loudness weight;
 * - bars: where each bar starts;
 * - the nominal time axis.
 *
 * Differences forced by the source, all kept as close to the reference as
 * the info map allows:
 * - Positions are score seconds at the written tempo, not quarter notes. The
 *   reference only uses quarters through `quarters_to_nominal`, so the
 *   nominal axis is the same; repeats are expanded here (the reference does
 *   not expand them).
 * - The reference reads the weight from <sound dynamics> (MuseScore writes
 *   one with every dynamic: pp 36.67 … fff 140). The info map keeps the
 *   written dynamic, so it is mapped back to those values; clamped to
 *   0.25–1.6 as in the reference.
 * - The reference skips grace notes (no duration here), cue notes (already
 *   skipped by the parser) and unpitched percussion. The parser stores
 *   unpitched notes as MIDI 60, so a percussion part whose every note is 60
 *   is treated as unpitched.
 */
import type { Dynamic } from "@/shared/dynamics";
import type { InfoMap } from "@/shared/info-map";
import { soundingTranspose } from "@/shared/score/transpose";

export interface RedlineNote {
  /** score seconds */
  onset: number;
  /** score seconds, ties merged */
  duration: number;
  /** sounding MIDI pitch */
  pitch: number;
  /** loudness weight (1.0 ≈ forte) */
  weight: number;
}

export interface RedlineScore {
  notes: RedlineNote[];
  /** bar starts, score seconds */
  barStarts: number[];
  /** end of the last bar, score seconds */
  total: number;
}

/** MuseScore's MusicXML <sound dynamics> per written dynamic (velocity / 90 × 100). */
const SOUND_DYNAMICS: Record<Dynamic, number> = {
  pp: 36.67,
  p: 54.44,
  mp: 71.11,
  mf: 88.89,
  f: 106.67,
  ff: 124.44,
  fff: 140.0,
};

function weightOf(d: Dynamic): number {
  return Math.min(1.6, Math.max(0.25, SOUND_DYNAMICS[d] / 100.0));
}

function looksUnpitched(inst: InfoMap["instruments"][number]): boolean {
  return inst.section === "Percussion" && inst.notes.length > 0 && inst.notes.every((n) => n.pitch === 60);
}

export function redlineScore(infoMap: InfoMap): RedlineScore {
  const raw: Array<RedlineNote & { part: number; seq: number }> = [];
  let seq = 0;
  infoMap.instruments.forEach((inst, part) => {
    if (looksUnpitched(inst)) return;
    const transpose = soundingTranspose(inst);
    for (const n of inst.notes) {
      if (!(n.duration > 0)) continue; // grace notes
      raw.push({
        onset: n.time,
        duration: n.duration,
        pitch: n.pitch + transpose,
        weight: weightOf(n.dynamics),
        part,
        seq: seq++,
      });
    }
  });
  // the reference sorts by (onset, part), stable
  raw.sort((a, b) => a.onset - b.onset || a.part - b.part || a.seq - b.seq);
  const last = infoMap.measures[infoMap.measures.length - 1];
  return {
    notes: raw.map(({ onset, duration, pitch, weight }) => ({
      onset,
      duration,
      pitch,
      weight,
    })),
    barStarts: infoMap.measures.map((m) => m.startTime),
    total: last ? last.startTime + last.duration : infoMap.duration,
  };
}
