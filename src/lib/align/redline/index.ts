/**
 * redline: score-to-audio alignment by dynamic time warping, coarse then
 * fine. TypeScript port of the syncing part of redline-sync 0.1.0 (Python:
 * redline/features.py, redline/align.py). Rendering, engraving and the
 * timing check of that library are not ported.
 *
 *   recording ──resample 22050──▶ chroma (4 registers + silence) · onset chroma · onset strength
 *   info map  ──notes──────────▶ the same features, computed from the notes
 *
 *   pass 0  2 frames/s, harmony only, printed tempi, free ends  ──▶ rough estimate (σ 6 s)
 *   pass 1  10 frames/s ±15 s, score laid on the recording's time axis, toll 0.3
 *   pass 2  50 frames/s ±5 s, + onsets
 *   pass 3  50 frames/s ±1.5 s, + onsets
 *   ──▶ recording time of every note onset and barline
 *
 * On top of the reference: measure starts are read from that table and given
 * the integrated aligner's per-measure confidence (ADR 0014), scored against
 * the redline result, so the Sync page can show it. Manual markers are not
 * handled (this is an accuracy experiment).
 */
import type { InfoMap } from "@/shared/info-map";
import type { AlignAudio, AlignProgress, Aligner, SyncState } from "@/shared/sync";
import { soundingTranspose } from "@/shared/score/transpose";
import { finalizeStarts } from "../index";
import { integratedConfidences } from "../integrated/confidence";
import { audioSide, scoreSide } from "../integrated/cost";
import { audioFeatures as integratedAudioFeatures, scoreFeatures as integratedScoreFeatures, withNovelty, FEATURE_RATE } from "../integrated/features";
import { SR, resampleTo } from "./audio";
import { bandDtw } from "./dtw";
import { CHROMA_DIMS, FPS, ONSET_DIMS, audioFeatures, coarsen, scoreFeatures } from "./features";
import { gaussianFilter1dNearest, maximumAccumulate, median, npInterp, npInterpArray, npRound } from "./numeric";
import { redlineScore } from "./score";

export const REDLINE_METHOD = "redline";

export interface RedlineOptions {
  onsetWeight?: number;
  toll?: number;
  skip?: number;
  /** (frames per second, half-width of the search band in s, blur applied to the result in s) */
  passes?: ReadonlyArray<readonly [number, number, number]>;
  /** log the pass summaries (the reference's verbose output) */
  verbose?: boolean;
}

export const REDLINE_PASSES: ReadonlyArray<readonly [number, number, number]> = [
  [10, 15.0, 2.0],
  [50, 5.0, 0.5],
  [50, 1.5, 0.06],
];

export interface RedlineDetail {
  sync: SyncState;
  /** anchors: score seconds (every note onset and barline) and their recording seconds */
  quarters: Float64Array;
  seconds: Float64Array;
  measures: Array<{ number: number; scoreSec: number; seconds: number }>;
  meta: Record<string, unknown>;
}

function abortError(): Error {
  return typeof DOMException !== "undefined" ? new DOMException("Alignment cancelled", "AbortError") : Object.assign(new Error("Alignment cancelled"), { name: "AbortError" });
}

const nextTick = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

function uniqueSorted(values: number[]): number[] {
  const s = [...values].sort((a, b) => a - b);
  const out: number[] = [];
  for (const v of s) if (out.length === 0 || v !== out[out.length - 1]) out.push(v);
  return out;
}

