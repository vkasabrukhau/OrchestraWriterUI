/**
 * joint_cost (guide section 7): the mismatch between score frame i and
 * recording frame j, from five cues with availability masks.
 *
 * | cue       | cost                                  | available when                                  | weight |
 * |-----------|---------------------------------------|-------------------------------------------------|--------|
 * | harmony   | clip(1 − cos(chroma_i, chroma_j))     | score frame pitched and not an expected rest     | 0.55   |
 * | dynamics  | |level_i − level_j|                   | both levels vary (σ > 0.035 over ~4 s), no rest  | 0.15   |
 * | attack    | |attack_i − attack_j| (±40 ms maxima) | either attack > 0.12                             | 0.25   |
 * | rest      | clip(recording level / 0.2)           | score rest confirmed for 80 ms                   | 0.15   |
 * | structure | |novelty_i − novelty_j|               | either > 0.15 and both contexts valid            | 0.10   |
 *
 * C(i, j) = Σ w·cost / Σ w over the available cues, or 0.5 when none is.
 *
 * The per-frame inputs (unit chroma, masks, filtered attacks) are computed
 * once over the whole piece, so a cell costs the same whichever window asks
 * for it. The Python reference recomputes them per window slice, which moves
 * cue availability slightly at slice edges (the guide notes this caveat).
 */
import { PCS, type SyncFeatures } from "./features";
import { maximumFilter, uniformFilter } from "./signal";

export const CUE_WEIGHTS = { harmony: 0.55, dynamics: 0.15, attack: 0.25, rest: 0.15, structure: 0.1 } as const;
export type Cue = keyof typeof CUE_WEIGHTS;
/** cost of a corridor cell outside the recording */
export const OUTSIDE_COST = 2;

export interface CueSide {
  n: number;
  unit: Float32Array;
  level: Float32Array;
  variation: Float32Array;
  attack: Float32Array;
  novelty: Float32Array;
  noveltyValid: Uint8Array;
}

export interface ScoreCueSide extends CueSide {
  /** harmony available: pitched and not resting */
  harmonyValid: Uint8Array;
  /** not resting */
  sounding: Uint8Array;
  /** rest confirmed for the release allowance */
  confirmedRest: Uint8Array;
}

function sideOf(f: SyncFeatures): CueSide & { norms: Float32Array } {
  const unit = new Float32Array(f.n * PCS);
  const norms = new Float32Array(f.n);
  for (let j = 0; j < f.n; j++) {
    let s = 0;
    for (let c = 0; c < PCS; c++) s += f.chroma[j * PCS + c] ** 2;
    const norm = Math.sqrt(s);
    norms[j] = norm;
    const d = Math.max(norm, 1e-8);
    for (let c = 0; c < PCS; c++) unit[j * PCS + c] = f.chroma[j * PCS + c] / d;
  }
  const size = Math.max(3, Math.round(4 * f.rate));
  const mean = uniformFilter(f.level, size);
  const meanSq = uniformFilter(
    f.level.map((v) => v * v),
    size,
  );
  const variation = new Float32Array(f.n);
  for (let j = 0; j < f.n; j++) variation[j] = Math.sqrt(Math.max(meanSq[j] - mean[j] * mean[j], 0));
  const attack = maximumFilter(f.attack, Math.max(1, 2 * Math.round(0.04 * f.rate) + 1));
  return { n: f.n, unit, norms, level: f.level, variation, attack, novelty: f.novelty, noveltyValid: f.noveltyValid };
}

export function scoreSide(f: SyncFeatures): ScoreCueSide {
  const side = sideOf(f);
  const harmonyValid = new Uint8Array(f.n);
  const sounding = new Uint8Array(f.n);
  for (let j = 0; j < f.n; j++) {
    sounding[j] = f.rest[j] ? 0 : 1;
    harmonyValid[j] = side.norms[j] > 1e-8 && !f.rest[j] ? 1 : 0;
  }
  const lag = Math.max(1, Math.round(0.08 * f.rate));
  const confirmedRest = new Uint8Array(f.n);
  let anySound = false;
  for (let j = 0; j < f.n; j++) if (!f.rest[j]) anySound = true;
  if (anySound) for (let j = lag; j < f.n; j++) confirmedRest[j] = f.rest[j] && f.rest[j - lag] ? 1 : 0;
  return { ...side, harmonyValid, sounding, confirmedRest };
}

export function audioSide(f: SyncFeatures): CueSide {
  return sideOf(f);
}

const W = CUE_WEIGHTS;

/** C(i, j). */
export function pairCost(s: ScoreCueSide, a: CueSide, i: number, j: number, useStructure = true): number {
  let num = 0;
  let den = 0;
  if (s.harmonyValid[i]) {
    let dot = 0;
    const oi = i * PCS;
    const oj = j * PCS;
    for (let c = 0; c < PCS; c++) dot += s.unit[oi + c] * a.unit[oj + c];
    num += W.harmony * Math.max(0, Math.min(1, 1 - dot));
    den += W.harmony;
  }
  if (s.sounding[i] && s.variation[i] > 0.035 && a.variation[j] > 0.035) {
    num += W.dynamics * Math.abs(s.level[i] - a.level[j]);
    den += W.dynamics;
  }
  if (s.attack[i] > 0.12 || a.attack[j] > 0.12) {
    num += W.attack * Math.abs(s.attack[i] - a.attack[j]);
    den += W.attack;
  }
  if (s.confirmedRest[i]) {
    num += W.rest * Math.max(0, Math.min(1, a.level[j] / 0.2));
    den += W.rest;
  }
  if (useStructure && (s.novelty[i] > 0.15 || a.novelty[j] > 0.15) && s.noveltyValid[i] && a.noveltyValid[j]) {
    num += W.structure * Math.abs(s.novelty[i] - a.novelty[j]);
    den += W.structure;
  }
  return den > 0 ? num / den : 0.5;
}

/** Weight of the cues available for (i, j), as a fraction of all five (for evidence reporting). */
export function evidenceWeight(s: ScoreCueSide, a: CueSide, i: number, j: number): number {
  let den = 0;
  if (s.harmonyValid[i]) den += W.harmony;
  if (s.sounding[i] && s.variation[i] > 0.035 && a.variation[j] > 0.035) den += W.dynamics;
  if (s.attack[i] > 0.12 || a.attack[j] > 0.12) den += W.attack;
  if (s.confirmedRest[i]) den += W.rest;
  if ((s.novelty[i] > 0.15 || a.novelty[j] > 0.15) && s.noveltyValid[i] && a.noveltyValid[j]) den += W.structure;
  return den / (W.harmony + W.dynamics + W.attack + W.rest + W.structure);
}

/** Full n × m matrix (row-major, score rows) for the coarse search. */
export function costMatrix(s: ScoreCueSide, a: CueSide): Float32Array {
  const out = new Float32Array(s.n * a.n);
  for (let i = 0; i < s.n; i++) {
    const o = i * a.n;
    for (let j = 0; j < a.n; j++) out[o + j] = pairCost(s, a, i, j);
  }
  return out;
}
