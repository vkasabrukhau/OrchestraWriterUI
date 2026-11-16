/**
 * Chroma-DTW aligner behind the shared Aligner interface (src/shared/sync.ts).
 *
 *   recording ──audioChroma──▶ Y (recording time)
 *   info map  ──scoreChroma──▶ X (score time, resampled so X and the sounding
 *                                 part of Y have about the same length)
 *   dtw(X, Y) with open begin/end ──▶ warping path
 *   path ──▶ measure starts (recording seconds) + per-measure confidence
 *
 * The method is a prototype candidate (STATE.md open question 2); keep it
 * behind `Aligner` so it can be swapped. Manual markers arrive as anchors
 * (ADR 0021): the band runs through them, the path may not cross them, and
 * the measure starts are re-timed to pass through them exactly.
 */
import type { InfoMap } from "@/shared/info-map";
import type { AlignAudio, AlignProgress, Aligner, MeasureAlignment, SyncState } from "@/shared/sync";
import { DEFAULT_HOP_SEC, PITCH_CLASSES, activeRange, audioChroma, type ChromaFeatures } from "./chroma";
import { measureConfidences } from "./confidence";
import { dtw, type DtwResult } from "./dtw";
import { scoreChroma } from "./score-chroma";
import { soundingTranspose } from "@/shared/score/transpose";
import { anchorMapping, cleanAnchors, type AlignAnchor } from "./anchors";
import { interp } from "./integrated/signal";

export const CHROMA_DTW_METHOD = "chroma-dtw";
/** minimum spacing between consecutive measure starts (recording seconds) */
export const MIN_MEASURE_GAP_SEC = 0.01;

export interface ChromaDtwOptions {
  /** recording seconds between chroma frames (default 2048 / 22050 ≈ 93 ms) */
  hopSec?: number;
  /** Sakoe–Chiba band radius as a fraction of the longer sequence (default 0.2) */
  bandFraction?: number;
  /** score rows on each side used to smooth the path when reading a measure start (default 4) */
  smoothRows?: number;
  /** semitones from written to sounding pitch per part id (default: the parser's <transpose> per part) */
  transpose?: Record<string, number>;
  /** manual markers as score/recording pairs in this score and audio (ADR 0021) */
  anchors?: AlignAnchor[];
}

export interface ChromaDtwDetail {
  sync: SyncState;
  audio: ChromaFeatures;
  score: ChromaFeatures;
  path: DtwResult;
  /** recording frames where sound starts / ends */
  active: { first: number; last: number };
}

function abortError(): Error {
  return typeof DOMException !== "undefined" ? new DOMException("Alignment cancelled", "AbortError") : Object.assign(new Error("Alignment cancelled"), { name: "AbortError" });
}

const nextTick = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

/** Full pipeline with intermediate results (used by tests and for debugging). */
export async function alignChromaDtw(
  infoMap: InfoMap,
  audio: AlignAudio,
  options: ChromaDtwOptions = {},
  onProgress?: AlignProgress,
  signal?: AbortSignal,
): Promise<ChromaDtwDetail> {
  const check = () => {
    if (signal?.aborted) throw abortError();
  };
  let lastProgress = 0;
  const progress = (p: number, message: string) => {
    check();
    // rounded and never decreasing, so progress bars don't jitter
    lastProgress = Math.max(lastProgress, Math.round(Math.max(0, Math.min(1, p)) * 1000) / 1000);
    onProgress?.(lastProgress, message);
  };
  if (infoMap.measures.length === 0 || !(infoMap.duration > 0)) throw new Error("The score has no measures to align.");
  if (!(audio.samples.length > 0) || !(audio.sampleRate > 0)) throw new Error("The recording is empty.");

  // 1. chroma of the recording
  progress(0, "Computing chroma");
  await nextTick();
  const audioFeat = audioChroma(audio.samples, audio.sampleRate, {
    hopSec: options.hopSec ?? DEFAULT_HOP_SEC,
    onProgress: (f) => progress(f * 0.4, "Computing chroma"),
  });
  const active = activeRange(audioFeat.energy);
  if (!active) throw new Error("The recording is silent; there is nothing to align.");

  // 2. chroma of the score on a grid scaled to the sounding part of the recording
  const nScore = Math.max(8, active.last - active.first + 1);
  const scoreHopSec = infoMap.duration / (nScore - 1);
  const transpose = options.transpose ?? Object.fromEntries(infoMap.instruments.map((i) => [i.id, soundingTranspose(i)]));
  const scoreFeat = scoreChroma(infoMap, { hopSec: scoreHopSec, n: nScore, transpose });
  progress(0.45, "Warping");
  await nextTick();

  // 3. DTW: band around the line from sound start to sound end, enlarged by the lead-in
  const uniform = 1 / Math.sqrt(PITCH_CLASSES);
  const skipCost = new Float32Array(audioFeat.n);
  for (let j = 0; j < audioFeat.n; j++) {
    let s = 0;
    for (let c = 0; c < PITCH_CLASSES; c++) s += audioFeat.frames[j * PITCH_CLASSES + c];
    skipCost[j] = 1 - s * uniform;
  }
  const bandFraction = options.bandFraction ?? 0.2;
  const radius = Math.ceil(bandFraction * Math.max(nScore, audioFeat.n)) + active.first;
  const durationSec = audio.durationSec > 0 ? audio.durationSec : audio.samples.length / audio.sampleRate;
  const anchors = cleanAnchors(options.anchors ?? []).filter((a) => a.scoreSec <= infoMap.duration + 1e-6 && a.sec <= durationSec);
  const path = dtw(scoreFeat.frames, audioFeat.frames, {
    radius,
    startCenter: active.first,
    endCenter: active.last,
    skipCost,
    anchors: anchors.map((a) => ({ row: Math.round(a.scoreSec / scoreHopSec), col: Math.round(a.sec / audioFeat.hopSec) })),
    onProgress: (f) => progress(0.45 + f * 0.4, "Warping"),
  });
  progress(0.85, "Scoring confidence");
  await nextTick();

  // 4. measure starts from the path, then confidence
  let startsSec = readMeasureStarts(path, infoMap, scoreHopSec, audioFeat.hopSec, options.smoothRows ?? 4);
  if (anchors.length) startsSec = pinStarts(infoMap, startsSec, anchors);
  const confidences = measureConfidences({
    path,
    scoreFrames: scoreFeat.frames,
    scoreEnergy: scoreFeat.energy,
    audioFrames: audioFeat.frames,
    audioN: audioFeat.n,
    scoreHopSec,
    audioHopSec: audioFeat.hopSec,
    measures: infoMap.measures,
    startsSec,
  });
  const auto = finalizeStarts(infoMap, startsSec, confidences, durationSec);
  const averageConfidence = Math.round(auto.reduce((s, a) => s + a.confidence, 0) / auto.length);
  progress(1, "Scoring confidence");
  return { sync: { method: CHROMA_DTW_METHOD, auto, manual: [], averageConfidence }, audio: audioFeat, score: scoreFeat, path, active };
}