export async function alignRedline(infoMap: InfoMap, audio: AlignAudio, options: RedlineOptions = {}, onProgress?: AlignProgress, signal?: AbortSignal): Promise<RedlineDetail> {
  const { onsetWeight = 1.0, toll = 0.3, skip = 0.6, passes = REDLINE_PASSES, verbose = false } = options;
  const log = verbose ? (msg: string) => console.info(`[redline] ${msg}`) : () => {};
  const check = () => {
    if (signal?.aborted) throw abortError();
  };
  let lastProgress = 0;
  const progress = (p: number, message: string) => {
    check();
    lastProgress = Math.max(lastProgress, Math.round(Math.max(0, Math.min(1, p)) * 1000) / 1000);
    onProgress?.(lastProgress, message);
  };
  if (infoMap.measures.length === 0) throw new Error("The score has no measures to align.");
  if (!(audio.samples.length > 0) || !(audio.sampleRate > 0)) throw new Error("The recording is empty.");
  const score = redlineScore(infoMap);
  if (score.notes.length === 0) throw new Error("The score has no pitched notes to align.");

  progress(0, "Reading the recording");
  await nextTick();
  const y = resampleTo(audio.samples, audio.sampleRate, SR);
  const fa = audioFeatures(y, (f, msg) => progress(0.02 + f * 0.3, msg));
  const m = fa.n;

  // ---- pass 0: rough, on the printed tempi
  progress(0.33, "Finding the music in the recording");
  await nextTick();
  let fs = scoreFeatures(score);
  const coarseHz = 2.0;
  const factor = Math.round(FPS / coarseHz);
  const xc = coarsen(fs, factor);
  const yc = coarsen(fa, factor);
  const rough = bandDtw({
    xc: xc.chroma,
    yc: yc.chroma,
    dims: CHROMA_DIMS,
    n: xc.n,
    m: yc.n,
    lo: new Int32Array(xc.n),
    width: yc.n,
    onsetWeight: 0.0,
    detour: 0.1,
    skip,
    tick: (f) => progress(0.33 + f * 0.07, "Finding the music in the recording"),
  });
  log(`rough pass: music found at ${(rough.pj[0] / coarseHz).toFixed(1)}s .. ${(rough.pj[rough.pj.length - 1] / coarseHz).toFixed(1)}s of ${(y.length / SR).toFixed(1)}s`);

  // the running estimate: recording time T at a fixed grid of score positions Q
  const nominal = score.total;
  const gridLen = Math.ceil((nominal + 1e-9 - 0.0) / (1.0 / FPS));
  const grid = new Float64Array(gridLen);
  for (let i = 0; i < gridLen; i++) grid[i] = i * (1.0 / FPS);
  const Q = Float64Array.from(grid);
  Q[gridLen - 1] = score.total;
  const ci = Float64Array.from(rough.pi, (v) => v + 0.5);
  const cj = Float64Array.from(rough.pj, (v) => (v + 0.5) / coarseHz);
  let T: Float64Array = npInterpArray(
    grid.map((g) => g * coarseHz),
    ci,
    cj,
  );
  T = gaussianFilter1dNearest(T, 6.0 * FPS);
  const seed = { score: Array.from(Q), recording: Array.from(T) };

  // ---- passes 1..n: on the recording's time axis
  let total = 0;
  let steps = 1;
  for (let p = 0; p < passes.length; p++) {
    const [fps, band, blur] = passes[p];
    const base = 0.4 + (p / passes.length) * 0.45;
    const span = 0.45 / passes.length;
    progress(base, `Matching at ${fps} frames/s`);
    await nextTick();
    T = maximumAccumulate(T);
    const Tnow = T;
    fs = scoreFeatures(score, (q) => npInterpArray(q, Q, Tnow), m);
    let n: number;
    let path;
    const radius = Math.trunc(band * fps);
    if (fps < FPS) {
      const f = Math.round(FPS / fps);
      const x = coarsen(fs, f);
      const yy = coarsen(fa, f);
      n = Math.min(x.n, yy.n);
      const lo = new Int32Array(n);
      for (let i = 0; i < n; i++) lo[i] = i - radius;
      path = bandDtw({
        xc: x.chroma.subarray(0, n * CHROMA_DIMS),
        yc: yy.chroma.subarray(0, n * CHROMA_DIMS),
        dims: CHROMA_DIMS,
        n,
        m: n,
        lo,
        width: 2 * radius + 1,
        onsetWeight: 0.0,
        detour: toll,
        skip: -1.0,
        tick: (fr) => progress(base + fr * span, `Matching at ${fps} frames/s`),
      });
    } else {
      n = m;
      const lo = new Int32Array(n);
      for (let i = 0; i < n; i++) lo[i] = i - radius;
      path = bandDtw({
        xc: fs.chroma,
        yc: fa.chroma,
        dims: CHROMA_DIMS,
        n,
        m,
        xo: fs.onset,
        yo: fa.onset,
        odims: ONSET_DIMS,
        xs: fs.onsetStrength,
        ys: fa.onsetStrength,
        lo,
        width: 2 * radius + 1,
        onsetWeight,
        detour: toll,
        skip: -1.0,
        tick: (fr) => progress(base + fr * span, `Matching at ${fps} frames/s`),
      });
    }
    total = path.cost;
    steps = path.pi.length;
    // recording frame at which the path first reaches each score-axis frame
    const first = new Float64Array(n);
    for (let k = path.pi.length - 1; k >= 0; k--) first[path.pi[k]] = path.pj[k];
    const moved = gaussianFilter1dNearest(first, Math.max(blur * fps, 1e-3));
    for (let i = 0; i < n; i++) moved[i] /= fps;
    const shift = new Float64Array(n);
    let maxShift = 0;
    for (let i = 0; i < n; i++) {
      shift[i] = Math.abs(moved[i] - i / fps);
      if (shift[i] > maxShift) maxShift = shift[i];
    }
    const axis = new Float64Array(n);
    for (let i = 0; i < n; i++) axis[i] = i;
    T = npInterpArray(
      T.map((v) => v * fps),
      axis,
      moved,
    );
    log(`pass at ${fps} frames/s, +-${band}s: moved the estimate by ${Math.round(median(shift) * 1000)} ms median, ${maxShift.toFixed(2)}s max`);
  }

  // ---- anchors: every position where a note starts, plus every barline and the very end
  progress(0.86, "Reading note times");
  T = maximumAccumulate(T);
  const onsets = uniqueSorted(score.notes.map((n) => npRound(n.onset, 5)));
  const bars = [...score.barStarts, score.total];
  const q = Float64Array.from(uniqueSorted([...onsets, ...bars].map((v) => npRound(v, 5))));
  const t = maximumAccumulate(npInterpArray(q, Q, T));
  const measures = infoMap.measures.map((b) => ({
    number: b.number,
    scoreSec: b.startTime,
    seconds: npRound(npInterp(b.startTime, q, t), 4),
  }));

  // ---- on top of the reference: measure starts and the integrated confidence
  progress(0.88, "Scoring confidence");
  await nextTick();
  const durationSec = audio.durationSec > 0 ? audio.durationSec : audio.samples.length / audio.sampleRate;
  const startsSec = infoMap.measures.map((b) => npInterp(b.startTime, q, t));
  const transpose = Object.fromEntries(infoMap.instruments.map((i) => [i.id, soundingTranspose(i)]));
  const ss = scoreSide(withNovelty(integratedScoreFeatures(infoMap, { transpose })));
  const as = audioSide(withNovelty(integratedAudioFeatures(audio.samples, audio.sampleRate, (f) => progress(0.88 + f * 0.1, "Scoring confidence"))));
  const placeholder = finalizeStarts(infoMap, startsSec, [], durationSec).map((a) => a.startSec);
  const confidences = integratedConfidences({
    score: ss,
    audio: as,
    rate: FEATURE_RATE,
    measures: infoMap.measures,
    mapping: { score: Array.from(q), recording: Array.from(t) },
    seed,
    startsSec: placeholder,
    accepted: true,
  });
  const auto = finalizeStarts(infoMap, startsSec, confidences, durationSec);
  const averageConfidence = Math.round(auto.reduce((s, a) => s + a.confidence, 0) / auto.length);
  progress(1, "Scoring confidence");

  const meta = {
    library: "redline 0.1.0 (TypeScript port)",
    fps: FPS,
    onset_weight: onsetWeight,
    toll,
    skip,
    passes: passes.map((p) => [...p]),
    path_cost_per_step: Math.round((total / steps) * 1e4) / 1e4,
    audio_duration: Math.round((y.length / SR) * 1000) / 1000,
  };
  return {
    sync: { method: REDLINE_METHOD, auto, manual: [], averageConfidence },
    quarters: q,
    seconds: t,
    measures,
    meta,
  };
}

export function createRedlineAligner(options: RedlineOptions = {}): Aligner {
  return {
    method: REDLINE_METHOD,
    async align(infoMap, audio, onProgress, signal) {
      return (await alignRedline(infoMap, audio, options, onProgress, signal)).sync;
    },
  };
}
