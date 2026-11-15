/**
 * "Integrated tempo from original search" behind the shared Aligner
 * interface (src/shared/sync.ts). TypeScript port of the method in
 * docs/research/score-sync-lab/INTEGRATED_FROM_ORIGINAL_GUIDE.md; ADR 0014
 * records how it differs from the Python reference and from chroma DTW.
 *
 *   info map  ──scoreFeatures──▶ chroma · expected level / attacks / rests ─┐
 *   recording ──audioFeatures──▶ tuned chroma · RMS · spectral flux ────────┤ + novelty
 *                                                                           ▼
 *   2 Hz joint cost ──subsequence DTW──▶ broad seed
 *   10 Hz joint cost ──banded DTW (±4 s)──▶ refined seed
 *   50 Hz ±4 s corridor ──joint tempo + audio fit──▶ validated clock
 *   clock ──▶ measure starts + heuristic per-measure confidence
 *
 * Manual markers arrive as anchors (ADR 0021): the broad match may not cross
 * them, the seed is re-timed through them, and the joint fit holds a knot
 * fixed at each one, so the tempo between and after them is refitted.
 */
import type { InfoMap } from "@/shared/info-map";
import type { AlignAudio, AlignProgress, Aligner, SyncState } from "@/shared/sync";
import { soundingTranspose } from "@/shared/score/transpose";
import { anchorColumnBounds, anchorMapping, cleanAnchors, type AlignAnchor } from "../anchors";
import { finalizeStarts } from "../index";
import { bandedDtw, pathMapping, subsequenceDtw, type CoarseMatch } from "./coarse";
import { integratedConfidences } from "./confidence";
import { audioSide, costMatrix, pairCost, scoreSide, type CueSide, type ScoreCueSide } from "./cost";
import { FEATURE_RATE, audioFeatures, downsampleFeatures, scoreFeatures, withNovelty, type SyncFeatures } from "./features";
import { optimizeMapping, scoreClock, type Mapping, type OptimizeResult, type ScoreClock } from "./optimize";
import { interp } from "./signal";

export const INTEGRATED_METHOD = "integrated-tempo";
const MIN_RECORDING_SEC = 2;
const MAX_SECONDS = 2400;
const COARSE_RATE = 2;

export interface IntegratedOptions {
  /** semitones from written to sounding pitch per part id (default: the parser's <transpose>) */
  transpose?: Record<string, number>;
  /** manual markers as score/recording pairs in this score and audio (ADR 0021) */
  anchors?: AlignAnchor[];
}

export interface IntegratedDetail {
  sync: SyncState;
  score: SyncFeatures;
  audio: SyncFeatures;
  broad: CoarseMatch;
  /** the 2 Hz broad match's mapping */
  broadSeed: Mapping;
  /** the 10 Hz banded refinement of it: the joint fit's seed */
  seed: Mapping;
  fit: OptimizeResult;
  clock: ScoreClock;
  /** fermatas and ensemble gaps, quarter positions */
  protectedQuarters: Array<[number, number]>;
}

function abortError(): Error {
  return typeof DOMException !== "undefined" ? new DOMException("Alignment cancelled", "AbortError") : Object.assign(new Error("Alignment cancelled"), { name: "AbortError" });
}

const nextTick = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

