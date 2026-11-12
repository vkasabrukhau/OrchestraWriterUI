/**
 * Features for the integrated aligner, on one 50 Hz frame clock per side
 * (score time for the score, recording time for the recording). Ported from
 * "Integrated tempo from original search", sections 6.1–6.5 of
 * docs/research/score-sync-lab/INTEGRATED_FROM_ORIGINAL_GUIDE.md.
 *
 *   chroma   pitch-class energy folded and quantized like Sync Toolbox
 *            (L1 normalize, thresholds 0.40/0.20/0.10/0.05 × 0.25 each)
 *   level    expected (score) or heard (recording) loudness, 0–1
 *   attack   expected or heard note attacks, 0–1
 *   rest     score only: no part is sounding (staccato shortened)
 *   novelty  "something changes here" from 2 s and 8 s chroma checkerboards
 *            plus loudness change, computed at 5 Hz
 *
 * Differences from the Python reference (it uses Sync Toolbox's IIR pitch
 * filterbank and librosa): recording pitch energy comes from a 186 ms Hann
 * STFT, and the score's loudness model reads the info map's per-note written
 * dynamics instead of music21 dynamics and hairpins.
 */
import type { Dynamic } from "@/shared/dynamics";
import type { InfoMap, StyleMarking } from "@/shared/info-map";
import { RealFftPair, downsample, fft, gradient, interp, maximumFilter, nextPow2, percentile, uniformFilter } from "./signal";

export const FEATURE_RATE = 50;
export const PCS = 12;
/** Sync Toolbox quantize_chroma defaults */
const QUANT_STEPS = [0.4, 0.2, 0.1, 0.05];
const QUANT_WEIGHT = 0.25;
/** L1 norm below which a frame becomes the uniform vector (Sync Toolbox normalize_feature) */
const NORM_THRESHOLD = 0.001;
/** recording analysis rate (librosa.load(sr=22050) in the reference) */
const ANALYSIS_RATE = 22050;
/** samples in Sync Toolbox's 40 ms energy window at its 4410 Hz middle-register rate */
const STMSP_WINDOW_SAMPLES = 0.04 * 4410;
/** sounding MIDI range used for pitch features */
const MIDI_LO = 21;
const MIDI_HI = 108;

export interface SyncFeatures {
  /** frames per second */
  rate: number;
  n: number;
  /** quantized chroma, frame-major (frames[j * 12 + pc]) */
  chroma: Float32Array;
  level: Float32Array;
  attack: Float32Array;
  /** 1 where the score predicts that every part is resting (always 0 for the recording) */
  rest: Uint8Array;
  novelty: Float32Array;
  /** 1 where both structural contexts (±8 s) are inside the piece */
  noveltyValid: Uint8Array;
}

export type Tick = (fraction: number) => void;

/* ------------------------------------------------------------------ */
/* Shared steps                                                         */
/* ------------------------------------------------------------------ */

/** quantize_chroma(pitch_to_chroma(...)) on raw pitch-class energies, in place. */
export function quantizeChroma(raw: Float32Array, n: number): void {
  for (let j = 0; j < n; j++) {
    const o = j * PCS;
    let l1 = 0;
    for (let c = 0; c < PCS; c++) l1 += Math.abs(raw[o + c]);
    for (let c = 0; c < PCS; c++) {
      const v = l1 < NORM_THRESHOLD ? 1 / PCS : Math.abs(raw[o + c]) / l1;
      let q = 0;
      for (const step of QUANT_STEPS) if (v > step) q += QUANT_WEIGHT;
      raw[o + c] = q;
    }
  }
}

/** scale_envelope: log1p, 5th–95th percentile to 0–1. */
export function scaleEnvelope(x: ArrayLike<number>): Float32Array {
  const y = Float32Array.from(x as ArrayLike<number>, (v) => Math.log1p(Math.max(v, 0)));
  const lo = percentile(y, 5);
  const hi = percentile(y, 95);
  const span = Math.max(hi - lo, 1e-8);
  for (let i = 0; i < y.length; i++) y[i] = Math.max(0, Math.min(1, (y[i] - lo) / span));
  return y;
}

