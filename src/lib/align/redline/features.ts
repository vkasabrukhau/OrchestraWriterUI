/**
 * Port of redline/features.py: features that make a recording and a score
 * comparable. Both sides are reduced, 50 times a second, to
 *
 *   chroma        (frames × 49): unit-length chroma of 4 registers + a 'silence' flag
 *   onset chroma  (frames × 24): pitch classes that just started, low and high register
 *   onset strength (frames): 0..1, how much is starting
 *
 * Matrices are row-major Float32Array (frame-major), like the float32 numpy
 * arrays of the reference.
 */
import { SR, estimateTuningLibrosa, nearestPitch, stftPowerFrames } from "./audio";
import { maximumFilter1dNearest, percentileAbs, percentileLinear, roundHalfEven, uniformFilter1d, uniformFilterRows, unitRowsInPlace } from "./numeric";
import type { RedlineScore } from "./score";

export const FPS = 50;
const HOP = Math.floor(SR / FPS);
const LOW = 36;
const HIGH = 108;
/** relative strength of the partials a single played note puts into the spectrum (semitones above, strength) */
const PARTIALS: ReadonlyArray<readonly [number, number]> = [
  [0, 1.0],
  [12, 0.6],
  [19, 0.4],
  [24, 0.3],
  [28, 0.2],
  [31, 0.15],
];
/** registers compared separately (MIDI limits): below C3, C3–B3, C4–B4, C5 and up */
const CHROMA_BANDS: ReadonlyArray<readonly [number, number]> = [
  [0, 48],
  [48, 60],
  [60, 72],
  [72, 999],
];
const ONSET_BANDS: ReadonlyArray<readonly [number, number]> = [
  [0, 60],
  [60, 999],
];
export const CHROMA_DIMS = 12 * CHROMA_BANDS.length + 1;
export const ONSET_DIMS = 12 * ONSET_BANDS.length;

export interface RedlineFeatures {
  n: number;
  chroma: Float32Array;
  onset: Float32Array;
  onsetStrength: Float32Array;
  fps: number;
}

/**
 * Pitch matrix (frames × P) → per-band pitch-class sums (frames × 12 each),
 * optionally smoothed along time (uniform_filter1d, 'nearest').
 */
function banded(matrix: Float32Array, frames: number, pitches: Int32Array, bands: ReadonlyArray<readonly [number, number]>, smooth: number): Float32Array[] {
  const P = pitches.length;
  return bands.map(([lo, hi]) => {
    const c = new Float32Array(frames * 12);
    for (let t = 0; t < frames; t++) {
      const acc = new Float64Array(12);
      const o = t * P;
      for (let p = 0; p < P; p++) {
        const midi = pitches[p];
        if (midi >= lo && midi < hi) acc[midi % 12] += matrix[o + p];
      }
      for (let k = 0; k < 12; k++) c[t * 12 + k] = acc[k];
    }
    return smooth > 1 ? uniformFilterRows(c, frames, 12, smooth, "nearest") : c;
  });
}

/**
 * Shared tail end: fold per-pitch matrices into normalised chroma / onset
 * chroma. Chroma is kept per register so a tune over a held bass still
 * changes the features; the last column is 1 where nothing sounds, so a rest
 * in the score is not a wildcard the aligner could park on for free.
 */
function finish(pitchEnergy: Float32Array, pitchOnsets: Float32Array, frames: number, pitches: Int32Array, silent: Uint8Array): RedlineFeatures {
  const parts = banded(pitchEnergy, frames, pitches, CHROMA_BANDS, 5).map((c) => {
    unitRowsInPlace(c, frames, 12);
    const s = Math.sqrt(CHROMA_BANDS.length);
    for (let i = 0; i < c.length; i++) c[i] = c[i] / s;
    return c;
  });
  const chroma = new Float32Array(frames * CHROMA_DIMS);
  for (let t = 0; t < frames; t++) {
    const o = t * CHROMA_DIMS;
    if (silent[t]) {
      chroma[o + CHROMA_DIMS - 1] = 1;
      continue;
    }
    for (let b = 0; b < parts.length; b++) for (let k = 0; k < 12; k++) chroma[o + b * 12 + k] = parts[b][t * 12 + k];
  }

  const ob = banded(pitchOnsets, frames, pitches, ONSET_BANDS, 1);
  const onset = new Float32Array(frames * ONSET_DIMS);
  for (let t = 0; t < frames; t++) for (let b = 0; b < ob.length; b++) for (let k = 0; k < 12; k++) onset[t * ONSET_DIMS + b * 12 + k] = ob[b][t * 12 + k];
  const norms = new Float32Array(frames);
  for (let t = 0; t < frames; t++) {
    let s = 0;
    for (let c = 0; c < ONSET_DIMS; c++) s += onset[t * ONSET_DIMS + c] * onset[t * ONSET_DIMS + c];
    norms[t] = Math.sqrt(s);
  }
  // judge "how much is starting" relative to the loudest onset in the surrounding 6 s,
  // so quiet passages still produce usable onsets
  const local = maximumFilter1dNearest(norms, Math.trunc(6 * FPS));
  const floor = 0.1 * percentileLinear(norms, 99) + 1e-9;
  const strength = new Float32Array(frames);
  for (let t = 0; t < frames; t++) {
    const l = Math.max(local[t], floor);
    let s = Math.min(1, Math.max(0, norms[t] / l));
    s = Math.fround(s);
    strength[t] = s < 0.1 ? 0 : s;
  }
  for (let t = 0; t < frames; t++) {
    const o = t * ONSET_DIMS;
    if (strength[t] === 0) {
      onset.fill(0, o, o + ONSET_DIMS);
      continue;
    }
    const d = Math.max(norms[t], 1e-9);
    for (let c = 0; c < ONSET_DIMS; c++) onset[o + c] = onset[o + c] / d;
  }
  return { n: frames, chroma, onset, onsetStrength: strength, fps: FPS };
}