/** Fermatas and gaps in the union of sounding notes (protected_intervals), in quarters. */
export function protectedIntervals(infoMap: InfoMap, clock: ScoreClock): Array<[number, number]> {
  const out: Array<[number, number]> = [];
  for (const f of infoMap.timing?.fermatas ?? []) out.push([clock.toQuarter(f.start), clock.toQuarter(f.end)]);
  const sounding: Array<[number, number]> = [];
  for (const inst of infoMap.instruments) for (const nt of inst.notes) if (nt.duration > 0) sounding.push([clock.toQuarter(nt.time), clock.toQuarter(nt.time + nt.duration)]);
  sounding.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  let end = 0;
  for (const [a, b] of sounding) {
    if (a > end + 1e-7) out.push([end, a]);
    end = Math.max(end, b);
  }
  const seen = new Set<string>();
  return out
    .filter(([a, b]) => {
      const key = `${a.toFixed(9)}:${b.toFixed(9)}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .sort((x, y) => x[0] - y[0] || x[1] - y[1]);
}

function sliceFeatures(f: SyncFeatures, end: number): SyncFeatures {
  const n = Math.min(f.n, end);
  return {
    rate: f.rate,
    n,
    chroma: f.chroma.subarray(0, n * 12),
    level: f.level.subarray(0, n),
    attack: f.attack.subarray(0, n),
    rest: f.rest.subarray(0, n),
    novelty: f.novelty.subarray(0, n),
    noveltyValid: f.noveltyValid.subarray(0, n),
  };
}

/**
 * Penalty of a DTW jump (coarse.ts), in joint cost × seconds of path, so it
 * means the same at 2 Hz and 10 Hz: about 8 s of mediocre matching. 2–5 left
 * both test recordings unchanged and let a recording with a 30 s passage
 * played twice align without markers; 10 never fired.
 */
export const JUMP_PENALTY_COST_SEC = 4;

function jumpPenalty(rate: number): number {
  return JUMP_PENALTY_COST_SEC * rate;
}

/** columns of slack around an anchor in the 2 Hz broad match */
const COARSE_ANCHOR_TOLERANCE = 1;

/**
 * original_coarse: the 2 Hz broad match, extended to the supported end with
 * the last slope. With anchors, the path may not cross them (± 0.5 s) and the
 * seed is then re-timed to pass through them exactly.
 */
export function broadMatch(score: SyncFeatures, audio: SyncFeatures, end: number, anchors: AlignAnchor[] = []): { match: CoarseMatch; seed: Mapping } {
  const s2 = downsampleFeatures(sliceFeatures(score, Math.round(end * score.rate) + 1), COARSE_RATE);
  const a2 = downsampleFeatures(audio, COARSE_RATE);
  const ss: ScoreCueSide = scoreSide(s2);
  const as: CueSide = audioSide(a2);
  if (ss.n * as.n > 8_000_000) throw new Error("The score and recording are too long for the broad match.");
  const cells = anchors.map((a) => ({ row: Math.round(a.scoreSec * s2.rate), col: Math.round(a.sec * a2.rate) })).filter((c) => c.row < ss.n && c.col < as.n);
  const bounds = cells.length ? anchorColumnBounds(cells, ss.n, as.n, COARSE_ANCHOR_TOLERANCE) : undefined;
  const match = subsequenceDtw(costMatrix(ss, as), ss.n, as.n, 3, bounds, jumpPenalty(s2.rate));
  let seed = pathMapping(match, s2.rate);
  const k = seed.score.length - 1;
  if (k >= 1 && seed.score[k] < end) {
    const slope = (seed.recording[k] - seed.recording[k - 1]) / (seed.score[k] - seed.score[k - 1]);
    const finish = seed.recording[k] + slope * (end - seed.score[k]);
    if (finish <= (audio.n - 1) / audio.rate) {
      seed.score.push(end);
      seed.recording.push(finish);
    }
  }
  if (seed.score.length < 2) throw new Error("The broad match found too little of the score in the recording.");
  if (anchors.length) seed = anchorMapping(seed, anchors);
  return { match, seed };
}

/** frames per second of the banded pass between the broad match and the joint fit */
export const REFINE_RATE = 10;
/** seconds either side of the broad path that the banded pass searches */
export const REFINE_RADIUS_SEC = 4;

/**
 * A finer pass over the broad seed (not in the reference): the same joint
 * cost and DTW steps at 10 Hz, inside ±4 s of the 2 Hz path. At 2 Hz the
 * attacks and short rests that place a passage are averaged away, so the
 * broad path can settle a beat or two off; the joint fit only searches ±4 s
 * around its seed with tempo continuity, so it rarely leaves that basin.
 * Anchors fence the band as they fence the broad match.
 */
export function refineSeed(score: SyncFeatures, audio: SyncFeatures, end: number, seed: Mapping, anchors: AlignAnchor[] = []): Mapping {
  const rate = REFINE_RATE;
  const s = downsampleFeatures(sliceFeatures(score, Math.round(end * score.rate) + 1), rate);
  const a = downsampleFeatures(audio, rate);
  const ss = scoreSide(s);
  const as = audioSide(a);
  const lo = new Int32Array(s.n);
  const hi = new Int32Array(s.n);
  const radius = REFINE_RADIUS_SEC * rate;
  for (let i = 0; i < s.n; i++) {
    const center = interp(i / rate, seed.score, seed.recording) * rate;
    lo[i] = Math.max(0, Math.min(as.n - 1, Math.floor(center - radius)));
    hi[i] = Math.max(lo[i], Math.min(as.n - 1, Math.ceil(center + radius)));
  }
  if (anchors.length) {
    const cells = anchors.map((x) => ({ row: Math.round(x.scoreSec * rate), col: Math.round(x.sec * rate) })).filter((c) => c.row < ss.n && c.col < as.n);
    const fence = anchorColumnBounds(cells, ss.n, as.n, COARSE_ANCHOR_TOLERANCE);
    for (let i = 0; i < s.n; i++) {
      const l = Math.max(lo[i], fence.lo[i]);
      const h = Math.min(hi[i], fence.hi[i]);
      if (h >= l) {
        lo[i] = l;
        hi[i] = h;
      } else {
        lo[i] = fence.lo[i];
        hi[i] = fence.hi[i];
      }
    }
  }
  const path = bandedDtw((i, j) => pairCost(ss, as, i, j), s.n, lo, hi, jumpPenalty(rate));
  let mapping = pathMapping({ rows: path.rows, cols: path.cols, cost: path.cost, margin: null, startCol: path.cols[0], endCol: path.cols[path.cols.length - 1] }, rate);
  const k = mapping.score.length - 1;
  if (k >= 1 && mapping.score[k] < end) {
    const slope = (mapping.recording[k] - mapping.recording[k - 1]) / (mapping.score[k] - mapping.score[k - 1]);
    const finish = mapping.recording[k] + slope * (end - mapping.score[k]);
    if (finish <= (audio.n - 1) / audio.rate) {
      mapping.score.push(end);
      mapping.recording.push(finish);
    }
  }
  if (anchors.length) mapping = anchorMapping(mapping, anchors);
  return mapping;
}

/** Full pipeline with intermediate results (used by tests and for debugging). */
export async function alignIntegrated(
  infoMap: InfoMap,
  audio: AlignAudio,
  options: IntegratedOptions = {},
  onProgress?: AlignProgress,
  signal?: AbortSignal,
): Promise<IntegratedDetail> {
  const check = () => {
    if (signal?.aborted) throw abortError();
  };
  let lastProgress = 0;
  const progress = (p: number, message: string) => {
    check();
    lastProgress = Math.max(lastProgress, Math.round(Math.max(0, Math.min(1, p)) * 1000) / 1000);
    onProgress?.(lastProgress, message);
  };
  if (infoMap.measures.length === 0 || !(infoMap.duration > 0)) throw new Error("The score has no measures to align.");
  if (!(audio.samples.length > 0) || !(audio.sampleRate > 0)) throw new Error("The recording is empty.");
  const durationSec = audio.durationSec > 0 ? audio.durationSec : audio.samples.length / audio.sampleRate;
  if (durationSec < MIN_RECORDING_SEC || durationSec > MAX_SECONDS) throw new Error("The recording must be between 2 seconds and 40 minutes long.");
  if (infoMap.duration > MAX_SECONDS) throw new Error("The score must be at most 40 minutes long at its written tempo.");
  let peak = 0;
  for (let i = 0; i < audio.samples.length; i++) {
    const v = Math.abs(audio.samples[i]);
    if (!Number.isFinite(v)) throw new Error("The recording contains invalid samples.");
    if (v > peak) peak = v;
  }
  if (peak < 1e-7) throw new Error("The recording is silent; there is nothing to align.");

  // 1. features
  progress(0, "Reading the recording");
  await nextTick();
  const heardRaw = audioFeatures(audio.samples, audio.sampleRate, (f) => progress(f * 0.4, "Reading the recording"));
  const transpose = options.transpose ?? Object.fromEntries(infoMap.instruments.map((i) => [i.id, soundingTranspose(i)]));
  const score = withNovelty(scoreFeatures(infoMap, { transpose }));
  const heard = withNovelty(heardRaw);
  progress(0.45, "Finding the score in the recording");
  await nextTick();

  // 2. broad match over the supported extent (floor convention of the reference)
  const rate = FEATURE_RATE;
  const end = Math.min(infoMap.duration, (Math.min(Math.floor(infoMap.duration * rate), score.n) - 1) / rate);
  const anchors = cleanAnchors(options.anchors ?? []).filter((a) => a.scoreSec <= end + 1e-6 && a.sec <= durationSec);
  const broad = broadMatch(score, heard, end, anchors);
  const match = broad.match;
  progress(0.5, "Finding the score in the recording");
  await nextTick();
  // 2b. 10 Hz banded pass around the broad path (the fit's seed)
  const seed = refineSeed(score, heard, end, broad.seed, anchors);
  progress(0.55, "Fitting tempo and audio together");
  await nextTick();

  // 3. joint fit
  const clock = scoreClock(infoMap.timing?.tempo ?? [], infoMap.tempo);
  const protectedQuarters = protectedIntervals(infoMap, clock);
  const ss = scoreSide(score);
  const as = audioSide(heard);
  const fit = optimizeMapping({
    score: ss,
    audio: as,
    rate,
    seed,
    clock,
    protectedQuarters,
    anchors,
    check,
    onProgress: (f, message) => progress(0.55 + f * 0.37, message),
  });
  progress(0.93, "Scoring confidence");
  await nextTick();

  // 4. measure starts (extrapolated with the edge slope outside the fitted range) and confidence
  const m = fit.mapping;
  const last = m.score.length - 1;
  const slopeAt = (a: number, b: number) => (m.recording[b] - m.recording[a]) / (m.score[b] - m.score[a] || 1);
  const startsSec = infoMap.measures.map((ms) => {
    if (ms.startTime < m.score[0]) return m.recording[0] + (ms.startTime - m.score[0]) * slopeAt(0, Math.min(1, last));
    if (ms.startTime > m.score[last]) return m.recording[last] + (ms.startTime - m.score[last]) * slopeAt(Math.max(0, last - 1), last);
    return interp(ms.startTime, m.score, m.recording);
  });
  const placeholder = finalizeStarts(infoMap, startsSec, [], durationSec).map((a) => a.startSec);
  const confidences = integratedConfidences({
    score: ss,
    audio: as,
    rate,
    measures: infoMap.measures,
    mapping: m,
    seed,
    startsSec: placeholder,
    accepted: fit.accepted,
  });
  const auto = finalizeStarts(infoMap, startsSec, confidences, durationSec);
  const averageConfidence = Math.round(auto.reduce((s, a) => s + a.confidence, 0) / auto.length);
  progress(1, "Scoring confidence");
  const sync: SyncState = {
    method: INTEGRATED_METHOD,
    auto,
    manual: [],
    averageConfidence,
    diagnostics: {
      accepted: fit.accepted,
      converged: fit.converged,
      broadCost: round4(match.cost),
      broadMargin: match.margin == null ? null : round4(match.margin),
      acousticBefore: round4(fit.acousticBefore),
      acousticAfter: round4(fit.acousticAfter),
      maxShiftSec: round4(fit.maxShiftSec),
      knots: fit.knotCount,
      tuningCents: Math.round(heardRaw.tuning * 100),
      ...(fit.reason ? { note: fit.reason } : {}),
    },
  };
  return { sync, score, audio: heard, broad: match, broadSeed: broad.seed, seed, fit, clock, protectedQuarters };
}

function round4(v: number) {
  return Math.round(v * 1e4) / 1e4;
}

export function createIntegratedAligner(options: IntegratedOptions = {}): Aligner {
  return {
    method: INTEGRATED_METHOD,
    async align(infoMap, audio, onProgress, signal) {
      return (await alignIntegrated(infoMap, audio, options, onProgress, signal)).sync;
    },
  };
}

export const integratedAligner: Aligner = createIntegratedAligner();
