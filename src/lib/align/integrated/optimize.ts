/**
 * Joint fit of acoustic agreement and tempo (guide section 9).
 *
 * Unknowns: recording times t_k at musical knots s_k (every sixteenth of the
 * shared quarter clock, tempo changes, fermata / ensemble-gap boundaries, and
 * seed positions). The recording clock is piecewise linear between knots.
 *
 * Objective (sum of squared residuals):
 *   1. acoustic   mean joint cost along the clock, read from a ±4 s corridor
 *                 around the broad seed (cubic Hermite in recording time)
 *   2. continuity λ Σ w_k (log r_{k+1} − log r_k)² / h_k / Σ h, r_k = Δt_k / Δs_k,
 *                 λ = 0.25, w = 0.25 next to protected intervals
 *   3. corridor   4 · mean(outside distance²)
 *   4. monotone   1000 · Σ (deficit below 5 % of nominal / nominal)²
 *   5. endpoints  1e-4 · drift of the first and last knot
 *
 * Two stages, with the cost field Gaussian-smoothed along recording time at
 * σ = 0.10 s then 0.04 s, each bounded to ±4 s of its start.
 *
 * Solver: the reference calls SciPy least_squares (TRF + LSMR). Every
 * residual touches at most three neighboring knots, so JᵀJ is pentadiagonal;
 * this port solves the same objective with a bounded Levenberg–Marquardt
 * iteration on that banded system (exact LDLᵀ solve per step), with
 * Jacobian-based scaling like x_scale='jac'.
 */
import { OUTSIDE_COST, pairCost, type CueSide, type ScoreCueSide } from "./cost";
import { gaussianKernel, gaussianRow, interp } from "./signal";

export const CORRIDOR_RADIUS_SEC = 4;
export const REGULARIZATION = 0.25;
export const PROTECTED_WEIGHT = 0.25;
export const STAGE_SIGMAS_SEC = [0.1, 0.04];
export const ACOUSTIC_TOLERANCE = 0.02;
const MAX_EVALUATIONS = 1200;
const FTOL = 1e-8;
const XTOL = 1e-8;
const GTOL = 1e-7;

/* ------------------------------------------------------------------ */
/* Score clock                                                          */
/* ------------------------------------------------------------------ */

export interface ScoreClock {
  /** quarter position of each tempo segment start, with its score seconds and bpm */
  segments: Array<{ q: number; sec: number; bpm: number }>;
  toQuarter(sec: number): number;
  toSeconds(q: number): number;
}

export function scoreClock(tempo: Array<{ time: number; bpm: number }>, fallbackBpm: number): ScoreClock {
  const points = tempo.filter((t) => t.bpm > 0 && Number.isFinite(t.time)).sort((a, b) => a.time - b.time);
  if (points.length === 0 || points[0].time > 1e-9) points.unshift({ time: 0, bpm: points[0]?.bpm ?? (fallbackBpm > 0 ? fallbackBpm : 120) });
  const segments: ScoreClock["segments"] = [];
  for (const p of points) {
    const last = segments[segments.length - 1];
    const q = last ? last.q + ((p.time - last.sec) * last.bpm) / 60 : 0;
    if (last && Math.abs(p.time - last.sec) < 1e-9) last.bpm = p.bpm;
    else segments.push({ q, sec: p.time, bpm: p.bpm });
  }
  const find = (v: number, key: "q" | "sec") => {
    let lo = 0;
    let hi = segments.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (segments[mid][key] <= v) lo = mid;
      else hi = mid - 1;
    }
    return segments[lo];
  };
  return {
    segments,
    toQuarter: (sec) => {
      const s = find(sec, "sec");
      return s.q + ((sec - s.sec) * s.bpm) / 60;
    },
    toSeconds: (q) => {
      const s = find(q, "q");
      return s.sec + ((q - s.q) * 60) / s.bpm;
    },
  };
}

/* ------------------------------------------------------------------ */
/* Direct solver in absolute knot times                                 */
/* ------------------------------------------------------------------ */