/* ------------------------------------------------------------------ audio side */

/** (bins) → pitch index (0..HIGH−LOW−1) or −1: spectrogram bins summed into semitone bands. */
function pitchPool(nFft: number, tuning: number): Int32Array {
  const bins = nFft / 2 + 1;
  const pool = new Int32Array(bins).fill(-1);
  for (let k = 1; k < bins; k++) {
    const f = (k * SR) / nFft;
    const midi = 69 + 12 * Math.log2(f / 440) - tuning;
    const nearest = nearestPitch(midi);
    if (nearest >= LOW && nearest < HIGH) pool[k] = nearest - LOW;
  }
  return pool;
}

/** Spectrogram power (n_fft, hop 441) pooled into semitones: frames × 72. */
function pooledSpectrogram(y: Float32Array, nFft: number, tuning: number, tick?: (f: number) => void): { frames: number; m: Float32Array } {
  const pool = pitchPool(nFft, tuning);
  const P = HIGH - LOW;
  const frames = 1 + Math.floor(y.length / HOP);
  const m = new Float32Array(frames * P);
  const acc = new Float64Array(P);
  stftPowerFrames(
    y,
    nFft,
    HOP,
    (t, power) => {
      acc.fill(0);
      for (let k = 0; k < pool.length; k++) {
        const p = pool[k];
        if (p >= 0) acc[p] += Math.fround(power[k]);
      }
      const o = t * P;
      for (let p = 0; p < P; p++) m[o + p] = acc[p];
    },
    tick,
  );
  return { frames, m };
}

export interface AudioFeatureResult extends RedlineFeatures {
  tuning: number;
}

/** `y`: mono float32 at 22050 Hz. */
export function audioFeatures(y: Float32Array, tick?: (fraction: number, message: string) => void): AudioFeatureResult {
  const mid = Math.floor(y.length / 2);
  const segment = y.subarray(Math.max(0, mid - 30 * SR), Math.min(y.length, mid + 30 * SR));
  const tuning = estimateTuningLibrosa(segment, SR);
  tick?.(0.05, "Estimating tuning");
  const p999 = percentileAbs(y, 99.9);
  const scale = 1.0 / (p999 ** 2 * 4096 + 1e-12);
  const P = HIGH - LOW;
  const pitches = new Int32Array(P);
  for (let p = 0; p < P; p++) pitches[p] = LOW + p;

  // long window: clean pitch content for chroma
  const long = pooledSpectrogram(y, 4096, tuning, (f) => tick?.(0.05 + 0.55 * f, "Reading the recording"));
  const frames = long.frames;
  // "silent" = within 3 dB of the recording's own noise floor, judged on a half-second average
  const sums = new Float32Array(frames);
  for (let t = 0; t < frames; t++) {
    let s = 0;
    for (let p = 0; p < P; p++) s += long.m[t * P + p];
    sums[t] = s;
  }
  const avg = uniformFilter1d(sums, Math.floor(FPS / 2), "nearest");
  const level = new Float64Array(frames);
  let maxLevel = -Infinity;
  for (let t = 0; t < frames; t++) {
    level[t] = 10 * Math.log10(Math.fround(avg[t] + 1e-20));
    if (level[t] > maxLevel) maxLevel = level[t];
  }
  const audible: number[] = [];
  for (let t = 0; t < frames; t++) if (level[t] > maxLevel - 120) audible.push(level[t]);
  const silentBelow = percentileLinear(audible, 2) + 3.0;
  const silent = new Uint8Array(frames);
  for (let t = 0; t < frames; t++) silent[t] = level[t] < silentBelow ? 1 : 0;
  const energy = new Float32Array(frames * P);
  const k1 = 1000.0 * scale;
  for (let i = 0; i < energy.length; i++) energy[i] = Math.log1p(k1 * long.m[i]);

  // short window: sharp timing for onsets
  const short = pooledSpectrogram(y, 2048, tuning, (f) => tick?.(0.6 + 0.35 * f, "Reading the recording"));
  const k2 = 1000.0 * scale * 4;
  const sh = new Float32Array(short.frames * P);
  for (let i = 0; i < sh.length; i++) sh[i] = Math.log1p(k2 * short.m[i]);
  const onsets = new Float32Array(short.frames * P);
  // energy that appeared within 40 ms
  for (let t = 1; t < short.frames - 1; t++) {
    for (let p = 0; p < P; p++) onsets[t * P + p] = Math.max(sh[(t + 1) * P + p] - sh[(t - 1) * P + p], 0);
  }
  const n = Math.min(frames, short.frames);
  const f = finish(energy.subarray(0, n * P), onsets.subarray(0, n * P), n, pitches, silent.subarray(0, n));
  return { ...f, tuning };
}

