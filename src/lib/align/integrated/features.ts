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
 * The recording's pitch energy is Sync Toolbox's IIR filterbank, ported
 * exactly (filterbank.ts). The score side follows Sync Toolbox's
 * df_to_pitch_features and the reference's score_envelope, reading written
 * dynamics and hairpins per staff from `infoMap.timing.expression`.
 * Deliberate difference: hairpins span the notes their own start and stop
 * mark. In the reference, music21 pairs a wedge stop with the first open
 * wedge of that number anywhere in the score, so once one wedge is left open
 * every later hairpin in the part ends at the next one's stop.
 */
import type { Dynamic } from "@/shared/dynamics";
import type { InfoMap, Note, StyleMarking } from "@/shared/info-map";
import { resampleTo } from "../resample";
import { estimateTuningCents, syncToolboxChroma } from "./filterbank";
import { RealFftPair, downsample, gradient, interp, maximumFilter, nextPow2, percentile, uniformFilter } from "./signal";

export const FEATURE_RATE = 50;
export const PCS = 12;
/** Sync Toolbox quantize_chroma defaults */
const QUANT_STEPS = [0.4, 0.2, 0.1, 0.05];
const QUANT_WEIGHT = 0.25;
/** a chroma frame with no entry above this carries no harmonic evidence (Sync Toolbox quantize_chroma) */
const NORM_THRESHOLD = 0.001;
/** recording analysis rate (librosa.load(sr=22050) in the reference) */
const ANALYSIS_RATE = 22050;
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

/**
 * quantize_chroma(pitch_to_chroma(...)) on raw pitch-class energies, in place
 * (Sync Toolbox): a frame with no entry above 0.001 becomes all zeros (no
 * harmonic evidence); otherwise divide by the sum and add 0.25 per threshold
 * 0.40 / 0.20 / 0.10 / 0.05 exceeded.
 */