/** attack_envelope: log1p, divided by the 95th percentile of the positive values. */
export function attackEnvelope(x: ArrayLike<number>): Float32Array {
  const y = Float32Array.from(x as ArrayLike<number>, (v) => Math.log1p(Math.max(v, 0)));
  const positive = y.filter((v) => v > 0);
  const ref = Math.max(positive.length > 0 ? percentile(positive, 95) : 0, 1e-8);
  for (let i = 0; i < y.length; i++) y[i] = Math.max(0, Math.min(1, y[i] / ref));
  return y;
}

/* ------------------------------------------------------------------ */
/* Score                                                                */
/* ------------------------------------------------------------------ */

/** Dynamic strength per written marking (music21-like volume scalars). */
export const DYNAMIC_STRENGTH: Record<Dynamic, number> = {
  pp: 0.25,
  p: 0.35,
  mp: 0.5,
  mf: 0.65,
  f: 0.75,
  ff: 0.85,
  fff: 0.95,
};

function accentFactor(style: StyleMarking | null): number {
  if (style === "Marcato") return 2.2;
  if (style === "Accent") return 1.8;
  return 1;
}

export interface ScoreFeatureOptions {
  /** semitones from written to sounding pitch per part id */
  transpose: Record<string, number>;
}

/**
 * Direct score features (no synthesis): pitch occupancy folded to chroma, and
 * the expected loudness / attack / rest profiles (section 6.3).
 */
export function scoreFeatures(infoMap: InfoMap, options: ScoreFeatureOptions): Omit<SyncFeatures, "novelty" | "noveltyValid"> {
  const rate = FEATURE_RATE;
  const n = Math.ceil(infoMap.duration * rate) + 1;
  const chroma = new Float32Array(n * PCS);
  const envelope = new Float64Array(n);
  const attacks = new Float64Array(n);
  const sounding = new Float64Array(n);
  const attackFrames = Math.max(1, Math.round(0.06 * rate));
  const accentFrames = Math.max(1, Math.round(0.08 * rate));

  for (const inst of infoMap.instruments) {
    const shift = options.transpose[inst.id] ?? 0;
    const notes = [...inst.notes].filter((nt) => nt.duration > 0).sort((a, b) => a.time - b.time);

    // pitch occupancy (every note counts once, velocity ignored)
    for (const nt of notes) {
      const pitch = nt.pitch + shift;
      if (pitch < MIDI_LO || pitch > MIDI_HI) continue;
      let j0 = Math.ceil(nt.time * rate - 1e-9);
      let j1 = Math.ceil((nt.time + nt.duration) * rate - 1e-9) - 1;
      if (j1 < j0) j0 = j1 = Math.floor(nt.time * rate);
      const pc = ((pitch % 12) + 12) % 12;
      for (let j = Math.max(0, j0); j <= Math.min(n - 1, j1); j++) chroma[j * PCS + pc] += 1;
    }

    // dynamic strength: the written dynamic of the latest note onset, 0.5 before the first
    const strength = new Float64Array(n).fill(0.5);
    for (const nt of notes) {
      const j = Math.max(0, Math.min(n - 1, Math.ceil(nt.time * rate - 1e-9)));
      strength.fill(DYNAMIC_STRENGTH[nt.dynamics], j);
    }

    // chord tones sharing an onset form one attack event
    const events = new Map<number, { count: number; accent: number }>();
    const activity = new Float64Array(n);
    for (const nt of notes) {
      const accent = accentFactor(nt.styleMarking);
      let end = nt.time + nt.duration;
      if (nt.styleMarking === "Staccato") end = nt.time + nt.duration * 0.5;
      const lo = Math.max(0, Math.floor(nt.time * rate));
      const hi = Math.min(n, Math.ceil(end * rate));
      for (let j = lo; j < hi; j++) {
        activity[j] += 1;
        sounding[j] += 1;
      }
      if (hi > lo) {
        const ev = events.get(lo) ?? { count: 0, accent: 1 };
        ev.count += 1;
        ev.accent = Math.max(ev.accent, accent);
        events.set(lo, ev);
        if (accent > 1) for (let j = lo; j < Math.min(hi, lo + accentFrames); j++) activity[j] += accent - 1;
      }
    }
    for (const [lo, ev] of events) {
      const amplitude = Math.sqrt(ev.count) * strength[lo] ** 2 * ev.accent;
      for (let k = 0; k < attackFrames && lo + k < n; k++) attacks[lo + k] += amplitude * (1 - k / attackFrames);
    }
    for (let j = 0; j < n; j++) envelope[j] += Math.sqrt(activity[j]) * strength[j] ** 2;
  }

  quantizeChroma(chroma, n);
  const rest = new Uint8Array(n);
  for (let j = 0; j < n; j++) rest[j] = sounding[j] === 0 ? 1 : 0;
  return { rate, n, chroma, level: scaleEnvelope(envelope), attack: attackEnvelope(attacks), rest };
}

