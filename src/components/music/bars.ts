import type { InfoMap } from "@/shared/info-map";

/**
 * Bar numbers as the user reads them. Measures are numbered in playback order
 * (repeats expanded); `MeasureInfo.label` keeps the printed number when it
 * differs, so the second pass of a repeat reads "41 (33)": playback bar 41,
 * printed bar 33.
 */
export function printedLabel(infoMap: InfoMap | null | undefined, n: number): string | null {
  const label = infoMap?.measures[n - 1]?.label;
  return label && label !== String(n) ? label : null;
}

/** "41 (33)" when the printed number differs, else "41". */
export function barNumber(infoMap: InfoMap | null | undefined, n: number): string {
  const printed = printedLabel(infoMap, n);
  return printed ? `${n} (${printed})` : String(n);
}

/** "bar 41 (33)" / "Bar 41 (33)" */
export function barText(infoMap: InfoMap | null | undefined, n: number, capital = false): string {
  return `${capital ? "Bar" : "bar"} ${barNumber(infoMap, n)}`;
}

/**
 * A note's place as the user reads it: "Bar 41 (33)" on the downbeat,
 * "Bar 41 (33), beat 3" on a beat, "beat 2.5" between beats. `position` is
 * the fraction of the bar; beats come from the score's time signature.
 */
export function spotText(infoMap: InfoMap | null | undefined, n: number, position: number, capital = false): string {
  const base = barText(infoMap, n, capital);
  if (!(position > 1e-6)) return base;
  const beats = Number(infoMap?.timeSignature?.split("/")[0]) || 4;
  const beat = Math.round((1 + position * beats) * 10) / 10;
  return `${base}, beat ${Number.isInteger(beat) ? beat : beat.toFixed(1)}`;
}

/** Live transport readout: "Bar 41 (33) · beat 3 / 502" at a score time. */
export function barBeatText(infoMap: InfoMap, scoreT: number): string {
  const ms = infoMap.measures;
  let lo = 0;
  let hi = ms.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (ms[mid].startTime <= scoreT + 1e-9) lo = mid;
    else hi = mid - 1;
  }
  const m = ms[lo];
  if (!m) return "";
  const beats = Number(infoMap.timeSignature?.split("/")[0]) || 4;
  const frac = m.duration > 0 ? Math.max(0, Math.min(0.9999, (scoreT - m.startTime) / m.duration)) : 0;
  return `Bar ${barNumber(infoMap, m.number)} · beat ${Math.floor(frac * beats) + 1} / ${ms.length}`;
}