export interface DirectInput {
  /** score seconds of each acoustic sample */
  sampleTimes: Float64Array;
  /** recording seconds of corridor column 0 for each sample */
  origins: Float64Array;
  /** cost rows, sample-major, `width` columns each */
  costs: Float32Array;
  width: number;
  /** recording seconds per corridor column */
  step: number;
  knots: Float64Array;
  initial: Float64Array;
  /** knots[k+1] − knots[k] */
  nominal: Float64Array;
  /** continuity weights, length knots − 2 */
  weights?: Float64Array;
  /** musical spacing (quarters) of each continuity term, length knots − 2 */
  spacings?: Float64Array;
  regularization?: number;
  maxEvaluations?: number;
  /** knots held at their initial time (manual-marker anchors, ADR 0021) */
  fixed?: Uint8Array;
  /** called once per iteration; may throw to abort */
  check?: () => void;
}

export interface DirectResult {
  times: Float64Array;
  objectiveBefore: number;
  objectiveAfter: number;
  converged: boolean;
  accepted: boolean;
  evaluations: number;
  maxBandExcessSec: number;
  acousticBefore: number;
  acousticAfter: number;
}

interface Evaluation {
  /** Σ r² */
  sumSq: number;
  /** Jᵀr */
  grad: Float64Array;
  /** JᵀJ diagonal and the first two super-diagonals */
  h0: Float64Array;
  h1: Float64Array;
  h2: Float64Array;
}

function prepare(input: DirectInput) {
  const n = input.initial.length;
  const N = input.sampleTimes.length;
  const left = new Int32Array(N);
  const frac = new Float64Array(N);
  const ks = input.knots;
  for (let i = 0; i < N; i++) {
    const st = input.sampleTimes[i];
    let lo = 0;
    let hi = n - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (ks[mid] <= st) lo = mid;
      else hi = mid - 1;
    }
    const l = Math.max(0, Math.min(n - 2, lo));
    left[i] = l;
    frac[i] = Math.max(0, Math.min(1, (st - ks[l]) / (ks[l + 1] - ks[l])));
  }
  const weights = input.weights ?? new Float64Array(Math.max(0, n - 2)).fill(1);
  const spacings = input.spacings ?? new Float64Array(Math.max(0, n - 2)).fill(1);
  let spacingSum = 0;
  for (const s of spacings) spacingSum += s;
  const reg = input.regularization ?? REGULARIZATION;
  const scale = Float64Array.from(spacings, (h, t) => Math.sqrt((reg * weights[t]) / (Math.max(h, 1e-7) * Math.max(spacingSum, 1e-7))));
  return { n, N, left, frac, scale };
}

type Prepared = ReturnType<typeof prepare>;

