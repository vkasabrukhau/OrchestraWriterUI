/**
 * NumPy / SciPy primitives with the exact conventions the redline reference
 * (redline-sync 0.1.0, Python) relies on: half-to-even rounding, np.interp
 * on non-decreasing sample points, scipy.ndimage 1-d filters with their
 * window placement and boundary modes, and linear-interpolation percentiles.
 */

/** Python round() / numpy.rint: halves go to the even neighbour. */
export function roundHalfEven(x: number): number {
  const r = Math.round(x);
  return Math.abs(x % 1) === 0.5 && r % 2 !== 0 ? r - 1 : r;
}

/** numpy.round(x, decimals) */
export function npRound(x: number, decimals: number): number {
  const f = 10 ** decimals;
  return roundHalfEven(x * f) / f;
}

/**
 * numpy.interp for one x. `xp` must be non-decreasing; with repeated sample
 * points numpy uses the last of the run (the j with xp[j] ≤ x < xp[j+1]).
 */
export function npInterp(x: number, xp: ArrayLike<number>, fp: ArrayLike<number>): number {
  const n = xp.length;
  if (n === 0) return NaN;
  if (x > xp[n - 1]) return fp[n - 1];
  if (x < xp[0]) return fp[0];
  // largest j with xp[j] <= x
  let lo = 0;
  let hi = n - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (xp[mid] <= x) lo = mid;
    else hi = mid - 1;
  }
  const j = lo;
  if (j === n - 1 || xp[j] === x) return fp[j];
  const slope = (fp[j + 1] - fp[j]) / (xp[j + 1] - xp[j]);
  let res = slope * (x - xp[j]) + fp[j];
  if (Number.isNaN(res)) {
    res = slope * (x - xp[j + 1]) + fp[j + 1];
    if (Number.isNaN(res) && fp[j] === fp[j + 1]) res = fp[j];
  }
  return res;
}

export function npInterpArray(x: ArrayLike<number>, xp: ArrayLike<number>, fp: ArrayLike<number>): Float64Array {
  const out = new Float64Array(x.length);
  for (let i = 0; i < x.length; i++) out[i] = npInterp(x[i], xp, fp);
  return out;
}

/** numpy.maximum.accumulate */
export function maximumAccumulate(x: ArrayLike<number>): Float64Array {
  const out = new Float64Array(x.length);
  let m = -Infinity;
  for (let i = 0; i < x.length; i++) {
    if (x[i] > m || Number.isNaN(x[i])) m = x[i];
    out[i] = m;
  }
  return out;
}

/** numpy.percentile, default ("linear") method. */
export function percentileLinear(values: ArrayLike<number>, p: number): number {
  const n = values.length;
  if (n === 0) return NaN;
  const sorted = Float64Array.from(values as ArrayLike<number>).sort();
  return lerpSorted(sorted, n, p);
}

function lerpSorted(sorted: ArrayLike<number>, n: number, p: number): number {
  const pos = (p / 100) * (n - 1);
  const lo = Math.floor(pos);
  const hi = Math.min(n - 1, lo + 1);
  const g = pos - lo;
  return sorted[lo] + (sorted[hi] - sorted[lo]) * g;
}

/**
 * numpy.percentile(np.abs(samples), p) without copying the samples: the two
 * order statistics are found by a two-pass radix select on the float bits
 * (non-negative floats sort like their bit patterns).
 */
export function percentileAbs(samples: Float32Array, p: number): number {
  const n = samples.length;
  if (n === 0) return NaN;
  const bits = new Uint32Array(samples.buffer, samples.byteOffset, n);
  const pos = (p / 100) * (n - 1);
  const lo = Math.floor(pos);
  const hi = Math.min(n - 1, lo + 1);
  const a = kthAbs(bits, lo);
  const b = hi === lo ? a : kthAbs(bits, hi);
  return a + (b - a) * (pos - lo);
}

const f32 = new Float32Array(1);
const u32 = new Uint32Array(f32.buffer);

/** k-th smallest |x| (0-based) given the raw float32 bit patterns. */
function kthAbs(bits: Uint32Array, k: number): number {
  const hist = new Uint32Array(1 << 16);
  for (let i = 0; i < bits.length; i++) hist[(bits[i] & 0x7fffffff) >>> 16]++;
  let rank = k;
  let high = 0;
  for (; high < hist.length; high++) {
    if (rank < hist[high]) break;
    rank -= hist[high];
  }
  hist.fill(0);
  for (let i = 0; i < bits.length; i++) {
    const v = bits[i] & 0x7fffffff;
    if (v >>> 16 === high) hist[v & 0xffff]++;
  }
  let low = 0;
  for (; low < hist.length; low++) {
    if (rank < hist[low]) break;
    rank -= hist[low];
  }
  u32[0] = (high << 16) | low;
  return f32[0];
}