/**
 * Recording time of each measure start: for every score row, the mean path
 * column; a local least-squares line over ±smoothRows rows removes the
 * one-frame jitter of the path before reading the value at the measure start.
 */
export function readMeasureStarts(path: DtwResult, infoMap: InfoMap, scoreHopSec: number, audioHopSec: number, smoothRows: number): number[] {
  const n = path.rows[path.rows.length - 1] + 1;
  const colAt = new Float64Array(n);
  const count = new Int32Array(n);
  for (let k = 0; k < path.rows.length; k++) {
    colAt[path.rows[k]] += path.cols[k];
    count[path.rows[k]]++;
  }
  for (let r = 0; r < n; r++) colAt[r] = count[r] > 0 ? colAt[r] / count[r] : r > 0 ? colAt[r - 1] : 0;

  return infoMap.measures.map((m) => {
    const f = Math.min(n - 1, Math.max(0, m.startTime / scoreHopSec));
    const r0 = Math.max(0, Math.floor(f) - smoothRows);
    const r1 = Math.min(n - 1, Math.ceil(f) + smoothRows);
    let col: number;
    if (smoothRows > 0 && r1 - r0 >= 2) {
      let sx = 0;
      let sy = 0;
      let sxx = 0;
      let sxy = 0;
      const k = r1 - r0 + 1;
      for (let r = r0; r <= r1; r++) {
        sx += r;
        sy += colAt[r];
        sxx += r * r;
        sxy += r * colAt[r];
      }
      const den = k * sxx - sx * sx;
      const slope = den !== 0 ? (k * sxy - sx * sy) / den : 0;
      col = (sy - slope * sx) / k + slope * f;
    } else {
      const a = Math.floor(f);
      const b = Math.min(n - 1, a + 1);
      col = colAt[a] + (colAt[b] - colAt[a]) * (f - a);
    }
    return col * audioHopSec;
  });
}

/** Measure starts re-timed through the anchors (proportionally between them, as mergeAlignment does). */
export function pinStarts(infoMap: InfoMap, startsSec: number[], anchors: AlignAnchor[]): number[] {
  const score = infoMap.measures.map((m) => m.startTime);
  const recording: number[] = [];
  for (let k = 0; k < startsSec.length; k++) recording.push(k > 0 ? Math.max(startsSec[k], recording[k - 1]) : startsSec[k]);
  const pinned = anchorMapping({ score, recording }, anchors);
  return score.map((s) => interp(s, pinned.score, pinned.recording));
}

/** Clamp to [0, duration], force strictly increasing starts (≥ 10 ms apart), round to ms. */
export function finalizeStarts(infoMap: InfoMap, startsSec: number[], confidences: number[], durationSec: number): MeasureAlignment[] {
  const count = startsSec.length;
  const gapMs = Math.round(MIN_MEASURE_GAP_SEC * 1000);
  const durMs = Math.floor(durationSec * 1000);
  const ms = startsSec.map((s) => Math.max(0, Math.min(durMs, Math.round(s * 1000))));
  for (let k = 1; k < count; k++) if (ms[k] < ms[k - 1] + gapMs) ms[k] = ms[k - 1] + gapMs;
  for (let k = count - 1; k >= 0; k--) {
    const cap = durMs - gapMs * (count - 1 - k);
    if (ms[k] > cap) ms[k] = Math.max(0, cap);
  }
  return infoMap.measures.map((m, k) => ({
    n: m.number,
    startSec: ms[k] / 1000,
    confidence: Math.max(0, Math.min(100, Math.round(confidences[k] ?? 0))),
  }));
}

export function createChromaDtwAligner(options: ChromaDtwOptions = {}): Aligner {
  return {
    method: CHROMA_DTW_METHOD,
    async align(infoMap, audio, onProgress, signal) {
      const detail = await alignChromaDtw(infoMap, audio, options, onProgress, signal);
      return detail.sync;
    },
  };
}

export const chromaDtwAligner: Aligner = createChromaDtwAligner();
