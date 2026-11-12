/**
 * Small numeric helpers with the edge conventions of the SciPy / NumPy calls
 * used by the reference implementation
 * (docs/research/score-sync-lab/INTEGRATED_FROM_ORIGINAL_GUIDE.md).
 */

/** numpy.percentile with linear interpolation; 0 for an empty input. */
export function percentile(values: ArrayLike<number>, p: number): number {
  const n = values.length;
  if (n === 0) return 0;
  const sorted = Float64Array.from(values as ArrayLike<number>).sort();
  const pos = (Math.max(0, Math.min(100, p)) / 100) * (n - 1);
  const lo = Math.floor(pos);
  const hi = Math.min(n - 1, lo + 1);
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - lo);
}

/** scipy.ndimage 'reflect' boundary (d c b a | a b c d | d c b a). */
function reflect(i: number, n: number): number {
  if (n === 1) return 0;
  const period = 2 * n;
  let k = ((i % period) + period) % period;
  if (k >= n) k = period - 1 - k;
  return k;
}

/** scipy.ndimage.uniform_filter1d(x, size), mode 'reflect'. */
export function uniformFilter(x: ArrayLike<number>, size: number): Float32Array {
  const n = x.length;
  const out = new Float32Array(n);
  if (n === 0) return out;
  const s = Math.max(1, Math.round(size));
  const left = Math.floor(s / 2);
  const right = s - left - 1;
  let acc = 0;
  for (let k = -left; k <= right; k++) acc += x[reflect(k, n)];
  for (let i = 0; i < n; i++) {
    out[i] = acc / s;
    acc += x[reflect(i + right + 1, n)] - x[reflect(i - left, n)];
  }
  return out;
}

/** scipy.ndimage.maximum_filter1d(x, size), mode 'reflect'. */
export function maximumFilter(x: ArrayLike<number>, size: number): Float32Array {
  const n = x.length;
  const out = new Float32Array(n);
  const s = Math.max(1, Math.round(size));
  const left = Math.floor(s / 2);
  const right = s - left - 1;
  for (let i = 0; i < n; i++) {
    let m = -Infinity;
    for (let k = i - left; k <= i + right; k++) {
      const v = x[reflect(k, n)];
      if (v > m) m = v;
    }
    out[i] = m;
  }
  return out;
}

/** Gaussian kernel of scipy.ndimage.gaussian_filter1d (truncate = 4). */
export function gaussianKernel(sigma: number): Float64Array {
  const radius = Math.max(0, Math.floor(4 * sigma + 0.5));
  const k = new Float64Array(2 * radius + 1);
  if (sigma <= 0) {
    k[radius] = 1;
    return k;
  }
  let sum = 0;
  for (let i = -radius; i <= radius; i++) {
    const v = Math.exp(-0.5 * (i / sigma) ** 2);
    k[i + radius] = v;
    sum += v;
  }
  for (let i = 0; i < k.length; i++) k[i] /= sum;
  return k;
}

/** gaussian_filter1d of one row, mode 'nearest', written into `out`. */
export function gaussianRow(row: Float32Array, kernel: Float64Array, out: Float32Array): void {
  const n = row.length;
  const radius = (kernel.length - 1) >> 1;
  for (let i = 0; i < n; i++) {
    let acc = 0;
    for (let k = -radius; k <= radius; k++) {
      const j = i + k < 0 ? 0 : i + k >= n ? n - 1 : i + k;
      acc += kernel[k + radius] * row[j];
    }
    out[i] = acc;
  }
}

/** numpy.interp for increasing xp (clamped at the ends). */
export function interp(x: number, xp: ArrayLike<number>, fp: ArrayLike<number>): number {
  const n = xp.length;
  if (n === 0) return NaN;
  if (x <= xp[0]) return fp[0];
  if (x >= xp[n - 1]) return fp[n - 1];
  let lo = 0;
  let hi = n - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (xp[mid] <= x) lo = mid;
    else hi = mid;
  }
  const span = xp[hi] - xp[lo];
  return span > 0 ? fp[lo] + ((fp[hi] - fp[lo]) * (x - xp[lo])) / span : fp[lo];
}

/** numpy.gradient (central differences, one-sided at the ends). */
export function gradient(x: ArrayLike<number>): Float32Array {
  const n = x.length;
  const out = new Float32Array(n);
  if (n < 2) return out;
  out[0] = x[1] - x[0];
  out[n - 1] = x[n - 1] - x[n - 2];
  for (let i = 1; i < n - 1; i++) out[i] = (x[i + 1] - x[i - 1]) / 2;
  return out;
}

export { fft, nextPow2, downsample } from "../chroma";

/**
 * Radix-2 FFT with precomputed bit reversal and twiddles that transforms two
 * real frames at once (one in the real part, one in the imaginary part) and
 * returns the power spectrum |X[k]|², k = 0…size/2, of each.
 */
export class RealFftPair {
  readonly size: number;
  private readonly rev: Uint32Array;
  private readonly cos: Float64Array;
  private readonly sin: Float64Array;
  private readonly re: Float64Array;
  private readonly im: Float64Array;

  constructor(size: number) {
    if (size < 2 || (size & (size - 1)) !== 0) throw new Error("FFT size must be a power of two");
    this.size = size;
    this.rev = new Uint32Array(size);
    const bits = Math.log2(size);
    for (let i = 0; i < size; i++) {
      let r = 0;
      for (let b = 0; b < bits; b++) r |= ((i >> b) & 1) << (bits - 1 - b);
      this.rev[i] = r;
    }
    this.cos = new Float64Array(size / 2);
    this.sin = new Float64Array(size / 2);
    for (let k = 0; k < size / 2; k++) {
      this.cos[k] = Math.cos((-2 * Math.PI * k) / size);
      this.sin[k] = Math.sin((-2 * Math.PI * k) / size);
    }
    this.re = new Float64Array(size);
    this.im = new Float64Array(size);
  }

  /** a, b: windowed real frames of length size. Writes power spectra into pa / pb (length size/2 + 1). */
  power(a: Float64Array, b: Float64Array, pa: Float64Array, pb: Float64Array): void {
    const n = this.size;
    const { re, im, rev, cos, sin } = this;
    for (let i = 0; i < n; i++) {
      const r = rev[i];
      re[r] = a[i];
      im[r] = b[i];
    }
    for (let len = 2; len <= n; len <<= 1) {
      const half = len >> 1;
      const stride = n / len;
      for (let i = 0; i < n; i += len) {
        for (let k = 0; k < half; k++) {
          const wr = cos[k * stride];
          const wi = sin[k * stride];
          const p = i + k;
          const q = p + half;
          const xr = re[q] * wr - im[q] * wi;
          const xi = re[q] * wi + im[q] * wr;
          re[q] = re[p] - xr;
          im[q] = im[p] - xi;
          re[p] += xr;
          im[p] += xi;
        }
      }
    }
    // separate: A[k] = (Z[k] + conj Z[n−k]) / 2, B[k] = (Z[k] − conj Z[n−k]) / 2i
    for (let k = 0; k <= n / 2; k++) {
      const j = (n - k) & (n - 1);
      const ar = (re[k] + re[j]) / 2;
      const ai = (im[k] - im[j]) / 2;
      const br = (im[k] + im[j]) / 2;
      const bi = (re[j] - re[k]) / 2;
      pa[k] = ar * ar + ai * ai;
      pb[k] = br * br + bi * bi;
    }
  }
}