/** numpy.median */
export function median(values: ArrayLike<number>): number {
  return percentileLinear(values, 50);
}

export type FilterMode = "nearest" | "constant";

function boundary(i: number, n: number, mode: FilterMode): number {
  if (i >= 0 && i < n) return i;
  if (mode === "nearest") return i < 0 ? 0 : n - 1;
  return -1;
}

/**
 * scipy.ndimage.uniform_filter1d along axis 0 of a row-major (rows × cols)
 * matrix. Window [i − size//2, i + size − size//2 − 1]; 'constant' pads with 0.
 */
export function uniformFilterRows(x: ArrayLike<number>, rows: number, cols: number, size: number, mode: FilterMode): Float32Array {
  const out = new Float32Array(rows * cols);
  if (rows === 0) return out;
  const left = size >> 1;
  const right = size - left - 1;
  const at = (r: number, c: number) => {
    const k = boundary(r, rows, mode);
    return k < 0 ? 0 : x[k * cols + c];
  };
  for (let c = 0; c < cols; c++) {
    let acc = 0;
    for (let r = -left; r <= right; r++) acc += at(r, c);
    out[c] = acc / size;
    for (let i = 1; i < rows; i++) {
      acc += at(i + right, c) - at(i - 1 - left, c);
      out[i * cols + c] = acc / size;
    }
  }
  return out;
}

/** scipy.ndimage.uniform_filter1d on a vector. */
export function uniformFilter1d(x: ArrayLike<number>, size: number, mode: FilterMode): Float32Array {
  return uniformFilterRows(x, x.length, 1, size, mode);
}

/** scipy.ndimage.maximum_filter1d, mode 'nearest' (monotonic deque, same window as uniform_filter1d). */
export function maximumFilter1dNearest(x: ArrayLike<number>, size: number): Float32Array {
  const n = x.length;
  const out = new Float32Array(n);
  if (n === 0) return out;
  const left = size >> 1;
  const right = size - left - 1;
  const at = (i: number) => x[i < 0 ? 0 : i >= n ? n - 1 : i];
  // deque of virtual indices with decreasing values
  const dq = new Int32Array(n + size + 2);
  let head = 0;
  let tail = 0;
  let next = -left; // next virtual index to push
  for (let i = 0; i < n; i++) {
    const hiIdx = i + right;
    while (next <= hiIdx) {
      const v = at(next);
      while (tail > head && at(dq[tail - 1]) <= v) tail--;
      dq[tail++] = next;
      next++;
    }
    while (dq[head] < i - left) head++;
    out[i] = at(dq[head]);
  }
  return out;
}

/** scipy.ndimage.gaussian_filter1d(x, sigma, mode='nearest'), truncate 4.0, float64. */
export function gaussianFilter1dNearest(x: ArrayLike<number>, sigma: number): Float64Array {
  const n = x.length;
  const out = new Float64Array(n);
  if (n === 0) return out;
  const radius = Math.trunc(4.0 * sigma + 0.5);
  const w = new Float64Array(2 * radius + 1);
  const s2 = sigma * sigma;
  let sum = 0;
  for (let k = -radius; k <= radius; k++) {
    const v = Math.exp((-0.5 / s2) * k * k);
    w[k + radius] = v;
    sum += v;
  }
  for (let k = 0; k < w.length; k++) w[k] /= sum;
  for (let i = 0; i < n; i++) {
    let acc = 0;
    const lo = i - radius;
    if (lo >= 0 && i + radius < n) {
      for (let k = 0; k < w.length; k++) acc += w[k] * x[lo + k];
    } else {
      for (let k = 0; k < w.length; k++) {
        const j = lo + k;
        acc += w[k] * x[j < 0 ? 0 : j >= n ? n - 1 : j];
      }
    }
    out[i] = acc;
  }
  return out;
}

/** Rows scaled to unit length (x / max(‖x‖, 1e-9)), float32, in place. */
export function unitRowsInPlace(x: Float32Array, rows: number, cols: number): Float32Array {
  for (let r = 0; r < rows; r++) {
    let s = 0;
    const o = r * cols;
    for (let c = 0; c < cols; c++) s += x[o + c] * x[o + c];
    const d = Math.max(Math.sqrt(s), 1e-9);
    for (let c = 0; c < cols; c++) x[o + c] = x[o + c] / d;
  }
  return x;
}
