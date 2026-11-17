/**
 * Band-limited resampling to the aligners' analysis rate: a Kaiser-windowed
 * sinc with swresample's defaults (filter_size 32, cutoff 0.97, beta 9, 1024
 * phases, linear interpolation between phases). Shared by the integrated and
 * redline aligners. A standard high-quality resampler, not bit-identical to
 * ffmpeg.
 */

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
export function resampleTo(samples: Float32Array, sampleRate: number, target = 22050): Float32Array {
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