/* ------------------------------------------------------------------ */
/* Recording                                                            */
/* ------------------------------------------------------------------ */

/** Global tuning offset in semitones (−0.5…0.5) from spectral peaks. */
export function estimateTuning(x: Float32Array, sr: number): number {
  const size = nextPow2(Math.round(sr * 0.186));
  const frames = Math.floor((x.length - size) / size);
  if (frames < 1) return 0;
  const step = Math.max(1, Math.floor(frames / 400));
  const window = hann(size);
  const re = new Float64Array(size);
  const im = new Float64Array(size);
  const k0 = Math.max(2, Math.ceil((100 * size) / sr));
  const k1 = Math.min(size / 2 - 2, Math.floor((2000 * size) / sr));
  let sx = 0;
  let sy = 0;
  for (let f = 0; f < frames; f += step) {
    const start = f * size;
    for (let i = 0; i < size; i++) {
      re[i] = x[start + i] * window[i];
      im[i] = 0;
    }
    fft(re, im);
    let maxMag = 0;
    const mag = new Float64Array(k1 + 2);
    for (let k = k0 - 1; k <= k1 + 1; k++) {
      mag[k] = Math.hypot(re[k], im[k]);
      if (mag[k] > maxMag) maxMag = mag[k];
    }
    if (maxMag <= 0) continue;
    for (let k = k0; k <= k1; k++) {
      const m = mag[k];
      if (m < 0.1 * maxMag || m <= mag[k - 1] || m < mag[k + 1]) continue;
      const a = Math.log(mag[k - 1] + 1e-12);
      const b = Math.log(m + 1e-12);
      const c = Math.log(mag[k + 1] + 1e-12);
      const den = a - 2 * b + c;
      const offset = den !== 0 ? (0.5 * (a - c)) / den : 0;
      const hz = ((k + offset) * sr) / size;
      const midi = 69 + 12 * Math.log2(hz / 440);
      const dev = midi - Math.round(midi);
      sx += m * Math.cos(2 * Math.PI * dev);
      sy += m * Math.sin(2 * Math.PI * dev);
    }
  }
  if (sx === 0 && sy === 0) return 0;
  return Math.atan2(sy, sx) / (2 * Math.PI);
}

function hann(size: number): Float64Array {
  const w = new Float64Array(size);
  for (let i = 0; i < size; i++) w[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / size);
  return w;
}

interface MelBand {
  /** first FFT bin with a nonzero weight */
  start: number;
  weights: Float32Array;
}

