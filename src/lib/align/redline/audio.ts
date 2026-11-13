/**
 * Audio front end of the redline port: what `load_audio` (ffmpeg → mono
 * float32 at 22050 Hz) and `librosa.estimate_tuning` do in the reference.
 *
 * Resampling: the reference lets ffmpeg's swresample convert the rate. Here
 * a Kaiser-windowed sinc with swresample's defaults (filter_size 32, cutoff
 * 0.97, beta 9, 1024 phases, linear interpolation between phases) does it.
 * It is a standard high-quality band-limited resampler, not bit-identical to
 * ffmpeg. Recordings arrive mono (downmixed by toAlignAudio).
 */
import { RealFftPair } from "../integrated/signal";
import { median, roundHalfEven } from "./numeric";

export const SR = 22050;

function besselI0(x: number): number {
  let sum = 1;
  let term = 1;
  const q = (x * x) / 4;
  for (let k = 1; k < 200; k++) {
    term *= q / (k * k);
    sum += term;
    if (term < sum * 1e-17) break;
  }
  return sum;
}

/** Mono samples at `sampleRate` → mono float32 at 22050 Hz. */
export function resampleTo(samples: Float32Array, sampleRate: number, target = SR): Float32Array {
  if (sampleRate === target) return samples;
  const ratio = target / sampleRate;
  const factor = Math.min(1, ratio) * 0.97;
  const filterSize = 32;
  const beta = 9;
  const phases = 1024;
  const taps = Math.max(1, Math.ceil(filterSize / factor));
  const half = taps >> 1;
  // table[phase][t]: weight of input sample (i0 − half + 1 + t) when the output sits phase/phases past i0
  const table = new Float64Array((phases + 1) * taps);
  const i0b = besselI0(beta);
  for (let ph = 0; ph <= phases; ph++) {
    const frac = ph / phases;
    let sum = 0;
    for (let t = 0; t < taps; t++) {
      const x = t - half + 1 - frac; // input offset from the output position
      const z = Math.PI * factor * x;
      const sinc = Math.abs(z) < 1e-12 ? 1 : Math.sin(z) / z;
      const r = x / (half + 1);
      const win = Math.abs(r) >= 1 ? 0 : besselI0(beta * Math.sqrt(1 - r * r)) / i0b;
      const v = sinc * win;
      table[ph * taps + t] = v;
      sum += v;
    }
    for (let t = 0; t < taps; t++) table[ph * taps + t] /= sum;
  }
  const n = samples.length;
  const outLen = Math.floor((n * target) / sampleRate);
  const out = new Float32Array(outLen);
  const step = sampleRate / target;
  for (let k = 0; k < outLen; k++) {
    const pos = k * step;
    const i0 = Math.floor(pos);
    const pf = (pos - i0) * phases;
    const p0 = Math.floor(pf);
    const pw = pf - p0;
    const base0 = p0 * taps;
    const base1 = Math.min(phases, p0 + 1) * taps;
    const start = i0 - half + 1;
    let acc = 0;
    for (let t = 0; t < taps; t++) {
      const idx = start + t;
      if (idx < 0 || idx >= n) continue;
      const w = pw === 0 ? table[base0 + t] : table[base0 + t] * (1 - pw) + table[base1 + t] * pw;
      acc += w * samples[idx];
    }
    out[k] = acc;
  }
  return out;
}

/** scipy.signal.get_window("hann", n) (periodic), as librosa uses it. */
export function hannPeriodic(n: number): Float64Array {
  const w = new Float64Array(n);
  for (let i = 0; i < n; i++) w[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / n);
  return w;
}

/**
 * librosa.stft(y, n_fft, hop_length, window="hann", center=True,
 * pad_mode="constant") power |X|², frame by frame: `visit(t, a)` gets frame
 * t's power spectrum (n_fft/2 + 1 bins). Returns the frame count 1 + len // hop.
 */
export function stftPowerFrames(y: Float32Array, nFft: number, hop: number, visit: (t: number, power: Float64Array) => void, tick?: (fraction: number) => void): number {
  const frames = 1 + Math.floor(y.length / hop);
  const fftp = new RealFftPair(nFft);
  const win = hannPeriodic(nFft);
  const a = new Float64Array(nFft);
  const b = new Float64Array(nFft);
  const pa = new Float64Array(nFft / 2 + 1);
  const pb = new Float64Array(nFft / 2 + 1);
  const pad = nFft >> 1;
  const fill = (t: number, buf: Float64Array) => {
    const start = t * hop - pad;
    for (let i = 0; i < nFft; i++) {
      const idx = start + i;
      buf[i] = idx >= 0 && idx < y.length ? y[idx] * win[i] : 0;
    }
  };
  const every = Math.max(1, Math.floor(frames / 50));
  for (let t = 0; t < frames; t += 2) {
    fill(t, a);
    if (t + 1 < frames) fill(t + 1, b);
    else b.fill(0);
    fftp.power(a, b, pa, pb);
    visit(t, pa);
    if (t + 1 < frames) visit(t + 1, pb);
    if (tick && (t % every === 0 || t % every === 1)) tick(t / frames);
  }
  return frames;
}