/** Residuals of _direct_residual_jac (no pause variables); returns Σ r², and Jᵀr / JᵀJ when asked. */
function evaluate(x: Float64Array, input: DirectInput, p: Prepared, withJacobian: boolean): Evaluation {
  const { n, N, left, frac, scale } = p;
  const { costs, width, step, origins, nominal, initial } = input;
  const grad = new Float64Array(n);
  const h0 = new Float64Array(n);
  const h1 = new Float64Array(n);
  const h2 = new Float64Array(n);
  let sumSq = 0;
  const add2 = (c: number, a: number, b: number, r: number) => {
    sumSq += r * r;
    if (!withJacobian) return;
    grad[c] += a * r;
    grad[c + 1] += b * r;
    h0[c] += a * a;
    h0[c + 1] += b * b;
    h1[c] += a * b;
  };

  // 1–2. acoustic and corridor residuals per sample
  const invN = 1 / N;
  const outsideScale = Math.sqrt(4 * invN);
  for (let i = 0; i < N; i++) {
    const l = left[i];
    const f0 = frac[i];
    const sample = (1 - f0) * x[l] + f0 * x[l + 1];
    const z = (sample - origins[i]) / step;
    const j = Math.floor(Math.max(0, Math.min(width - 1 - 1e-8, z)));
    const f = Math.max(0, Math.min(1, z - j));
    const o = i * width;
    const y0 = costs[o + j];
    const y1 = costs[o + j + 1];
    const m0 = (y1 - costs[o + Math.max(j - 1, 0)]) / 2;
    const m1 = (costs[o + Math.min(j + 2, width - 1)] - y0) / 2;
    const f2 = f * f;
    const f3 = f2 * f;
    const val = (2 * f3 - 3 * f2 + 1) * y0 + (f3 - 2 * f2 + f) * m0 + (-2 * f3 + 3 * f2) * y1 + (f3 - f2) * m1;
    let deriv = ((6 * f2 - 6 * f) * y0 + (3 * f2 - 4 * f + 1) * m0 + (-6 * f2 + 6 * f) * y1 + (3 * f2 - 2 * f) * m1) / step;
    const outside = z < 0 || z > width - 1;
    if (outside || val < 1e-10) deriv = 0;
    const v = Math.max(val, 1e-10);
    const r = Math.sqrt(v * invN);
    const g = deriv / (2 * Math.sqrt(v * N));
    add2(l, g * (1 - f0), g * f0, r);
    const excess = Math.min(z, 0) + Math.max(z - (width - 1), 0);
    const gc = outside ? outsideScale : 0;
    add2(l, gc * (1 - f0), gc * f0, outsideScale * excess * step);
  }

  // 3. continuity of log rate
  const safe = new Float64Array(n - 1);
  const inv = new Float64Array(n - 1);
  for (let k = 0; k < n - 1; k++) {
    const moving = x[k + 1] - x[k];
    safe[k] = Math.max(moving, nominal[k] * 0.001);
    inv[k] = moving > nominal[k] * 0.001 ? 1 / safe[k] : 0;
  }
  for (let t = 0; t < n - 2; t++) {
    const s = scale[t];
    const r = s * (Math.log(safe[t + 1] / nominal[t + 1]) - Math.log(safe[t] / nominal[t]));
    sumSq += r * r;
    if (!withJacobian) continue;
    const a = s * inv[t];
    const b = -s * (inv[t] + inv[t + 1]);
    const c = s * inv[t + 1];
    grad[t] += a * r;
    grad[t + 1] += b * r;
    grad[t + 2] += c * r;
    h0[t] += a * a;
    h0[t + 1] += b * b;
    h0[t + 2] += c * c;
    h1[t] += a * b;
    h1[t + 1] += b * c;
    h2[t] += a * c;
  }

  // 4. monotonicity barrier
  const root1000 = Math.sqrt(1000);
  for (let k = 0; k < n - 1; k++) {
    const deficit = Math.min(x[k + 1] - x[k] - 0.05 * nominal[k], 0);
    const g = deficit < 0 ? root1000 / nominal[k] : 0;
    add2(k, -g, g, (root1000 * deficit) / nominal[k]);
  }

  // 5. weak endpoint trust
  const e = Math.sqrt(1e-4);
  const r0 = e * (x[0] - initial[0]);
  const r1 = e * (x[n - 1] - initial[n - 1]);
  sumSq += r0 * r0 + r1 * r1;
  if (withJacobian) {
    grad[0] += e * r0;
    h0[0] += e * e;
    grad[n - 1] += e * r1;
    h0[n - 1] += e * e;
  }
  return { sumSq, grad, h0, h1, h2 };
}

/** Σ r² and Jᵀr of the direct objective at x (exposed for gradient checks). */
export function directObjective(x: Float64Array, input: DirectInput): { sumSq: number; grad: Float64Array } {
  const ev = evaluate(x, input, prepare(input), true);
  return { sumSq: ev.sumSq, grad: ev.grad };
}

/** Solve (pentadiagonal SPD) A x = b by LDLᵀ. a0 diagonal, a1/a2 first/second super-diagonals. */
export function solvePentadiagonal(a0: Float64Array, a1: Float64Array, a2: Float64Array, b: Float64Array): Float64Array {
  const n = a0.length;
  const d = new Float64Array(n);
  const l1 = new Float64Array(n); // L[i][i-1]
  const l2 = new Float64Array(n); // L[i][i-2]
  for (let i = 0; i < n; i++) {
    if (i >= 2) l2[i] = a2[i - 2] / d[i - 2];
    if (i >= 1) l1[i] = (a1[i - 1] - (i >= 2 ? l2[i] * d[i - 2] * l1[i - 1] : 0)) / d[i - 1];
    d[i] = a0[i] - (i >= 2 ? l2[i] * l2[i] * d[i - 2] : 0) - (i >= 1 ? l1[i] * l1[i] * d[i - 1] : 0);
    if (!(d[i] > 0)) d[i] = 1e-12;
  }
  const y = new Float64Array(n);
  for (let i = 0; i < n; i++) y[i] = b[i] - (i >= 1 ? l1[i] * y[i - 1] : 0) - (i >= 2 ? l2[i] * y[i - 2] : 0);
  for (let i = 0; i < n; i++) y[i] /= d[i];
  const x = new Float64Array(n);
  for (let i = n - 1; i >= 0; i--) x[i] = y[i] - (i + 1 < n ? l1[i + 1] * x[i + 1] : 0) - (i + 2 < n ? l2[i + 2] * x[i + 2] : 0);
  return x;
}