/** Slaney mel filterbank (librosa.filters.mel defaults), stored as each band's nonzero bin range. */
function melFilterbank(sr: number, size: number, nMels: number): MelBand[] {
  const fSp = 200 / 3;
  const minLogHz = 1000;
  const minLogMel = minLogHz / fSp;
  const logStep = Math.log(6.4) / 27;
  const toMel = (f: number) => (f >= minLogHz ? minLogMel + Math.log(f / minLogHz) / logStep : f / fSp);
  const toHz = (m: number) => (m >= minLogMel ? minLogHz * Math.exp(logStep * (m - minLogMel)) : fSp * m);
  const maxMel = toMel(sr / 2);
  const pts = Array.from({ length: nMels + 2 }, (_, i) => toHz((maxMel * i) / (nMels + 1)));
  const bins = size / 2 + 1;
  const bands: MelBand[] = [];
  for (let m = 0; m < nMels; m++) {
    const row = new Float32Array(bins);
    const enorm = 2 / (pts[m + 2] - pts[m]);
    let first = -1;
    let last = -1;
    for (let k = 0; k < bins; k++) {
      const f = (k * sr) / size;
      const lower = (f - pts[m]) / (pts[m + 1] - pts[m]);
      const upper = (pts[m + 2] - f) / (pts[m + 2] - pts[m + 1]);
      row[k] = Math.max(0, Math.min(lower, upper)) * enorm;
      if (row[k] !== 0) {
        if (first < 0) first = k;
        last = k;
      }
    }
    bands.push(first < 0 ? { start: 0, weights: new Float32Array(0) } : { start: first, weights: row.slice(first, last + 1) });
  }
  return bands;
}

/**
 * Recording features: tuned pitch-class energy at 50 Hz, RMS loudness and
 * mel spectral-flux attacks (librosa rms / onset_strength, hop 220 at 22050 Hz).
 */
