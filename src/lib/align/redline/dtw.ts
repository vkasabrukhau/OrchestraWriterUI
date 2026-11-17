/**
 * Port of redline/align.py `_dtw`: DTW restricted to a band. Row i (score
 * frame) may use audio frames lo[i] .. lo[i]+width−1.
 *
 * Local cost = chroma distance + onset distance.
 * Steps      = both advance (2 × cost), only the score advances, only the
 *              audio advances (1.5 × cost + `detour` each). `detour` is the
 *              toll for leaving the diagonal.
 * Ends       = `skip` < 0 pins the path to both corners. Otherwise audio
 *              before the first and after the last score frame may be left
 *              out at `skip` per frame.
 *
 * Arithmetic follows the numba kernel: accumulated costs are stored as
 * float32, products of float32 features are rounded to float32 before they
 * are summed in float64. Only two rows of accumulated cost are kept (the
 * recurrence never looks further back); the step table is kept whole for the
 * backtrack, so the path is the same as the reference's.
 */

const BIG = Math.fround(1e30);

export interface BandInput {
  /** score chroma, n × dims */
  xc: Float32Array;
  /** audio chroma, m × dims */
  yc: Float32Array;
  dims: number;
  n: number;
  m: number;
  /** onset chroma (n × odims, m × odims) and strengths; unused when onsetWeight is 0 */
  xo?: Float32Array;
  yo?: Float32Array;
  odims?: number;
  xs?: Float32Array;
  ys?: Float32Array;
  lo: Int32Array;
  width: number;
  onsetWeight: number;
  detour: number;
  skip: number;
  /** called once per row band chunk with the fraction done; may throw to cancel */
  tick?: (fraction: number) => void;
}

export interface BandPath {
  /** score frame of each path step, from the start */
  pi: Int32Array;
  /** audio frame of each path step */
  pj: Int32Array;
  cost: number;
}

export function bandDtw(input: BandInput): BandPath {
  const { xc, yc, dims, n, m, lo, width, onsetWeight, detour, skip } = input;
  const xo = input.xo ?? new Float32Array(0);
  const yo = input.yo ?? new Float32Array(0);
  const odims = input.odims ?? 0;
  const xs = input.xs ?? new Float32Array(0);
  const ys = input.ys ?? new Float32Array(0);
  let prev = new Float32Array(width);
  let cur = new Float32Array(width);
  const B = new Int8Array(n * width);
  const every = Math.max(1, Math.floor(n / 100));

  for (let i = 0; i < n; i++) {
    cur.fill(BIG);
    const li = lo[i];
    const lp = i > 0 ? lo[i - 1] : 0;
    const xoff = i * dims;
    const xooff = i * odims;
    const row = i * width;
    for (let k = 0; k < width; k++) {
      const j = li + k;
      if (j < 0 || j >= m) continue;
      let dot = 0.0;
      const yoff = j * dims;
      for (let c = 0; c < dims; c++) dot += Math.fround(xc[xoff + c] * yc[yoff + c]);
      let cost = 1.0 - dot;
      if (onsetWeight > 0.0) {
        let odot = 0.0;
        const yooff = j * odims;
        for (let c = 0; c < odims; c++) odot += Math.fround(xo[xooff + c] * yo[yooff + c]);
        cost += onsetWeight * Math.max(xs[i], ys[j]) * (1.0 - odot);
      }
      let best = BIG;
      let step = 0;
      if (i === 0) {
        if (skip >= 0.0) best = skip * j + cost;
        else if (j === 0) best = cost;
      } else {
        const kd = j - 1 - lp;
        if (kd >= 0 && kd < width && prev[kd] + 2.0 * cost < best) {
          best = prev[kd] + 2.0 * cost;
          step = 1;
        }
        const ku = j - lp;
        if (ku >= 0 && ku < width && prev[ku] + 1.5 * cost + detour < best) {
          best = prev[ku] + 1.5 * cost + detour;
          step = 2;
        }
      }
      if (k > 0 && cur[k - 1] + 1.5 * cost + detour < best) {
        best = cur[k - 1] + 1.5 * cost + detour;
        step = 3;
      }
      cur[k] = best;
      B[row + k] = step;
    }
    const t = prev;
    prev = cur;
    cur = t;
    if (input.tick && i % every === 0) input.tick(i / n);
  }
  const last = prev; // row n − 1

  // where the path leaves the audio
  let i = n - 1;
  let k = 0;
  let best = BIG;
  for (let kk = 0; kk < width; kk++) {
    const j = lo[i] + kk;
    if (j < 0 || j >= m || last[kk] >= BIG) continue;
    const v = skip >= 0.0 ? last[kk] + skip * (m - 1 - j) : j === m - 1 ? last[kk] : BIG;
    if (v < best) {
      best = v;
      k = kk;
    }
  }
  if (best >= BIG) {
    // pinned end outside the band: take the last reachable cell
    for (let kk = 0; kk < width; kk++) if (last[kk] < BIG) k = kk;
    best = last[k];
  }
  const pi = new Int32Array(n + m);
  const pj = new Int32Array(n + m);
  let c = 0;
  for (;;) {
    pi[c] = i;
    pj[c] = lo[i] + k;
    c++;
    const s = B[i * width + k];
    if (s === 1) {
      k = lo[i] + k - 1 - lo[i - 1];
      i -= 1;
    } else if (s === 2) {
      k = lo[i] + k - lo[i - 1];
      i -= 1;
    } else if (s === 3) {
      k -= 1;
    } else break;
  }
  const outI = new Int32Array(c);
  const outJ = new Int32Array(c);
  for (let q = 0; q < c; q++) {
    outI[q] = pi[c - 1 - q];
    outJ[q] = pj[c - 1 - q];
  }
  return { pi: outI, pj: outJ, cost: best };
}