/**
 * librosa.estimate_tuning(y=y, sr=sr) with its defaults: piptrack (n_fft
 * 2048, hop 512, fmin 150, fmax 4000, threshold 0.1, ref = per-frame max),
 * keep peaks at or above the median magnitude, histogram of the residual to
 * the nearest semitone at 0.01 resolution, return the left edge of the
 * fullest bin. Semitones, in [−0.5, 0.5).
 */
export function estimateTuningLibrosa(y: Float32Array, sr: number): number {
  const nFft = 2048;
  const hop = nFft >> 2;
  const fmin = Math.max(150, 0);
  const fmax = Math.min(4000, sr / 2);
  const bins = nFft / 2 + 1;
  const kLo = Math.ceil((fmin * nFft) / sr - 1e-12);
  const pitches: number[] = [];
  const mags: number[] = [];
  const S = new Float64Array(bins);
  stftPowerFrames(y, nFft, hop, (_t, power) => {
    let mx = 0;
    for (let k = 0; k < bins; k++) {
      S[k] = Math.sqrt(power[k]);
      if (S[k] > mx) mx = S[k];
    }
    const ref = 0.1 * mx;
    const th = (k: number) => (S[k] > ref ? S[k] : 0);
    for (let k = Math.max(0, kLo); k < bins; k++) {
      const f = (k * sr) / nFft;
      if (f < fmin) continue;
      if (f >= fmax) break;
      // util.localmax with edge padding: x[k] > x[k−1] and x[k] ≥ x[k+1]
      const c = th(k);
      const l = th(k > 0 ? k - 1 : 0);
      const r = th(k < bins - 1 ? k + 1 : bins - 1);
      if (!(c > l && c >= r)) continue;
      // parabolic shift and gradient on the unthresholded magnitudes
      let shift = 0;
      if (k > 0 && k < bins - 1) {
        const a = S[k + 1] + S[k - 1] - 2 * S[k];
        const bb = (S[k + 1] - S[k - 1]) / 2;
        shift = Math.abs(bb) >= Math.abs(a) ? 0 : -bb / a;
      }
      const avg = k === 0 ? S[1] - S[0] : k === bins - 1 ? S[k] - S[k - 1] : (S[k + 1] - S[k - 1]) / 2;
      const pitch = ((k + shift) * sr) / nFft;
      pitches.push(pitch);
      mags.push(S[k] + 0.5 * avg * shift);
    }
  });
  const masked = pitches.map((p, i) => (p > 0 ? mags[i] : NaN)).filter((m) => !Number.isNaN(m));
  const threshold = masked.length ? median(masked) : 0;
  const freqs: number[] = [];
  for (let i = 0; i < pitches.length; i++) if (pitches[i] > 0 && mags[i] >= threshold) freqs.push(pitches[i]);
  return pitchTuning(freqs);
}

/** librosa.pitch_tuning(frequencies, resolution=0.01, bins_per_octave=12) */
export function pitchTuning(frequencies: number[], resolution = 0.01, binsPerOctave = 12): number {
  const f = frequencies.filter((x) => x > 0);
  if (f.length === 0) return 0;
  const nBins = Math.ceil(1 / resolution);
  const edges = new Float64Array(nBins + 1);
  const step = 1 / nBins;
  for (let i = 0; i <= nBins; i++) edges[i] = i === nBins ? 0.5 : -0.5 + i * step;
  const counts = new Int32Array(nBins);
  for (const hz of f) {
    const octs = Math.log2(hz / (440 / 16));
    let r = binsPerOctave * octs;
    r = r - Math.floor(r); // np.mod(x, 1.0)
    if (r >= 0.5) r -= 1;
    if (r < edges[0] || r > edges[nBins]) continue;
    // numpy.histogram's uniform-bin index with its edge corrections
    let idx = Math.floor((r - edges[0]) * (nBins / (edges[nBins] - edges[0])));
    if (idx === nBins) idx -= 1;
    if (r < edges[idx]) idx -= 1;
    else if (idx !== nBins - 1 && r >= edges[idx + 1]) idx += 1;
    counts[idx]++;
  }
  let best = 0;
  for (let i = 1; i < nBins; i++) if (counts[i] > counts[best]) best = i;
  return edges[best];
}

/** numpy.round on an array of MIDI values, as `np.round(midi).astype(int)`. */
export function nearestPitch(midi: number): number {
  return roundHalfEven(midi);
}