export function audioFeatures(samples: Float32Array, sampleRate: number, tick?: Tick): Omit<SyncFeatures, "novelty" | "noveltyValid"> & { tuning: number } {
  const down = downsample(samples, sampleRate, ANALYSIS_RATE);
  const x = down.samples;
  const sr = down.sampleRate;
  const rate = FEATURE_RATE;
  const n = Math.floor((x.length * rate) / sr) + 1;
  const tuning = estimateTuning(x, sr);
  tick?.(0.05);

  // 1. pitch-class energy, 186 ms Hann window centered on each 20 ms frame
  const size = nextPow2(Math.round(sr * 0.186));
  const window = hann(size);
  let w2 = 0;
  for (let i = 0; i < size; i++) w2 += window[i] * window[i];
  // Sync Toolbox's STMSP sums squared filter output over a 2-hop (40 ms) window
  // at the pitch band's own rate (4410 Hz for the middle register), so its
  // 0.001 silence threshold sits near −50 dBFS. Mean-square power × that
  // window length puts this STFT on the same scale.
  const calib = (2 / (size * w2)) * STMSP_WINDOW_SAMPLES;
  const binPc: number[] = [];
  const binWeight: number[] = [];
  const binIndex: number[] = [];
  for (let k = 1; k < size / 2; k++) {
    const hz = (k * sr) / size;
    const midi = 69 + 12 * Math.log2(hz / 440) - tuning;
    const nearest = Math.round(midi);
    if (nearest < MIDI_LO || nearest > MIDI_HI) continue;
    binIndex.push(k);
    binPc.push(((nearest % 12) + 12) % 12);
    binWeight.push(Math.cos(Math.PI * (midi - nearest)) ** 2);
  }
  const chroma = new Float32Array(n * PCS);
  const pitchFft = new RealFftPair(size);
  const frameA = new Float64Array(size);
  const frameB = new Float64Array(size);
  const powA = new Float64Array(size / 2 + 1);
  const powB = new Float64Array(size / 2 + 1);
  const fill = (frame: Float64Array, j: number) => {
    const start = Math.round((j * sr) / rate) - size / 2;
    for (let i = 0; i < size; i++) {
      const s = start + i;
      frame[i] = s >= 0 && s < x.length ? x[s] * window[i] : 0;
    }
  };
  const fold = (pow: Float64Array, j: number) => {
    const o = j * PCS;
    for (let b = 0; b < binIndex.length; b++) chroma[o + binPc[b]] += pow[binIndex[b]] * calib * binWeight[b];
  };
  const report = Math.max(2, Math.floor(n / 40) & ~1);
  for (let j = 0; j < n; j += 2) {
    fill(frameA, j);
    if (j + 1 < n) fill(frameB, j + 1);
    else frameB.fill(0);
    pitchFft.power(frameA, frameB, powA, powB);
    fold(powA, j);
    if (j + 1 < n) fold(powB, j + 1);
    if (tick && j % report === 0) tick(0.05 + 0.6 * (j / n));
  }
  quantizeChroma(chroma, n);

  // 2. RMS and onset strength on a 220-sample hop (scaled for other rates)
  const hop = Math.max(1, Math.round((220 * sr) / 22050));
  const nfft = nextPow2(Math.round((1024 * sr) / 22050));
  const frames = Math.floor(x.length / hop) + 1;
  const rms = new Float32Array(frames);
  const melRows = melFilterbank(sr, nfft, 128);
  const fftWin = hann(nfft);
  const mel = new Float32Array(frames * 128);
  const melFft = new RealFftPair(nfft);
  const melA = new Float64Array(nfft);
  const melB = new Float64Array(nfft);
  const melPowA = new Float64Array(nfft / 2 + 1);
  const melPowB = new Float64Array(nfft / 2 + 1);
  let melMax = -Infinity;
  const frameOf = (frame: Float64Array, f: number) => {
    const start = f * hop - nfft / 2;
    let sq = 0;
    for (let i = 0; i < nfft; i++) {
      const s = start + i;
      const v = s >= 0 && s < x.length ? x[s] : 0;
      sq += v * v;
      frame[i] = v * fftWin[i];
    }
    rms[f] = Math.sqrt(sq / nfft);
  };
  const melOf = (power: Float64Array, f: number) => {
    for (let m = 0; m < 128; m++) {
      const { start: k0, weights } = melRows[m];
      let acc = 0;
      for (let k = 0; k < weights.length; k++) acc += weights[k] * power[k0 + k];
      const db = 10 * Math.log10(Math.max(1e-10, acc));
      mel[f * 128 + m] = db;
      if (db > melMax) melMax = db;
    }
  };
  const melReport = Math.max(2, Math.floor(frames / 20) & ~1);
  for (let f = 0; f < frames; f += 2) {
    frameOf(melA, f);
    if (f + 1 < frames) frameOf(melB, f + 1);
    else melB.fill(0);
    melFft.power(melA, melB, melPowA, melPowB);
    melOf(melPowA, f);
    if (f + 1 < frames) melOf(melPowB, f + 1);
    if (tick && f % melReport === 0) tick(0.65 + 0.3 * (f / frames));
  }
  const floorDb = melMax - 80;
  for (let i = 0; i < mel.length; i++) if (mel[i] < floorDb) mel[i] = floorDb;
  const flux = new Float32Array(frames);
  const pad = 1 + Math.floor(nfft / (2 * hop));
  for (let f = 1; f < frames; f++) {
    let acc = 0;
    for (let m = 0; m < 128; m++) acc += Math.max(0, mel[f * 128 + m] - mel[(f - 1) * 128 + m]);
    const target = f - 1 + pad;
    if (target < frames) flux[target] = acc / 128;
  }

  const times = Float64Array.from({ length: frames }, (_, f) => (f * hop) / sr);
  const levelRaw = new Float32Array(n);
  const attackRaw = new Float32Array(n);
  for (let j = 0; j < n; j++) {
    const t = j / rate;
    levelRaw[j] = interp(t, times, rms) * 100;
    attackRaw[j] = interp(t, times, flux);
  }
  tick?.(1);
  return { rate, n, chroma, level: scaleEnvelope(levelRaw), attack: attackEnvelope(attackRaw), rest: new Uint8Array(n), tuning };
}

/* ------------------------------------------------------------------ */
/* Downsampling and structure                                           */
/* ------------------------------------------------------------------ */

