/**
 * Per-measure confidence for the integrated aligner. This is an explicitly
 * heuristic review score, not a calibrated probability: the guide (section
 * 14) warns that the method itself has no per-measure confidence and that a
 * percentage must eventually be checked against hand-marked timings.
 *
 * It combines the questions the guide lists:
 * - Is the start boundary supported? Joint cost along the fitted clock around
 *   the measure start versus the same score frames 0.3–2 s off the clock.
 * - Is there evidence at all? Bars where the score has no pitched material
 *   (rests, general pauses) have nothing to match.
 * - Did the joint fit move it far from the broad match, or near the ±4 s
 *   corridor edge?
 * - Do the two measures around the boundary disagree on tempo (a misplaced
 *   boundary stretches one and squeezes the other)?
 * - Was the fit accepted? A fallback to the broad match is capped at "Check".
 */
import type { MeasureInfo } from "@/shared/info-map";
import { pairCost, type CueSide, type ScoreCueSide } from "./cost";
import { CORRIDOR_RADIUS_SEC } from "./optimize";
import { interp } from "./signal";

export const INTEGRATED_CONFIDENCE_TUNING = {
  /** distinctiveness (1 − path cost / off-clock cost) at which confidence starts above 0 */
  distinctLow: 0.05,
  /** distinctiveness that maps to 100 */
  distinctHigh: 0.3,
  /** off-clock offsets compared with the clock (recording seconds) */
  offsetMinSec: 0.3,
  offsetMaxSec: 2,
  /** bars whose frames carry pitched material less than this fraction of the time count as rests */
  restHarmony: 0.2,
  restFactor: 0.45,
  /** movement from the broad match tolerated before penalizing (seconds) */
  shiftSlackSec: 0.5,
  /** relative tempo difference across a boundary tolerated before penalizing */
  tempoSlack: 0.12,
  tempoSpan: 0.4,
  /** confidence cap when the joint fit fell back to the broad match */
  fallbackCap: 89,
};

export interface ConfidenceInput {
  score: ScoreCueSide;
  audio: CueSide;
  rate: number;
  measures: MeasureInfo[];
  /** fitted clock (score seconds → recording seconds) */
  mapping: { score: number[]; recording: number[] };
  /** broad match clock */
  seed: { score: number[]; recording: number[] };
  /** recording seconds of each measure start (finalized) */
  startsSec: number[];
  accepted: boolean;
}

export function integratedConfidences(input: ConfidenceInput): number[] {
  const T = INTEGRATED_CONFIDENCE_TUNING;
  const { score, audio, rate, measures, mapping, seed, startsSec } = input;
  const covered = [mapping.score[0], mapping.score[mapping.score.length - 1]];
  const at = (s: number) => Math.round(interp(s, mapping.score, mapping.recording) * rate);
  const offsets: number[] = [];
  for (let d = Math.round(T.offsetMinSec * rate); d <= Math.round(T.offsetMaxSec * rate); d += Math.max(1, Math.round(0.1 * rate))) offsets.push(d);

  const ratios = measures.map((m, k) => (k + 1 < measures.length && m.duration > 0 ? (startsSec[k + 1] - startsSec[k]) / m.duration : NaN));

  return measures.map((m, k) => {
    if (m.startTime < covered[0] - 1e-6 || m.startTime > covered[1] + 1e-6) return 0;

    // pitched material in the bar
    const b0 = Math.max(0, Math.round(m.startTime * rate));
    const b1 = Math.min(score.n - 1, Math.max(b0, Math.round((m.startTime + m.duration) * rate) - 1));
    let pitched = 0;
    for (let i = b0; i <= b1; i++) pitched += score.harmonyValid[i];
    const harmonyFraction = pitched / (b1 - b0 + 1);

    // distinctiveness of the boundary
    const half = Math.max(0.25, Math.min(1.5, 0.35 * m.duration));
    const w0 = Math.max(0, Math.round((m.startTime - half) * rate));
    const w1 = Math.min(score.n - 1, Math.round((m.startTime + half) * rate));
    let pathCost = 0;
    let altCost = 0;
    let pathCount = 0;
    let altCount = 0;
    for (let i = w0; i <= w1; i++) {
      const j = at(i / rate);
      if (j < 0 || j >= audio.n) continue;
      pathCost += pairCost(score, audio, i, j);
      pathCount++;
      for (const d of offsets) {
        for (const jj of [j - d, j + d]) {
          if (jj < 0 || jj >= audio.n) continue;
          altCost += pairCost(score, audio, i, jj);
          altCount++;
        }
      }
    }
    if (pathCount === 0) return 0;
    pathCost /= pathCount;
    altCost = altCount > 0 ? altCost / altCount : pathCost;
    const distinct = altCost > 1e-9 ? 1 - pathCost / altCost : 0;
    let conf = clamp01((distinct - T.distinctLow) / (T.distinctHigh - T.distinctLow));

    if (harmonyFraction < T.restHarmony) conf *= T.restFactor;

    const shift = Math.abs(interp(m.startTime, mapping.score, mapping.recording) - interp(m.startTime, seed.score, seed.recording));
    if (shift > T.shiftSlackSec) conf *= 1 - Math.min(0.5, (shift - T.shiftSlackSec) / (CORRIDOR_RADIUS_SEC - T.shiftSlackSec));

    const a = ratios[k - 1];
    const b = ratios[k];
    if (a > 0 && b > 0) {
      const dev = Math.abs(a - b) / ((a + b) / 2);
      if (dev > T.tempoSlack) conf *= 1 - Math.min(0.6, (dev - T.tempoSlack) / T.tempoSpan);
    }

    let pct = Math.round(100 * clamp01(conf));
    if (!input.accepted) pct = Math.min(pct, T.fallbackCap);
    return pct;
  });
}

function clamp01(v: number) {
  return Math.max(0, Math.min(1, v));
}