/** Mean acoustic cost along a clock, linear interpolation in the corridor (acoustic_mean). */
export function acousticMean(times: ArrayLike<number>, origins: Float64Array, costs: Float32Array, width: number, step: number): number {
  let total = 0;
  for (let i = 0; i < origins.length; i++) {
    const z = (times[i] - origins[i]) / step;
    const j = Math.floor(Math.max(0, Math.min(width - 1 - 1e-8, z)));
    const f = Math.max(0, Math.min(1, z - j));
    total += costs[i * width + j] * (1 - f) + costs[i * width + j + 1] * f;
  }
  return total / Math.max(1, origins.length);
}

function sampleClock(input: DirectInput, times: Float64Array): Float64Array {
  return Float64Array.from(input.sampleTimes, (s) => interp(s, input.knots, times));
}

export function optimizeTimesDirect(input: DirectInput): DirectResult {
  const p = prepare(input);
  const { n } = p;
  if (n < 2 || input.width < 2 || input.costs.length !== input.sampleTimes.length * input.width) throw new Error("Invalid optimizer inputs.");
  for (let k = 1; k < n; k++) if (!(input.initial[k] > input.initial[k - 1])) throw new Error("Seed must be strictly increasing.");
  const fixed = input.fixed;
  const low = Float64Array.from(input.initial, (v, i) => (fixed?.[i] ? v : Math.max(0, v - CORRIDOR_RADIUS_SEC)));
  const high = Float64Array.from(input.initial, (v, i) => (fixed?.[i] ? v : v + CORRIDOR_RADIUS_SEC));
  const maxEval = input.maxEvaluations ?? MAX_EVALUATIONS;

  let x = Float64Array.from(input.initial);
  let ev = evaluate(x, input, p, true);
  const before = ev.sumSq;
  const dScale = Float64Array.from(ev.h0, (v) => Math.max(Math.sqrt(v), 1e-10));
  let mu = 1e-3;
  let nu = 2;
  let evaluations = 1;
  let converged = false;
  const free = new Uint8Array(n);
  const a0 = new Float64Array(n);
  const a1 = new Float64Array(n);
  const a2 = new Float64Array(n);
  const rhs = new Float64Array(n);
  const norm = (v: Float64Array) => Math.sqrt(v.reduce((s, q) => s + q * q, 0));

  while (evaluations < maxEval) {
    input.check?.();
    // active bounds: variables pressed against a bound by the gradient stay there this step
    let gScaled = 0;
    for (let i = 0; i < n; i++) {
      const g = ev.grad[i];
      const atLow = x[i] <= low[i] + 1e-12 && g > 0;
      const atHigh = x[i] >= high[i] - 1e-12 && g < 0;
      free[i] = atLow || atHigh || fixed?.[i] ? 0 : 1;
      if (free[i]) gScaled = Math.max(gScaled, Math.abs(g) / dScale[i]);
    }
    if (gScaled < GTOL) {
      converged = true;
      break;
    }
    for (let i = 0; i < n; i++) {
      if (!free[i]) {
        a0[i] = 1;
        a1[i] = 0;
        a2[i] = 0;
        rhs[i] = 0;
        continue;
      }
      a0[i] = ev.h0[i] + mu * dScale[i] * dScale[i];
      a1[i] = i + 1 < n && free[i + 1] ? ev.h1[i] : 0;
      a2[i] = i + 2 < n && free[i + 2] ? ev.h2[i] : 0;
      rhs[i] = -ev.grad[i];
    }
    const delta = solvePentadiagonal(a0, a1, a2, rhs);
    const xn = new Float64Array(n);
    const step = new Float64Array(n);
    for (let i = 0; i < n; i++) {
      xn[i] = Math.max(low[i], Math.min(high[i], x[i] + (free[i] ? delta[i] : 0)));
      step[i] = xn[i] - x[i];
    }
    // predicted decrease of ½Σr² from the Gauss–Newton model
    let lin = 0;
    let quad = 0;
    for (let i = 0; i < n; i++) {
      lin += ev.grad[i] * step[i];
      quad += ev.h0[i] * step[i] * step[i];
      if (i + 1 < n) quad += 2 * ev.h1[i] * step[i] * step[i + 1];
      if (i + 2 < n) quad += 2 * ev.h2[i] * step[i] * step[i + 2];
    }
    const predicted = -(lin + 0.5 * quad);
    const evn = evaluate(xn, input, p, true);
    evaluations++;
    const actual = 0.5 * (ev.sumSq - evn.sumSq);
    const stepSmall = norm(step) < XTOL * (XTOL + norm(x));
    if (actual > 0 && predicted > 0) {
      const rho = actual / predicted;
      const oldHalf = 0.5 * ev.sumSq;
      x = xn;
      ev = evn;
      mu *= Math.max(1 / 3, 1 - (2 * rho - 1) ** 3);
      nu = 2;
      for (let i = 0; i < n; i++) dScale[i] = Math.max(dScale[i], Math.sqrt(ev.h0[i]));
      if (actual < FTOL * oldHalf || stepSmall) {
        converged = true;
        break;
      }
    } else {
      mu *= nu;
      nu *= 2;
      if (stepSmall || mu > 1e16) {
        converged = stepSmall;
        break;
      }
    }
  }

  const after = ev.sumSq;
  let times = x;
  const clock = sampleClock(input, times);
  let maxExcess = 0;
  for (let i = 0; i < clock.length; i++) {
    const lo = input.origins[i];
    const hi = lo + (input.width - 1) * input.step;
    maxExcess = Math.max(maxExcess, Math.max(lo - clock[i], 0) + Math.max(clock[i] - hi, 0));
  }
  let monotone = true;
  for (let k = 1; k < n; k++) if (!(times[k] > times[k - 1])) monotone = false;
  const accepted = monotone && after <= before + 1e-8 && maxExcess < 0.02;
  if (!accepted) times = Float64Array.from(input.initial);
  return {
    times,
    objectiveBefore: before,
    objectiveAfter: after,
    converged,
    accepted,
    evaluations,
    maxBandExcessSec: maxExcess,
    acousticBefore: acousticMean(sampleClock(input, input.initial), input.origins, input.costs, input.width, input.step),
    acousticAfter: acousticMean(sampleClock(input, times), input.origins, input.costs, input.width, input.step),
  };
}