/** _downsample: averages chroma / level / novelty, keeps attack maxima, rest only if > 95 % resting. */
export function downsampleFeatures(f: SyncFeatures, target: number): SyncFeatures {
  const stride = Math.max(1, Math.round(f.rate / target));
  const n = Math.ceil(f.n / stride);
  const pick = (a: Float32Array) => Float32Array.from({ length: n }, (_, k) => a[k * stride]);
  const chroma = new Float32Array(n * PCS);
  for (let c = 0; c < PCS; c++) {
    const col = Float32Array.from({ length: f.n }, (_, j) => f.chroma[j * PCS + c]);
    const smooth = uniformFilter(col, stride);
    for (let k = 0; k < n; k++) chroma[k * PCS + c] = smooth[k * stride];
  }
  const restFrac = pick(uniformFilter(f.rest, stride));
  const validFrac = pick(uniformFilter(f.noveltyValid, stride));
  return {
    rate: f.rate / stride,
    n,
    chroma,
    level: pick(uniformFilter(f.level, stride)),
    attack: pick(maximumFilter(f.attack, stride)),
    rest: Uint8Array.from(restFrac, (v) => (v > 0.95 ? 1 : 0)),
    novelty: pick(uniformFilter(f.novelty, stride)),
    noveltyValid: Uint8Array.from(validFrac, (v) => (v > 0.99 ? 1 : 0)),
  };
}

/** _novelty: rank-one checkerboard novelty at 2 s and 8 s plus loudness change, 0–1. */
export function novelty(chroma: Float32Array, level: Float32Array, n: number, rate: number): Float32Array {
  const unit = new Float32Array(n * PCS);
  for (let j = 0; j < n; j++) {
    let norm = 0;
    for (let c = 0; c < PCS; c++) norm += chroma[j * PCS + c] ** 2;
    norm = Math.max(Math.sqrt(norm), 1e-8);
    for (let c = 0; c < PCS; c++) unit[j * PCS + c] = chroma[j * PCS + c] / norm;
  }
  const channels: Float32Array[] = [];
  for (const seconds of [2, 8]) {
    const L = Math.max(1, Math.round(seconds * rate));
    const v = new Float64Array(2 * L + 1);
    let absSum = 0;
    for (let a = -L; a <= L; a++) {
      v[a + L] = Math.sign(a) * Math.exp(-(((Math.SQRT1_2 / (L * 0.5)) * a) ** 2));
      absSum += Math.abs(v[a + L]);
    }
    const y = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      let total = 0;
      for (let c = 0; c < PCS; c++) {
        let acc = 0;
        for (let a = -L; a <= L; a++) {
          const j = i - a;
          if (j >= 0 && j < n) acc += v[a + L] * unit[j * PCS + c];
        }
        total += acc * acc;
      }
      y[i] = total / (absSum * absSum);
    }
    for (let i = 0; i < Math.min(L, n); i++) y[i] = 0;
    for (let i = Math.max(0, n - L); i < n; i++) y[i] = 0;
    const ref = Math.max(percentile(y, 95), 0.05);
    channels.push(y.map((val) => val / ref));
  }
  const smooth = uniformFilter(level, Math.max(1, Math.round(rate)));
  const change = gradient(smooth).map(Math.abs);
  const ref = Math.max(percentile(change, 95), 0.02);
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) out[i] = Math.max(0, Math.min(1, (channels[0][i] + channels[1][i] + change[i] / ref) / 3));
  return out;
}

/** Adds novelty (computed at 5 Hz, interpolated back) and its validity mask (8 s from each end). */
export function withNovelty(f: Omit<SyncFeatures, "novelty" | "noveltyValid">): SyncFeatures {
  const base: SyncFeatures = { ...f, novelty: new Float32Array(f.n), noveltyValid: new Uint8Array(f.n) };
  const low = downsampleFeatures(base, 5);
  const nov = novelty(low.chroma, low.level, low.n, low.rate);
  const lowTimes = Float64Array.from({ length: low.n }, (_, k) => k / low.rate);
  const last = (f.n - 1) / f.rate;
  for (let j = 0; j < f.n; j++) {
    const t = j / f.rate;
    base.novelty[j] = interp(t, lowTimes, nov);
    base.noveltyValid[j] = t >= 8 && t <= last - 8 ? 1 : 0;
  }
  return base;
}