export function quantizeChroma(raw: Float32Array, n: number): void {
  for (let j = 0; j < n; j++) {
    const o = j * PCS;
    let sum = 0;
    let any = false;
    for (let c = 0; c < PCS; c++) {
      sum += raw[o + c];
      if (raw[o + c] > NORM_THRESHOLD) any = true;
    }
    for (let c = 0; c < PCS; c++) {
      if (!any) {
        raw[o + c] = 0;
        continue;
      }
      const v = raw[o + c] / sum;
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

/**
 * music21 Dynamic.volumeScalar per info-map dynamic, used when an info map
 * predates `timing.expression` (the note's dynamic then stands in for the
 * marks, and there are no hairpins).
 */
export const DYNAMIC_STRENGTH: Record<Dynamic, number> = {
  pp: 0.25,
  p: 0.35,
  mp: 0.45,
  mf: 0.55,
  f: 0.7,
  ff: 0.85,
  fff: 0.9,
};

function accentFactor(style: StyleMarking | null): number {
  if (style === "Marcato") return 2.2;
  if (style === "Accent") return 1.8;
  return 1;
}

/** Python's round(): half to even. */
function roundHalfEven(x: number): number {
  const r = Math.round(x);
  return Math.abs(x % 1) === 0.5 && r % 2 !== 0 ? r - 1 : r;
}

export interface ScoreFeatureOptions {
  /** semitones from written to sounding pitch per part id */
  transpose: Record<string, number>;
}

interface StaffModel {
  notes: Note[];
  dynamics: Array<{ time: number; scalar: number }>;
  hairpins: Array<{ start: number; end: number; crescendo: boolean }>;
}

/** One loudness model per staff (music21 treats each staff as a part); old info maps: one per instrument. */
function staffModels(infoMap: InfoMap): StaffModel[] {
  const expression = infoMap.timing?.expression;
  if (!expression) {
    return infoMap.instruments.map((inst) => {
      const dynamics: StaffModel["dynamics"] = [];
      let last: number | null = null;
      for (const nt of [...inst.notes].sort((a, b) => a.time - b.time)) {
        const v = DYNAMIC_STRENGTH[nt.dynamics];
        if (v !== last) dynamics.push({ time: nt.time, scalar: v });
        last = v;
      }
      return { notes: inst.notes, dynamics, hairpins: [] };
    });
  }
  const byId = new Map(infoMap.instruments.map((i) => [i.id, i]));
  const covered = new Set<string>();
  const out: StaffModel[] = expression.map((e) => {
    covered.add(`${e.part}:${e.staff}`);
    return { notes: (byId.get(e.part)?.notes ?? []).filter((nt) => (nt.staff ?? 1) === e.staff), dynamics: e.dynamics, hairpins: e.hairpins };
  });
  // notes on a staff with no expression entry still sound (strength 0.5)
  for (const inst of infoMap.instruments) {
    const rest = inst.notes.filter((nt) => !covered.has(`${inst.id}:${nt.staff ?? 1}`));
    if (rest.length) out.push({ notes: rest, dynamics: [], hairpins: [] });
  }
  return out;
}

/**
 * Direct score features (no synthesis), as the reference builds them:
 *
 * - chroma: Sync Toolbox df_to_pitch_features with ignore_velocity — each
 *   sounding pitch (unpitched percussion excluded) marks every 40 ms window
 *   it overlaps with 1 (a unison doubled by several parts counts once),
 *   folded to pitch classes and quantized;
 * - level / attack / rest: score_envelope (section 6.3) per staff — written
 *   dynamic marks hold from their position, hairpins ramp to the next mark
 *   within 2 s (else ±0.2), chord tones form one attack, staccato halves the
 *   sounding length, accents add a short boost.
 */
export function scoreFeatures(infoMap: InfoMap, options: ScoreFeatureOptions): Omit<SyncFeatures, "novelty" | "noveltyValid"> {
  const rate = FEATURE_RATE;
  const n = Math.ceil(infoMap.duration * rate) + 1;
  const times = Float64Array.from({ length: n }, (_, j) => j / rate);

  // 1. chroma (df_to_pitch_features, step 20 ms, windows [(c−1)·20, (c+1)·20] ms)
  const stepMs = (1 / rate) * 1000;
  let lastEnd = 0;
  const rows: Array<{ start: number; end: number; pitch: number }> = [];
  for (const inst of infoMap.instruments) {
    const shift = options.transpose[inst.id] ?? 0;
    for (const nt of inst.notes) {
      if (nt.unpitched || !(nt.duration > 0)) continue;
      const pitch = nt.pitch + shift;
      if (pitch < MIDI_LO || pitch > MIDI_HI) continue;
      rows.push({ start: nt.time, end: nt.time + nt.duration, pitch });
      lastEnd = Math.max(lastEnd, nt.time + nt.duration);
    }
  }
  const pitchFrames = Math.ceil((lastEnd * 1000) / stepMs);
  const occupied = new Uint8Array(Math.max(pitchFrames, n) * 128);
  for (const r of rows) {
    const c0 = Math.floor((1000 * r.start) / stepMs);
    const c1 = Math.min(Math.floor((1000 * r.end) / stepMs) + 1, pitchFrames - 1);
    for (let c = Math.max(0, c0); c <= c1; c++) occupied[c * 128 + r.pitch] = 1;
  }
  const chroma = new Float32Array(n * PCS);
  for (let j = 0; j < Math.min(n, pitchFrames); j++) {
    for (let p = MIDI_LO; p <= MIDI_HI; p++) if (occupied[j * 128 + p]) chroma[j * PCS + (p % 12)] += 1;
  }
  quantizeChroma(chroma, n);

  // 2. expected loudness, attacks and rests per staff
  const envelope = new Float64Array(n);
  const attacks = new Float64Array(n);
  const sounding = new Float64Array(n);
  const attackFrames = Math.max(1, Math.round(0.06 * rate));
  const accentFrames = Math.max(1, Math.round(0.08 * rate));
  for (const staff of staffModels(infoMap)) {
    const events = [...staff.dynamics].sort((a, b) => a.time - b.time || a.scalar - b.scalar);
    const strength = new Float64Array(n).fill(0.5);
    // each mark holds until the next one (strength[times >= t] = v, applied in order)
    const firstFrame = (t: number) => {
      let j = Math.max(0, Math.ceil(t * rate - 1e-9) - 1);
      while (j < n && times[j] < t) j++;
      return j;
    };
    for (let e = 0; e < events.length; e++) {
      const to = e + 1 < events.length ? firstFrame(events[e + 1].time) : n;
      for (let j = firstFrame(events[e].time); j < to; j++) strength[j] = events[e].scalar;
    }
    for (const h of [...staff.hairpins].sort((a, b) => a.start - b.start)) {
      const { start: a, end: b } = h;
      if (!(b > a)) continue;
      const from = strength[Math.max(0, Math.min(roundHalfEven(a * rate), n - 1))];
      const after = events.find((ev) => ev.time >= b && ev.time <= b + 2);
      const to = after ? after.scalar : Math.max(0.05, Math.min(1, from + (h.crescendo ? 0.2 : -0.2)));
      for (let j = Math.max(0, Math.floor(a * rate)); j < n && times[j] <= b; j++) if (times[j] >= a) strength[j] = from + ((to - from) * (times[j] - a)) / (b - a);
    }

    // chord tones (same onset and length) form one event, like a music21 chord
    const chords = new Map<string, { time: number; end: number; count: number; style: StyleMarking | null }>();
    for (const nt of staff.notes) {
      const key = `${nt.time}:${nt.duration}:${nt.styleMarking ?? ""}`;
      const c = chords.get(key);
      if (c) c.count += 1;
      else chords.set(key, { time: nt.time, end: nt.time + nt.duration, count: 1, style: nt.styleMarking });
    }
    const activity = new Float64Array(n);
    for (const c of chords.values()) {
      const accent = accentFactor(c.style);
      const end = c.style === "Staccato" ? c.time + (c.end - c.time) * 0.5 : c.end;
      const lo = Math.max(0, Math.floor(c.time * rate));
      const hi = Math.min(n, Math.ceil(end * rate));
      for (let j = lo; j < hi; j++) {
        activity[j] += c.count;
        sounding[j] += c.count;
      }
      if (hi > lo) {
        const amplitude = Math.sqrt(c.count) * strength[lo] ** 2 * accent;
        for (let k = 0; k < attackFrames && lo + k < n; k++) attacks[lo + k] += amplitude * (1 - k / attackFrames);
        if (accent > 1) for (let j = lo; j < Math.min(hi, lo + accentFrames); j++) activity[j] += c.count * (accent - 1);
      }
    }
    for (let j = 0; j < n; j++) envelope[j] += Math.sqrt(activity[j]) * strength[j] ** 2;
  }

  const rest = new Uint8Array(n);
  for (let j = 0; j < n; j++) rest[j] = sounding[j] === 0 ? 1 : 0;
  return { rate, n, chroma, level: scaleEnvelope(envelope), attack: attackEnvelope(attacks), rest };
}

/* ------------------------------------------------------------------ */
/* Recording                                                            */
/* ------------------------------------------------------------------ */

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

/** Mono samples at 22050 Hz (the reference's librosa.load rate). */
function toAnalysisRate(samples: Float32Array, sampleRate: number): Float32Array {
  if (sampleRate === ANALYSIS_RATE) return samples;
  const factor = sampleRate / ANALYSIS_RATE;
  if (Number.isInteger(factor)) return downsample(samples, sampleRate, ANALYSIS_RATE).samples;
  return resampleTo(samples, sampleRate, ANALYSIS_RATE);
}

/**
 * Recording features: tuned pitch-class energy at 50 Hz, RMS loudness and
 * mel spectral-flux attacks (librosa rms / onset_strength, hop 220 at 22050 Hz).
 */
export function audioFeatures(samples: Float32Array, sampleRate: number, tick?: Tick): Omit<SyncFeatures, "novelty" | "noveltyValid"> & { tuning: number } {
  const x = toAnalysisRate(samples, sampleRate);
  const sr = ANALYSIS_RATE;
  const rate = FEATURE_RATE;

  // 1. pitch-class energy: Sync Toolbox's multirate elliptic filterbank (one
  //    band per MIDI pitch, tuned in whole cents) summed over 40 ms windows,
  //    folded and quantized exactly as the reference does (filterbank.ts)
  let cents = 0;
  try {
    cents = estimateTuningCents(x, sr);
  } catch {
    cents = 0; // shorter than the tuning estimator's window
  }
  tick?.(0.05);
  const { n, chroma } = syncToolboxChroma(x, cents, tick ? (f) => tick(0.05 + 0.6 * f) : undefined);
  const tuning = cents / 100;

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