/* ------------------------------------------------------------------ */
/* optimize_mapping                                                     */
/* ------------------------------------------------------------------ */

export interface Mapping {
  /** score seconds, strictly increasing */
  score: number[];
  /** recording seconds, increasing */
  recording: number[];
}

export interface OptimizeInput {
  score: ScoreCueSide;
  audio: CueSide;
  /** feature frames per second (both sides) */
  rate: number;
  seed: Mapping;
  clock: ScoreClock;
  /** fermatas and ensemble gaps, quarter positions */
  protectedQuarters: Array<[number, number]>;
  /** manual-marker anchors: a knot at each, held at its recording time (ADR 0021) */
  anchors?: Array<{ scoreSec: number; sec: number }>;
  onProgress?: (fraction: number, message: string) => void;
  check?: () => void;
}

export interface StageDiagnostics {
  costScaleSec: number;
  accepted: boolean;
  converged: boolean;
  evaluations: number;
  objectiveBefore: number;
  objectiveAfter: number;
  maxBandExcessSec: number;
}

export interface OptimizeResult {
  mapping: Mapping;
  /** knot score seconds and fitted recording seconds */
  knots: Float64Array;
  times: Float64Array;
  /** the broad seed sampled at the knots */
  seedTimes: Float64Array;
  accepted: boolean;
  converged: boolean;
  acousticBefore: number;
  acousticAfter: number;
  stages: StageDiagnostics[];
  maxShiftSec: number;
  knotCount: number;
  sampleCount: number;
  protectedKnotIntervals: number;
  /** what to read cost from when scoring confidence */
  corridor: { sampleTimes: Float64Array; origins: Float64Array; costs: Float32Array; width: number; step: number };
  reason?: string;
}

/**
 * Sorted, with values closer than `tolerance` merged (the first is kept).
 * Positions rebuilt from the info map's rounded seconds land ~1e-6 quarters
 * off the sixteenth grid; unmerged, they would create near-zero knot
 * intervals that pin both knots in place.
 */
function uniqueSorted(values: number[], tolerance = 1e-9): number[] {
  const sorted = [...values].sort((a, b) => a - b);
  const out: number[] = [];
  for (const v of sorted) if (out.length === 0 || v - out[out.length - 1] > tolerance) out.push(v);
  return out;
}

