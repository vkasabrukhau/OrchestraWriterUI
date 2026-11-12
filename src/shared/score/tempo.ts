/**
 * Tempo map in score time. Positions are in quarter notes from the start of
 * the piece (playback order); tempo is quarter notes per minute, as in
 * MusicXML <sound tempo>.
 */

export const DEFAULT_TEMPO = 120;

export interface TempoEvent {
  /** quarter notes from the start of the piece */
  q: number;
  /** quarter notes per minute */
  bpm: number;
}

export class TempoMap {
  /** sorted breakpoints with the seconds elapsed at each */
  private readonly points: Array<{ q: number; sec: number; bpm: number }>;

  constructor(events: TempoEvent[], defaultBpm = DEFAULT_TEMPO) {
    const sorted = events.filter((e) => e.bpm > 0 && Number.isFinite(e.bpm)).sort((a, b) => a.q - b.q);
    const points: Array<{ q: number; sec: number; bpm: number }> = [{ q: 0, sec: 0, bpm: defaultBpm }];
    for (const e of sorted) {
      const last = points[points.length - 1];
      const q = Math.max(0, e.q);
      if (Math.abs(q - last.q) < 1e-9) {
        last.bpm = e.bpm;
        continue;
      }
      points.push({ q, sec: last.sec + ((q - last.q) * 60) / last.bpm, bpm: e.bpm });
    }
    this.points = points;
  }

  /** score seconds at quarter position q */
  secondsAt(q: number): number {
    const pts = this.points;
    let lo = 0;
    let hi = pts.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (pts[mid].q <= q) lo = mid;
      else hi = mid - 1;
    }
    const p = pts[lo];
    return p.sec + ((q - p.q) * 60) / p.bpm;
  }

  /** breakpoints in playback order: quarter position, score seconds, tempo from there on */
  breakpoints(): Array<{ q: number; sec: number; bpm: number }> {
    return this.points.map((p) => ({ ...p }));
  }

  /** tempo in effect at the start of the piece */
  get initialBpm(): number {
    return this.points[0].bpm;
  }
}

const BEAT_UNIT_QUARTERS: Record<string, number> = {
  long: 16,
  breve: 8,
  whole: 4,
  half: 2,
  quarter: 1,
  eighth: 0.5,
  "16th": 0.25,
  "32nd": 0.125,
  "64th": 0.0625,
};

/** Metronome mark → quarter notes per minute (null for metric modulations or unreadable marks). */
export function metronomeToQuarterBpm(beatUnit: string, dots: number, perMinuteText: string): number | null {
  const unit = BEAT_UNIT_QUARTERS[beatUnit.trim()];
  if (!unit) return null;
  const perMinute = Number(perMinuteText.match(/\d+(?:[.,]\d+)?/)?.[0]?.replace(",", "."));
  if (!Number.isFinite(perMinute) || perMinute <= 0) return null;
  let q = unit;
  let add = unit / 2;
  for (let i = 0; i < dots; i++) {
    q += add;
    add /= 2;
  }
  return perMinute * q;
}