/* ------------------------------------------------------------------ score side */

/**
 * The same features, computed from the notes.
 *
 * `toSeconds` maps score position (score seconds at the written tempo) to
 * time. By default that is the identity (the score's own nominal timing);
 * the aligner passes its current estimate of the recording's timing instead,
 * which puts the score on the recording's time axis (`nFrames` = length of
 * the recording).
 */
export function scoreFeatures(score: RedlineScore, toSeconds?: (s: Float64Array) => Float64Array, nFrames?: number): RedlineFeatures {
  const map = toSeconds ?? ((s: Float64Array) => s);
  const frames = nFrames ?? Math.ceil(map(Float64Array.of(score.total))[0] * FPS) + 1;
  const P = HIGH + 36 - LOW;
  const pitches = new Int32Array(P);
  for (let p = 0; p < P; p++) pitches[p] = LOW + p;
  const roll = new Float32Array((frames + 1) * P); // difference-coded
  const hits = new Float32Array(frames * P);

  const notes = score.notes;
  const on = map(Float64Array.from(notes, (n) => n.onset));
  const off = map(Float64Array.from(notes, (n) => n.onset + n.duration));
  for (let i = 0; i < notes.length; i++) {
    const a = Math.min(frames - 1, Math.max(0, roundHalfEven(on[i] * FPS)));
    const b = Math.max(a + 1, roundHalfEven(off[i] * FPS));
    const w = notes[i].weight;
    for (const [interval, strength] of PARTIALS) {
      const p = notes[i].pitch + interval - LOW;
      if (p >= 0 && p < P) {
        roll[a * P + p] += w * strength;
        roll[Math.min(b, frames) * P + p] -= w * strength;
        hits[a * P + p] += w * strength;
      }
    }
  }
  // float32 running sum, as numpy's cumsum on a float32 array
  const energy = new Float32Array(frames * P);
  const silent = new Uint8Array(frames);
  const run = new Float32Array(P);
  for (let t = 0; t < frames; t++) {
    let total = 0;
    for (let p = 0; p < P; p++) {
      run[p] = run[p] + roll[t * P + p];
      const e = Math.fround(Math.log1p(Math.fround(10.0 * Math.max(run[p], 0))));
      energy[t * P + p] = e;
      total += e;
    }
    silent[t] = Math.fround(total) <= 0 ? 1 : 0;
  }
  // an attack is not instantaneous in a recording: spread each hit over 60 ms
  const spread = uniformFilterRows(hits, frames, P, 3, "constant");
  for (let i = 0; i < spread.length; i++) spread[i] = Math.log1p(Math.fround(10.0 * spread[i]));
  return finish(energy, spread, frames, pitches, silent);
}

/* ------------------------------------------------------------------ coarse view */

/** Chroma averaged over `factor` frames with 50 % extra smoothing, for the rough passes. Rows × 49. */
export function coarsen(f: RedlineFeatures, factor: number): { n: number; chroma: Float32Array } {
  const smooth = uniformFilterRows(f.chroma, f.n, CHROMA_DIMS, 2 * factor, "nearest");
  const start = factor >> 1;
  const rows = f.n > start ? Math.ceil((f.n - start) / factor) : 0;
  const out = new Float32Array(rows * CHROMA_DIMS);
  for (let r = 0; r < rows; r++) out.set(smooth.subarray((start + r * factor) * CHROMA_DIMS, (start + r * factor + 1) * CHROMA_DIMS), r * CHROMA_DIMS);
  unitRowsInPlace(out, rows, CHROMA_DIMS);
  return { n: rows, chroma: out };
}