/** knots closer than this many quarters are one knot */
const KNOT_MERGE_QUARTERS = 1e-4;

export function optimizeMapping(input: OptimizeInput): OptimizeResult {
  const { score, audio, rate, seed, clock, protectedQuarters } = input;
  const lo = seed.score[0];
  const hi = seed.score[seed.score.length - 1];
  const qlo = clock.toQuarter(lo);
  const qhi = clock.toQuarter(hi);

  // 9.1 knots: sixteenths, tempo changes, protection boundaries, seed positions
  let qs: number[] = [qlo, qhi];
  for (let q = Math.ceil(qlo * 4) / 4; q < qhi; q += 0.25) qs.push(q);
  for (const s of clock.segments) if (s.q > qlo && s.q < qhi) qs.push(s.q);
  for (const [a, b] of protectedQuarters) for (const v of [a, b]) if (v > qlo && v < qhi) qs.push(v);
  qs = uniqueSorted(qs, KNOT_MERGE_QUARTERS);
  const extra: number[] = [];
  for (const s of seed.score) {
    const v = clock.toQuarter(s);
    let lo2 = 0;
    let hi2 = qs.length - 1;
    while (lo2 < hi2) {
      const mid = (lo2 + hi2) >> 1;
      if (qs[mid] < v) lo2 = mid + 1;
      else hi2 = mid;
    }
    const near = Math.min(Math.abs(qs[lo2] - v), lo2 > 0 ? Math.abs(qs[lo2 - 1] - v) : Infinity);
    if (near >= 0.02) extra.push(v);
  }
  qs = uniqueSorted([...qs, ...extra], KNOT_MERGE_QUARTERS);
  // anchors replace any knot within the merge distance, so each sits exactly on its note
  const anchorQs = (input.anchors ?? []).filter((a) => a.scoreSec >= lo - 1e-9 && a.scoreSec <= hi + 1e-9).map((a) => clock.toQuarter(a.scoreSec));
  if (anchorQs.length) {
    qs = qs.filter((q) => q === qlo || q === qhi || !anchorQs.some((a) => Math.abs(a - q) <= KNOT_MERGE_QUARTERS));
    qs = uniqueSorted([...qs, ...anchorQs.filter((a) => a > qlo + KNOT_MERGE_QUARTERS && a < qhi - KNOT_MERGE_QUARTERS)], 0);
  }
  const n = qs.length;
  const knots = Float64Array.from(qs, (q) => clock.toSeconds(q));
  knots[0] = lo;
  knots[n - 1] = hi;
  const initial = Float64Array.from(knots, (s) => interp(s, seed.score, seed.recording));
  // a knot is fixed when an anchor sits on it (the seed already passes through every anchor)
  const fixed = new Uint8Array(n);
  for (const a of input.anchors ?? []) {
    const q = clock.toQuarter(a.scoreSec);
    for (let k = 0; k < n; k++) {
      if (Math.abs(qs[k] - q) <= KNOT_MERGE_QUARTERS) {
        fixed[k] = 1;
        initial[k] = a.sec;
      }
    }
  }
  for (let k = 1; k < n; k++) if (!(initial[k] > initial[k - 1]) || !(knots[k] > knots[k - 1])) throw new Error("Seed must have strictly increasing score and recording clocks.");
  const nominal = Float64Array.from({ length: n - 1 }, (_, k) => knots[k + 1] - knots[k]);

  // 9.2 protection weights
  const isProtected = new Uint8Array(n - 1);
  for (const [a, b] of protectedQuarters) for (let k = 0; k < n - 1; k++) if (qs[k] < b - 1e-8 && qs[k + 1] > a + 1e-8) isProtected[k] = 1;
  const weights = Float64Array.from({ length: Math.max(0, n - 2) }, (_, t) => (isProtected[t] || isProtected[t + 1] ? PROTECTED_WEIGHT : 1));
  const spacings = Float64Array.from({ length: Math.max(0, n - 2) }, (_, t) => (qs[t + 1] - qs[t] + (qs[t + 2] - qs[t + 1])) / 2);

  // 9.3 acoustic corridor around the seed
  const i0 = Math.round(lo * rate);
  const i1 = Math.min(score.n - 1, Math.round(hi * rate));
  const N = i1 - i0 + 1;
  const sampleTimes = Float64Array.from({ length: N }, (_, k) => (i0 + k) / rate);
  const width = Math.round(CORRIDOR_RADIUS_SEC * 2 * rate) + 1;
  const step = 1 / rate;
  const origins = Float64Array.from(sampleTimes, (s) => Math.floor((interp(s, seed.score, seed.recording) - CORRIDOR_RADIUS_SEC) * rate) / rate);
  const raw = new Float32Array(N * width);
  const report = Math.max(1, Math.floor(N / 20));
  for (let k = 0; k < N; k++) {
    const si = i0 + k;
    const base = Math.round(origins[k] * rate);
    const o = k * width;
    for (let c = 0; c < width; c++) {
      const aj = base + c;
      raw[o + c] = aj >= 0 && aj < audio.n ? pairCost(score, audio, si, aj) : OUTSIDE_COST;
    }
    if (k % report === 0) input.onProgress?.(0.4 * (k / N), "Building the acoustic corridor");
  }

  // 9.4–9.5 two stages on a smoothed cost field
  const stages: StageDiagnostics[] = [];
  const field = new Float32Array(N * width);
  const rowIn = new Float32Array(width);
  const rowOut = new Float32Array(width);
  let current: Float64Array = Float64Array.from(initial);
  STAGE_SIGMAS_SEC.forEach((sigma, s) => {
    input.check?.();
    input.onProgress?.(0.4 + 0.3 * s, `Fitting tempo and audio together (${sigma.toFixed(2)} s scale)`);
    const kernel = gaussianKernel(sigma * rate);
    for (let k = 0; k < N; k++) {
      rowIn.set(raw.subarray(k * width, (k + 1) * width));
      gaussianRow(rowIn, kernel, rowOut);
      field.set(rowOut, k * width);
    }
    const result = optimizeTimesDirect({
      sampleTimes,
      origins,
      costs: field,
      width,
      step,
      knots,
      initial: current,
      nominal,
      weights,
      spacings,
      regularization: REGULARIZATION,
      fixed,
      check: input.check,
    });
    stages.push({
      costScaleSec: sigma,
      accepted: result.accepted,
      converged: result.converged,
      evaluations: result.evaluations,
      objectiveBefore: result.objectiveBefore,
      objectiveAfter: result.objectiveAfter,
      maxBandExcessSec: result.maxBandExcessSec,
    });
    current = result.times;
  });

  // 9.6 validation against the raw (unsmoothed) acoustic cost
  const clockOf = (times: Float64Array) => Float64Array.from(sampleTimes, (st) => interp(st, knots, times));
  const acousticBefore = acousticMean(clockOf(initial), origins, raw, width, step);
  const acousticCandidate = acousticMean(clockOf(current), origins, raw, width, step);
  const acousticAccepted = acousticCandidate <= acousticBefore + ACOUSTIC_TOLERANCE;
  if (!acousticAccepted) current = Float64Array.from(initial);

  const gridScore = uniqueSorted([...seed.score, ...knots], 1e-7);
  const mapping: Mapping = { score: gridScore, recording: gridScore.map((g) => interp(g, knots, current)) };
  const corridor = { sampleTimes, origins, costs: raw, width, step };
  const base = {
    knots,
    seedTimes: initial,
    stages,
    knotCount: n,
    sampleCount: N,
    protectedKnotIntervals: isProtected.reduce((s, v) => s + v, 0),
    corridor,
    converged: stages.every((st) => st.converged),
  };
  if (mapping.recording[mapping.recording.length - 1] > (audio.n - 1) / rate) {
    return { ...base, mapping: seed, times: initial, accepted: false, acousticBefore, acousticAfter: acousticBefore, maxShiftSec: 0, reason: "Optimized endpoint exceeded the recording" };
  }
  let maxShiftSec = 0;
  for (let k = 0; k < mapping.score.length; k++) maxShiftSec = Math.max(maxShiftSec, Math.abs(mapping.recording[k] - interp(mapping.score[k], seed.score, seed.recording)));
  return {
    ...base,
    mapping,
    times: current,
    accepted: acousticAccepted && stages.some((st) => st.accepted),
    acousticBefore,
    acousticAfter: acousticMean(clockOf(current), origins, raw, width, step),
    maxShiftSec,
    reason: acousticAccepted ? undefined : "Joint fit worsened the raw acoustic agreement; kept the broad match",
  };
}
