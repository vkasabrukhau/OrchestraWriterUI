/**
 * Sync Toolbox's recording pitch features, ported to TypeScript for numerical
 * parity with the Python reference ("Integrated tempo from original search").
 *
 *   estimateTuningCents   synctoolbox.feature.utils.estimate_tuning
 *                         (libfmp compute_freq_distribution + tuning_similarity)
 *   designPitchFilterbank synctoolbox.feature.filterbank.generate_filterbank
 *                         (scipy ellipord + ellip(output="sos"), zpk2sos "nearest")
 *   pitchFeatures         synctoolbox.feature.pitch.audio_to_pitch_features
 *                         (resample_poly by 5 twice, sosfiltfilt per band, STMSP)
 *   syncToolboxChroma     pitch_to_chroma + quantize_chroma
 *
 * Isomorphic: no DOM or Node APIs, so it runs in the alignment Web Worker and
 * in Node scripts. Time is recording time throughout; the input is mono audio
 * at 22050 Hz. Frames are 50 per second; frame 0 covers only the first 20 ms
 * (Sync Toolbox's group-delay frame), frame k ≥ 1 covers samples
 * [(k-1)·441, (k-1)·441 + 882).
 *
 * Known deviations from scipy/numpy (all at rounding level): special.ellipk is
 * computed with the AGM instead of cephes' polynomial, sums are not always in
 * numpy's order, the biquads run without fused multiply-adds, and the tuning
 * spectrum is summed in float64 after rounding to float32 like librosa does.
 * The filter output between the two filtfilt passes is stored in float32
 * (state stays float64); on the reference recording the quantized chroma is
 * still identical to Sync Toolbox's.
 *
 * Ported from Sync Toolbox 1.4.2 (MIT, © 2021 Meinard Müller et al.,
 * International Audio Laboratories Erlangen), libfmp 1.3.0 (MIT) and SciPy
 * 1.18 signal / special routines (BSD-3-Clause, © 2001–2002 Enthought, Inc.,
 * 2003 SciPy Developers). The algorithms, not the source text, are ported;
 * the notices are kept here for attribution.
 */

// ---------------------------------------------------------------------------
// Small complex helpers (design time only, so tuples are fine)

type C = [number, number];

const cAdd = (a: C, b: C): C => [a[0] + b[0], a[1] + b[1]];
const cSub = (a: C, b: C): C => [a[0] - b[0], a[1] - b[1]];
const cMul = (a: C, b: C): C => [a[0] * b[0] - a[1] * b[1], a[0] * b[1] + a[1] * b[0]];
const cNeg = (a: C): C => [-a[0], -a[1]];
const cConj = (a: C): C => [a[0], -a[1]];
const cAbs = (a: C): number => Math.hypot(a[0], a[1]);
const isReal = (a: C): boolean => a[1] === 0;

/** Smith's algorithm, as numpy's complex division */
function cDiv(a: C, b: C): C {
  const [ar, ai] = a;
  const [br, bi] = b;
  if (Math.abs(br) >= Math.abs(bi)) {
    if (br === 0 && bi === 0) return [ar / Math.abs(br), ai / Math.abs(bi)];
    const rat = bi / br;
    const scl = 1.0 / (br + bi * rat);
    return [(ar + ai * rat) * scl, (ai - ar * rat) * scl];
  }
  const rat = br / bi;
  const scl = 1.0 / (bi + br * rat);
  return [(ar * rat + ai) * scl, (ai * rat - ar) * scl];
}

/** Principal square root (C99 csqrt) */
function cSqrt(a: C): C {
  const [x, y] = a;
  if (x === 0 && y === 0) return [0, y];
  const t = Math.hypot(x, y);
  if (x >= 0) {
    const r = Math.sqrt((x + t) * 0.5);
    return [r, y / (2 * r)];
  }
  const r = Math.sqrt((-x + t) * 0.5);
  return [Math.abs(y) / (2 * r), y < 0 || Object.is(y, -0) ? -r : r];
}

/** numpy's pairwise summation for a contiguous float64 vector */
function npSum(a: ArrayLike<number>, off = 0, n = a.length): number {
  if (n < 8) {
    let res = 0;
    for (let i = 0; i < n; i++) res += a[off + i];
    return res;
  }
  if (n <= 128) {
    const r = [a[off], a[off + 1], a[off + 2], a[off + 3], a[off + 4], a[off + 5], a[off + 6], a[off + 7]];
    let i = 8;
    for (; i < n - (n % 8); i += 8) for (let j = 0; j < 8; j++) r[j] += a[off + i + j];
    let res = r[0] + r[1] + (r[2] + r[3]) + (r[4] + r[5] + (r[6] + r[7]));
    for (; i < n; i++) res += a[off + i];
    return res;
  }
  let n2 = Math.floor(n / 2);
  n2 -= n2 % 8;
  return npSum(a, off, n2) + npSum(a, off + n2, n - n2);
}

// ---------------------------------------------------------------------------
// Elliptic functions (scipy.special equivalents)

const MACHEP = 1.11022302462515654042e-16;

/** K(m) = π / (2·AGM(1, √(1−m))) */
function agmK(b0: number): number {
  let a = 1;
  let b = b0;
  for (let i = 0; i < 64 && Math.abs(a - b) > 1e-16 * a; i++) {
    const an = (a + b) / 2;
    b = Math.sqrt(a * b);
    a = an;
  }
  return Math.PI / (2 * a);
}

/** scipy.special.ellipk(m), complete elliptic integral of the first kind (parameter m) */
export function ellipk(m: number): number {
  if (m === 1) return Infinity;
  return agmK(Math.sqrt(1 - m));
}

/** scipy.special.ellipkm1(p) = K(1 − p), accurate for small p */
export function ellipkm1(p: number): number {
  if (p === 0) return Infinity;
  return agmK(Math.sqrt(p));
}

/** cephes ellpj: Jacobi elliptic functions sn, cn, dn of (u | m) */
export function ellipj(u: number, m: number): { sn: number; cn: number; dn: number; ph: number } {
  if (!(m >= 0 && m <= 1)) return { sn: NaN, cn: NaN, dn: NaN, ph: NaN };
  if (m < 1.0e-9) {
    const t = Math.sin(u);
    const b = Math.cos(u);
    const ai = 0.25 * m * (u - t * b);
    return { sn: t - ai * b, cn: b + ai * t, ph: u - ai, dn: 1.0 - 0.5 * m * t * t };
  }
  if (m >= 0.9999999999) {
    let ai = 0.25 * (1.0 - m);
    const b = Math.cosh(u);
    const t = Math.tanh(u);
    const phi = 1.0 / b;
    const twon = b * Math.sinh(u);
    const sn = t + (ai * (twon - u)) / (b * b);
    const ph = 2.0 * Math.atan(Math.exp(u)) - Math.PI / 2 + (ai * (twon - u)) / b;
    ai *= t * phi;
    return { sn, ph, cn: phi - ai * (twon - u), dn: phi + ai * (twon + u) };
  }
  const a = new Float64Array(9);
  const c = new Float64Array(9);
  a[0] = 1.0;
  let b = Math.sqrt(1.0 - m);
  c[0] = Math.sqrt(m);
  let twon = 1.0;
  let i = 0;
  while (Math.abs(c[i] / a[i]) > MACHEP) {
    if (i > 7) break;
    const ai = a[i];
    ++i;
    c[i] = (ai - b) / 2.0;
    const t = Math.sqrt(ai * b);
    a[i] = (ai + b) / 2.0;
    b = t;
    twon *= 2.0;
  }
  let phi = twon * a[i] * u;
  let bb = 0;
  do {
    const t = (c[i] * Math.sin(phi)) / a[i];
    bb = phi;
    phi = (Math.asin(t) + phi) / 2.0;
  } while (--i);
  const sn = Math.sin(phi);
  const t = Math.cos(phi);
  const dnfac = Math.cos(phi - bb);
  const dn = Math.abs(dnfac) < 0.1 ? Math.sqrt(1 - m * sn * sn) : t / dnfac;
  return { sn, cn: t, dn, ph: phi };
}

const pow10m1 = (x: number) => Math.expm1(Math.LN10 * x);

/** scipy _ellipdeg: solve the degree equation with nomes */
function ellipdeg(n: number, m1: number): number {
  const K1 = ellipk(m1);
  const K1p = ellipkm1(m1);
  const q1 = Math.exp((-Math.PI * K1p) / K1);
  const q = q1 ** (1 / n);
  const num: number[] = [];
  const den: number[] = [];
  for (let k = 0; k <= 7; k++) num.push(q ** (k * (k + 1)));
  for (let k = 1; k <= 8; k++) den.push(q ** (k * k));
  const r = npSum(num) / (1 + 2 * npSum(den));
  return 16 * q * r ** 4;
}

/** scipy _arc_jac_sc1(w, m): real z with w = sc(z, 1 − m), via Landen on purely imaginary sn */
function arcJacSc1(w: number, m: number): number {
  const complement = (kx: number) => ((1 - kx) * (1 + kx)) ** 0.5;
  const k = m ** 0.5;
  if (k > 1) return NaN;
  if (k === 1) return Math.atan(w); // arctanh(i·w) = i·atan(w)
  const ks = [k];
  let niter = 0;
  while (ks[ks.length - 1] !== 0) {
    const kp = complement(ks[ks.length - 1]);
    ks.push((1 - kp) / (1 + kp));
    if (++niter > 10) throw new Error("Landen transformation not converging");
  }
  let K = 1;
  for (let i = 1; i < ks.length; i++) K *= 1 + ks[i];
  K *= Math.PI / 2;
  // w_n = i·y_n stays purely imaginary: (1 − i·a)(1 + i·a) = 1 + a²
  let y = w;
  for (let i = 0; i + 1 < ks.length; i++) {
    const a = ks[i] * y;
    y = (2 * y) / ((1 + ks[i + 1]) * (1 + Math.sqrt(1 + a * a)));
  }
  // arcsin(i·y) = i·asinh(y)
  return K * ((2 / Math.PI) * Math.asinh(y));
}

interface Zpk {
  z: C[];
  p: C[];
  k: number;
}

const EPSILON = 2e-16;

/** scipy.signal.ellipap */
function ellipap(N: number, rp: number, rs: number): Zpk {
  if (N === 1) {
    const p = -Math.sqrt(1.0 / pow10m1(0.1 * rp));
    return { z: [], p: [[p, 0]], k: -p };
  }
  const epsSq = pow10m1(0.1 * rp);
  const eps = Math.sqrt(epsSq);
  const ck1Sq = epsSq / pow10m1(0.1 * rs);
  const val0 = ellipk(ck1Sq);
  const m = ellipdeg(N, ck1Sq);
  const capk = ellipk(m);
  const js: number[] = [];
  for (let j = 1 - (N % 2); j < N; j += 2) js.push(j);
  const scd = js.map((j) => ellipj((j * capk) / N, m));
  const zs: C[] = [];
  for (const { sn } of scd) if (Math.abs(sn) > EPSILON) zs.push([0, 1.0 / (Math.sqrt(m) * sn)]);
  const z: C[] = [...zs, ...zs.map(cConj)];
  const r = arcJacSc1(1 / eps, ck1Sq);
  const v0 = (capk * r) / (N * val0);
  const { sn: sv, cn: cv, dn: dv } = ellipj(v0, 1 - m);
  let p: C[] = scd.map(({ sn: s, cn: c, dn: d }) => {
    const den = 1 - (d * sv) ** 2.0;
    return cDiv(cNeg([c * d * sv * cv, s * dv]), [den, 0]);
  });
  if (N % 2) {
    let ss = 0;
    for (const q of p) ss += cMul(q, cConj(q))[0];
    const thr = EPSILON * Math.sqrt(ss);
    const newp = p.filter((q) => Math.abs(q[1]) > thr);
    p = [...p, ...newp.map(cConj)];
  } else {
    p = [...p, ...p.map(cConj)];
  }
  let pp: C = [1, 0];
  for (const q of p) pp = cMul(pp, cNeg(q));
  let pz: C = [1, 0];
  for (const q of z) pz = cMul(pz, cNeg(q));
  let k = cDiv(pp, pz)[0];
  if (N % 2 === 0) k = k / Math.sqrt(1 + epsSq);
  return { z, p, k };
}

/** scipy.signal.lp2bp_zpk */
function lp2bpZpk({ z, p, k }: Zpk, wo: number, bw: number): Zpk {
  const degree = p.length - z.length;
  const shift = (list: C[]): C[] => {
    const lp = list.map((q): C => [(q[0] * bw) / 2, (q[1] * bw) / 2]);
    const roots = lp.map((q) => cSqrt(cSub(cMul(q, q), [wo ** 2, 0])));
    return [...lp.map((q, i) => cAdd(q, roots[i])), ...lp.map((q, i) => cSub(q, roots[i]))];
  };
  const zbp = shift(z);
  for (let i = 0; i < degree; i++) zbp.push([0, 0]);
  return { z: zbp, p: shift(p), k: k * bw ** degree };
}

/** scipy.signal.bilinear_zpk */
function bilinearZpk({ z, p, k }: Zpk, fs: number): Zpk {
  const degree = p.length - z.length;
  const fs2: C = [2.0 * fs, 0];
  const zz = z.map((q) => cDiv(cAdd(fs2, q), cSub(fs2, q)));
  const pz = p.map((q) => cDiv(cAdd(fs2, q), cSub(fs2, q)));
  for (let i = 0; i < degree; i++) zz.push([-1, 0]);
  let nz: C = [1, 0];
  for (const q of z) nz = cMul(nz, cSub(fs2, q));
  let np: C = [1, 0];
  for (const q of p) np = cMul(np, cSub(fs2, q));
  return { z: zz, p: pz, k: k * cDiv(nz, np)[0] };
}

/** scipy _cplxreal: complex conjugate pairs (positive imaginary part) and real values */
function cplxreal(zIn: C[]): { zc: C[]; zr: number[] } {
  if (zIn.length === 0) return { zc: [], zr: [] };
  const tol = 100 * 2.220446049250313e-16;
  const z = zIn
    .map((q, i) => ({ q, i }))
    .sort((a, b) => a.q[0] - b.q[0] || Math.abs(a.q[1]) - Math.abs(b.q[1]) || a.i - b.i)
    .map((e) => e.q);
  const realMask = z.map((q) => Math.abs(q[1]) <= tol * cAbs(q));
  const zr = z.filter((_, i) => realMask[i]).map((q) => q[0]);
  if (zr.length === z.length) return { zc: [], zr };
  const zz = z.filter((_, i) => !realMask[i]);
  const zp = zz.filter((q) => q[1] > 0);
  const zn = zz.filter((q) => q[1] < 0);
  if (zp.length !== zn.length) throw new Error("Array contains complex value with no matching conjugate.");
  // re-sort runs with the same real part by |imag|
  const same: boolean[] = [];
  for (let i = 0; i + 1 < zp.length; i++) same.push(zp[i + 1][0] - zp[i][0] <= tol * cAbs(zp[i]));
  let i = 0;
  while (i < same.length) {
    if (!same[i]) {
      i++;
      continue;
    }
    const start = i;
    while (i < same.length && same[i]) i++;
    const stop = i + 1;
    for (const chunk of [zp, zn]) {
      const part = chunk.slice(start, stop).map((q, j) => ({ q, j }));
      part.sort((a, b) => Math.abs(a.q[1]) - Math.abs(b.q[1]) || a.j - b.j);
      part.forEach((e, j) => (chunk[start + j] = e.q));
    }
  }
  for (let j = 0; j < zp.length; j++) {
    if (cAbs(cSub(zp[j], cConj(zn[j]))) > tol * cAbs(zn[j])) throw new Error("Array contains complex value with no matching conjugate.");
  }
  const zc = zp.map((q, j): C => {
    const s = cAdd(q, cConj(zn[j]));
    return [s[0] / 2, s[1] / 2];
  });
  return { zc, zr };
}

/** np.poly for up to two roots, real when the roots are conjugate/real */
function poly(roots: C[]): number[] {
  let a: C[] = [[1, 0]];
  for (const r of roots) {
    const v: C[] = [[1, 0], cNeg(r)];
    const out: C[] = [];
    for (let n = 0; n < a.length + 1; n++) {
      let s: C = [0, 0];
      let first = true;
      for (let k = 0; k < a.length; k++) {
        const j = n - k;
        if (j < 0 || j > 1) continue;
        const t = cMul(a[k], v[j]);
        s = first ? t : cAdd(s, t);
        first = false;
      }
      out.push(s);
    }
    a = out;
  }
  return a.map((q) => q[0]);
}

function singleZpkSos(z: C[], p: C[]): number[] {
  const sos = [0, 0, 0, 0, 0, 0];
  const b = poly(z);
  const a = poly(p);
  for (let i = 0; i < b.length; i++) sos[3 - b.length + i] = b[i];
  for (let i = 0; i < a.length; i++) sos[6 - a.length + i] = a[i];
  return sos;
}

function argsortStable(v: number[]): number[] {
  return v.map((x, i) => ({ x, i })).sort((a, b) => a.x - b.x || a.i - b.i).map((e) => e.i);
}

function nearestIdx(fro: C[], to: C, which: "real" | "complex" | "any"): number {
  const order = argsortStable(fro.map((q) => cAbs(cSub(q, to))));
  if (which === "any") return order[0];
  for (const i of order) if (isReal(fro[i]) === (which === "real")) return i;
  throw new Error("no matching zero");
}

/** scipy.signal.zpk2sos with pairing="nearest" (digital) */
function zpk2sos({ z: z0, p: p0, k }: Zpk): number[][] {
  let p = [...p0];
  let z = [...z0];
  while (p.length < z.length) p.push([0, 0]);
  while (z.length < p.length) z.push([0, 0]);
  const nSections = Math.floor((Math.max(p.length, z.length) + 1) / 2);
  if (p.length % 2 === 1) {
    p.push([0, 0]);
    z.push([0, 0]);
  }
  const zs = cplxreal(z);
  z = [...zs.zc, ...zs.zr.map((r): C => [r, 0])];
  const ps = cplxreal(p);
  p = [...ps.zc, ...ps.zr.map((r): C => [r, 0])];
  const idxWorst = (list: C[]) => {
    let best = 0;
    for (let i = 1; i < list.length; i++) if (Math.abs(1 - cAbs(list[i])) < Math.abs(1 - cAbs(list[best]))) best = i;
    return best;
  };
  const take = (list: C[], i: number): C => list.splice(i, 1)[0];
  const sos: number[][] = Array.from({ length: nSections }, () => [0, 0, 0, 0, 0, 0]);
  for (let si = nSections - 1; si >= 0; si--) {
    const p1 = take(p, idxWorst(p));
    const nRealP = p.filter(isReal).length;
    if (isReal(p1) && nRealP === 0) {
      const z1 = take(z, nearestIdx(z, p1, "real"));
      sos[si] = singleZpkSos([z1, [0, 0]], [p1, [0, 0]]);
    } else if (p.length + 1 === z.length && !isReal(p1) && nRealP === 1 && z.filter(isReal).length === 1) {
      const z1 = take(z, nearestIdx(z, p1, "complex"));
      sos[si] = singleZpkSos([z1, cConj(z1)], [p1, cConj(p1)]);
    } else {
      let p2: C;
      if (isReal(p1)) {
        const realIdx = p.map((q, i) => (isReal(q) ? i : -1)).filter((i) => i >= 0);
        p2 = take(p, realIdx[idxWorst(realIdx.map((i) => p[i]))]);
      } else {
        p2 = cConj(p1);
      }
      if (z.length > 0) {
        const z1 = take(z, nearestIdx(z, p1, "any"));
        if (!isReal(z1)) {
          sos[si] = singleZpkSos([z1, cConj(z1)], [p1, p2]);
        } else if (z.length > 0) {
          const z2 = take(z, nearestIdx(z, p1, "real"));
          sos[si] = singleZpkSos([z1, z2], [p1, p2]);
        } else {
          sos[si] = singleZpkSos([z1], [p1, p2]);
        }
      } else {
        sos[si] = singleZpkSos([], [p1, p2]);
      }
    }
  }
  for (let i = 0; i < 3; i++) sos[0][i] *= k;
  return sos;
}

/** scipy.signal.ellipord for a digital bandpass: returns order and natural frequencies */
export function ellipordBandpass(wp: [number, number], ws: [number, number], gpass: number, gstop: number): { order: number; wn: [number, number] } {
  const passb = wp.map((w) => Math.tan((Math.PI * w) / 2.0));
  const stopb = ws.map((w) => Math.tan((Math.PI * w) / 2.0));
  const nat = Math.min(...stopb.map((s) => Math.abs((s ** 2 - passb[0] * passb[1]) / (s * (passb[0] - passb[1])))));
  const arg1Sq = pow10m1(0.1 * gpass) / pow10m1(0.1 * gstop);
  const arg0 = 1.0 / nat;
  const d00 = ellipk(arg0 ** 2);
  const d01 = ellipkm1(arg0 ** 2);
  const d10 = ellipk(arg1Sq);
  const d11 = ellipkm1(arg1Sq);
  const order = Math.ceil((d00 * d11) / (d01 * d10));
  const wn = passb.map((b) => (Math.atan(b) * 2.0) / Math.PI) as [number, number];
  return { order, wn };
}

/** scipy.signal.ellip(N, rp, rs, Wn, btype="bandpass", output="sos"); rows [b0 b1 b2 a0 a1 a2] */
export function ellipBandpassSos(N: number, rp: number, rs: number, wn: [number, number]): Float64Array {
  const fs = 2.0;
  const warped = wn.map((w) => 2 * fs * Math.tan((Math.PI * w) / fs));
  const bw = warped[1] - warped[0];
  const wo = Math.sqrt(warped[0] * warped[1]);
  const sos = zpk2sos(bilinearZpk(lp2bpZpk(ellipap(N, rp, rs), wo, bw), fs));
  const out = new Float64Array(sos.length * 6);
  sos.forEach((row, i) => out.set(row, i * 6));
  return out;
}

// ---------------------------------------------------------------------------
// Filterbank

export const SAMPLE_RATE = 22050;
export const FEATURE_RATE = 50;
/** lowest and highest pitch in the features (Sync Toolbox midi_min / midi_max) */
export const PITCH_MIN = 21;
export const PITCH_MAX = 108;
export const PITCH_COUNT = PITCH_MAX - PITCH_MIN + 1;
const BAND_RATES = [22050, 4410, 882] as const;
const BANDS = [
  { fs: 22050, min: 96, max: 120 },
  { fs: 4410, min: 60, max: 95 },
  { fs: 882, min: 21, max: 59 },
];

/** which downsampled signal a pitch is filtered at: 0 = 22050, 1 = 4410, 2 = 882 Hz */
export function bandIndex(pitch: number): 0 | 1 | 2 {
  if (pitch >= 21 && pitch <= 59) return 2;
  if (pitch >= 60 && pitch <= 95) return 1;
  if (pitch >= 96 && pitch <= 120) return 0;
  throw new RangeError(`Invalid MIDI pitch ${pitch}; choose 21–120`);
}

/**
 * Sync Toolbox generate_filterbank: one elliptic bandpass per MIDI pitch
 * 21–120 (Q 25, stop 2, 1 dB ripple, 50 dB stopband), centred on the pitch
 * shifted by `cents`, designed at the band's sample rate. Values are sos rows
 * of six coefficients (b0 b1 b2 a0 a1 a2), row-major.
 */
export function designPitchFilterbank(cents: number, Q = 25.0, stop = 2.0, Rp = 1.0, Rs = 50.0): Map<number, Float64Array> {
  const passRel = 1 / (2 * Q);
  const stopRel = passRel * stop;
  const h = new Map<number, Float64Array>();
  for (const band of BANDS) {
    const nyq = band.fs / 2;
    for (let p = band.min; p <= band.max; p++) {
      const f = 2 ** ((p - 69 + cents / 100) / 12) * 440.0;
      const wp: [number, number] = [(f - passRel * f) / nyq, (f + passRel * f) / nyq];
      const ws: [number, number] = [(f - stopRel * f) / nyq, (f + stopRel * f) / nyq];
      const { order, wn } = ellipordBandpass(wp, ws, Rp, Rs);
      h.set(p, ellipBandpassSos(order, Rp, Rs, wn));
    }
  }
  return h;
}

// ---------------------------------------------------------------------------
// Resampling (scipy.signal.resample_poly with Sync Toolbox's Kaiser FIR)

/** modified Bessel function of the first kind, order 0 (power series) */
function besselI0(x: number): number {
  const q = (x / 2) ** 2;
  let term = 1;
  let sum = 1;
  for (let k = 1; k < 500; k++) {
    term *= q / (k * k);
    sum += term;
    if (term < sum * 1e-17) break;
  }
  return sum;
}

/** scipy.signal.firwin(numtaps, cutoff, window=("kaiser", beta)), lowpass, scaled */
export function firwinKaiser(numtaps: number, cutoff: number, beta: number): Float64Array {
  const alpha = 0.5 * (numtaps - 1);
  const h = new Float64Array(numtaps);
  const i0b = besselI0(beta);
  const wAlpha = (numtaps - 1) / 2.0;
  for (let n = 0; n < numtaps; n++) {
    const m = n - alpha;
    const x = cutoff * m;
    const y = Math.PI * (x === 0 ? 1.0e-20 : x);
    const sinc = Math.sin(y) / y;
    const r = (n - wAlpha) / wAlpha;
    const win = besselI0(beta * Math.sqrt(1 - r ** 2.0)) / i0b;
    h[n] = cutoff * sinc * win;
  }
  const s = npSum(h);
  for (let n = 0; n < numtaps; n++) h[n] /= s;
  return h;
}

let kaiser5: Float64Array | null = null;
/** synctoolbox __design_kaiser_win(up=1, down=5): firwin(1001, 1/5, ("kaiser", 5.0)) */
function kaiserDown5(): Float64Array {
  return (kaiser5 ??= firwinKaiser(1001, 1 / 5, 5.0));
}

/**
 * scipy.signal.resample_poly(x, up=1, down=5, window=h) with a symmetric
 * 1001-tap h: y[j] = Σ_i h[i]·x[5j + 500 − i], zeros outside x,
 * length ceil(n / 5).
 */
export function decimate5(x: ArrayLike<number>): Float64Array {
  const h = kaiserDown5();
  const half = (h.length - 1) >> 1;
  const n = x.length;
  const nOut = Math.ceil(n / 5);
  const y = new Float64Array(nOut);
  for (let j = 0; j < nOut; j++) {
    const c = 5 * j;
    let acc = h[half] * x[c];
    const kMax = Math.min(half, n - 1 - c, c);
    let k = 1;
    for (; k <= kMax; k++) acc += h[half - k] * (x[c + k] + x[c - k]);
    for (; k <= half; k++) {
      const r = c + k;
      const l = c - k;
      if (r < n) acc += h[half - k] * x[r];
      if (l >= 0) acc += h[half - k] * x[l];
    }
    y[j] = acc;
  }
  return y;
}

// ---------------------------------------------------------------------------
// Zero-phase filtering (scipy.signal.sosfiltfilt, padtype="odd")

/** sosfilt_zi: steady-state state per section for a unit step */
function sosfiltZi(sos: Float64Array): Float64Array {
  const n = sos.length / 6;
  const zi = new Float64Array(n * 2);
  let scale = 1.0;
  for (let s = 0; s < n; s++) {
    let b0 = sos[s * 6];
    let b1 = sos[s * 6 + 1];
    let b2 = sos[s * 6 + 2];
    let a0 = sos[s * 6 + 3];
    let a1 = sos[s * 6 + 4];
    let a2 = sos[s * 6 + 5];
    if (a0 !== 1) {
      b0 /= a0;
      b1 /= a0;
      b2 /= a0;
      a1 /= a0;
      a2 /= a0;
      a0 = 1;
    }
    const yInf = (b0 + b1 + b2) / (a0 + a1 + a2);
    const d1 = b1 - yInf * a1;
    const d2 = b2 - yInf * a2;
    zi[s * 2] = scale * (d2 + d1);
    zi[s * 2 + 1] = scale * d2;
    scale *= (sos[s * 6] + sos[s * 6 + 1] + sos[s * 6 + 2]) / (sos[s * 6 + 3] + sos[s * 6 + 4] + sos[s * 6 + 5]);
  }
  return zi;
}

/** sosfiltfilt's default pad length for this sos */
export function sosPadLength(sos: Float64Array): number {
  const n = sos.length / 6;
  let zb = 0;
  let za = 0;
  for (let s = 0; s < n; s++) {
    if (sos[s * 6 + 2] === 0) zb++;
    if (sos[s * 6 + 5] === 0) za++;
  }
  return 3 * (2 * n + 1 - Math.min(zb, za));
}

/**
 * Run the cascade over buf[from..to) (step +1) or buf[to-1..from] (step −1)
 * in place, every section starting from zi·x0. Sample-major so the
 * sections' recurrences overlap in the CPU; same arithmetic as scipy's
 * _sosfilt (direct form II transposed).
 */
function cascade(sos: Float64Array, zi: Float64Array, x0: number, buf: Float32Array | Float64Array, from: number, to: number, forward: boolean): void {
  const n = sos.length / 6;
  if (n === 4 || n === 5) {
    const b00 = sos[0], b01 = sos[1], b02 = sos[2], a01 = sos[4], a02 = sos[5];
    const b10 = sos[6], b11 = sos[7], b12 = sos[8], a11 = sos[10], a12 = sos[11];
    const b20 = sos[12], b21 = sos[13], b22 = sos[14], a21 = sos[16], a22 = sos[17];
    const b30 = sos[18], b31 = sos[19], b32 = sos[20], a31 = sos[22], a32 = sos[23];
    let z00 = zi[0] * x0, z01 = zi[1] * x0;
    let z10 = zi[2] * x0, z11 = zi[3] * x0;
    let z20 = zi[4] * x0, z21 = zi[5] * x0;
    let z30 = zi[6] * x0, z31 = zi[7] * x0;
    if (n === 4) {
      const start = forward ? from : to - 1;
      const end = forward ? to : from - 1;
      const step = forward ? 1 : -1;
      for (let i = start; i !== end; i += step) {
        const x = buf[i];
        const y0 = b00 * x + z00;
        z00 = b01 * x - a01 * y0 + z01;
        z01 = b02 * x - a02 * y0;
        const y1 = b10 * y0 + z10;
        z10 = b11 * y0 - a11 * y1 + z11;
        z11 = b12 * y0 - a12 * y1;
        const y2 = b20 * y1 + z20;
        z20 = b21 * y1 - a21 * y2 + z21;
        z21 = b22 * y1 - a22 * y2;
        const y3 = b30 * y2 + z30;
        z30 = b31 * y2 - a31 * y3 + z31;
        z31 = b32 * y2 - a32 * y3;
        buf[i] = y3;
      }
      return;
    }
    const b40 = sos[24], b41 = sos[25], b42 = sos[26], a41 = sos[28], a42 = sos[29];
    let z40 = zi[8] * x0, z41 = zi[9] * x0;
    const start = forward ? from : to - 1;
    const end = forward ? to : from - 1;
    const step = forward ? 1 : -1;
    for (let i = start; i !== end; i += step) {
      const x = buf[i];
      const y0 = b00 * x + z00;
      z00 = b01 * x - a01 * y0 + z01;
      z01 = b02 * x - a02 * y0;
      const y1 = b10 * y0 + z10;
      z10 = b11 * y0 - a11 * y1 + z11;
      z11 = b12 * y0 - a12 * y1;
      const y2 = b20 * y1 + z20;
      z20 = b21 * y1 - a21 * y2 + z21;
      z21 = b22 * y1 - a22 * y2;
      const y3 = b30 * y2 + z30;
      z30 = b31 * y2 - a31 * y3 + z31;
      z31 = b32 * y2 - a32 * y3;
      const y4 = b40 * y3 + z40;
      z40 = b41 * y3 - a41 * y4 + z41;
      z41 = b42 * y3 - a42 * y4;
      buf[i] = y4;
    }
    return;
  }
  // generic: section-major (bit-identical to sample-major)
  for (let s = 0; s < n; s++) {
    const b0 = sos[s * 6], b1 = sos[s * 6 + 1], b2 = sos[s * 6 + 2], a0 = sos[s * 6 + 3], a1 = sos[s * 6 + 4] / a0, a2 = sos[s * 6 + 5] / a0;
    const c0 = b0 / a0, c1 = b1 / a0, c2 = b2 / a0;
    let z0 = zi[s * 2] * x0;
    let z1 = zi[s * 2 + 1] * x0;
    if (forward) {
      for (let i = from; i < to; i++) {
        const x = buf[i];
        const y = c0 * x + z0;
        z0 = c1 * x - a1 * y + z1;
        z1 = c2 * x - a2 * y;
        buf[i] = y;
      }
    } else {
      for (let i = to - 1; i >= from; i--) {
        const x = buf[i];
        const y = c0 * x + z0;
        z0 = c1 * x - a1 * y + z1;
        z1 = c2 * x - a2 * y;
        buf[i] = y;
      }
    }
  }
}

/**
 * scipy.signal.sosfiltfilt(sos, x) (padtype "odd", default padlen). Writes the
 * padded, filtered signal into `work` (length ≥ x.length + 2·pad) and returns
 * the pad: the result is work[pad .. pad + x.length). A Float32Array input is
 * extended in float32 like numpy does.
 */
export function sosfiltfiltInto(sos: Float64Array, x: Float32Array | Float64Array, work: Float32Array | Float64Array): number {
  const L = x.length;
  const edge = sosPadLength(sos);
  if (L <= edge) throw new RangeError(`The length of the input vector x must be greater than padlen, which is ${edge}.`);
  const f32 = x instanceof Float32Array;
  const x0 = x[0];
  const xl = x[L - 1];
  for (let i = 0; i < edge; i++) {
    const v = 2 * x0 - x[edge - i];
    work[i] = f32 ? Math.fround(v) : v;
    const w = 2 * xl - x[L - 2 - i];
    work[edge + L + i] = f32 ? Math.fround(w) : w;
  }
  for (let i = 0; i < L; i++) work[edge + i] = x[i];
  const total = L + 2 * edge;
  const zi = sosfiltZi(sos);
  cascade(sos, zi, work[0], work, 0, total, true);
  cascade(sos, zi, work[total - 1], work, 0, total, false);
  return edge;
}

/** convenience wrapper returning a new array (tests and parity scripts) */
export function sosfiltfilt(sos: Float64Array, x: Float32Array | Float64Array): Float64Array {
  const work = new Float64Array(x.length + 2 * sosPadLength(sos));
  const edge = sosfiltfiltInto(sos, x, work);
  return work.slice(edge, edge + x.length);
}

// ---------------------------------------------------------------------------
// Pitch features (STMSP) and chroma

export interface PitchFeatures {
  /** number of frames (50 per second) */
  n: number;
  /** frame-major, PITCH_COUNT values per frame; index (frame · 88) + (pitch − 21) */
  pitch: Float64Array;
}

/**
 * Sync Toolbox audio_to_pitch_features(f_audio, Fs=22050, feature_rate=50,
 * tuning_offset=cents) for pitches 21–108. `x` must be mono at 22050 Hz.
 * `tick` gets 0–1 progress and may throw to abort.
 */
export function pitchFeatures(x: Float32Array, cents: number, tick?: (fraction: number) => void): PitchFeatures {
  const fs = SAMPLE_RATE;
  const L = x.length;
  const h = designPitchFilterbank(cents);
  const ds1 = decimate5(x);
  tick?.(0.08);
  const ds2 = decimate5(ds1);
  tick?.(0.1);
  const wav: Array<Float32Array | Float64Array> = [x, ds1, ds2];

  const winLen = (fs / FEATURE_RATE) * 2; // 882
  const step = Math.trunc(winLen / 2); // 441
  const groupDelay = Math.round(winLen / 2); // 441
  const nSeg = Math.ceil(L / step);
  const n = 1 + nSeg;
  const segStart = new Float64Array(n);
  const segStop = new Float64Array(n);
  segStart[0] = 1;
  for (let k = 0; k < nSeg; k++) segStart[k + 1] = 1 + k * step;
  for (let k = 0; k < n; k++) segStop[k] = Math.min(segStart[k] + winLen, L);
  segStop[0] = Math.min(groupDelay, L);

  let maxPad = 0;
  for (let p = PITCH_MIN; p <= PITCH_MAX; p++) maxPad = Math.max(maxPad, sosPadLength(h.get(p)!));
  // filter output between the two passes in float32 (state stays float64): half the memory of the longest band
  const work = new Float32Array(L + 2 * maxPad);
  const pitch = new Float64Array(n * PITCH_COUNT);
  const startIdx = new Int32Array(n);
  const stopIdx = new Int32Array(n);
  const pStart = new Float64Array(n);
  const pStop = new Float64Array(n);

  // progress weight: samples × sections × 2 passes
  let total = 0;
  for (let p = PITCH_MIN; p <= PITCH_MAX; p++) total += wav[bandIndex(p)].length * h.get(p)!.length;
  let done = 0;

  for (let p = PITCH_MIN; p <= PITCH_MAX; p++) {
    const b = bandIndex(p);
    const sig = wav[b];
    const sos = h.get(p)!;
    const edge = sosfiltfiltInto(sos, sig, work);
    const rate = BAND_RATES[b];
    for (let k = 0; k < n; k++) {
      startIdx[k] = Math.floor((segStart[k] / fs) * rate);
      stopIdx[k] = Math.floor((segStop[k] / fs) * rate);
    }
    // prefix sums of the squared output, read at the window edges
    // (both index lists are non-decreasing except the group-delay frame 0)
    let cum = 0;
    let ks = 0;
    let kt = 0;
    const len = sig.length;
    const order = (idx: Int32Array) => {
      const o = Array.from(idx.keys());
      o.sort((a, c) => idx[a] - idx[c] || a - c);
      return Int32Array.from(o);
    };
    const os = order(startIdx);
    const ot = order(stopIdx);
    for (let i = 0; i <= len; i++) {
      while (ks < n && startIdx[os[ks]] === i) pStart[os[ks++]] = cum;
      while (kt < n && stopIdx[ot[kt]] === i) pStop[ot[kt++]] = cum;
      if (i < len) {
        const v = work[edge + i];
        cum += v * v;
      }
    }
    const factor = fs / rate;
    const row = p - PITCH_MIN;
    for (let k = 0; k < n; k++) pitch[k * PITCH_COUNT + row] = (pStop[k] - pStart[k]) * factor;
    done += sig.length * sos.length;
    tick?.(0.1 + (0.9 * done) / total);
  }
  return { n, pitch };
}

/** pitch_to_chroma (rows 21–108 → pitch class p mod 12), frame-major float64 */
export function pitchToChroma(f: PitchFeatures): Float64Array {
  const out = new Float64Array(f.n * 12);
  for (let k = 0; k < f.n; k++) {
    for (let p = PITCH_MIN; p <= PITCH_MAX; p++) out[k * 12 + (p % 12)] += f.pitch[k * PITCH_COUNT + p - PITCH_MIN];
  }
  return out;
}

const QUANT_STEPS = [40 / 100, 20 / 100, 10 / 100, 5 / 100];
const QUANT_WEIGHT = 1 / 4;
const NORM_THRESH = 0.001;

/**
 * quantize_chroma: L1-normalize each frame unless no entry exceeds 0.001 (then
 * the frame stays all zeros), then add 0.25 per threshold 0.4/0.2/0.1/0.05
 * strictly exceeded. Frame-major in, frame-major float32 out.
 */
export function quantizeChroma(chroma: Float64Array, n: number): Float32Array {
  const out = new Float32Array(n * 12);
  for (let k = 0; k < n; k++) {
    const o = k * 12;
    let any = false;
    for (let c = 0; c < 12; c++) if (chroma[o + c] > NORM_THRESH) any = true;
    if (!any) continue;
    const e = npSum(chroma, o, 12);
    for (let c = 0; c < 12; c++) {
      const d = chroma[o + c] / e;
      let q = 0;
      for (const s of QUANT_STEPS) if (d > s) q += QUANT_WEIGHT;
      out[o + c] = q;
    }
  }
  return out;
}

/** Sync Toolbox recording chroma: quantize_chroma(pitch_to_chroma(audio_to_pitch_features(x))) */
export function syncToolboxChroma(x: Float32Array, cents: number, tick?: (fraction: number) => void): { n: number; chroma: Float32Array } {
  const f = pitchFeatures(x, cents, tick);
  return { n: f.n, chroma: quantizeChroma(pitchToChroma(f), f.n) };
}

// ---------------------------------------------------------------------------
// Tuning (libfmp compute_freq_distribution + tuning_similarity)

/** in-place radix-2 complex FFT with exact twiddles */
function fftInPlace(re: Float64Array, im: Float64Array, cos: Float64Array, sin: Float64Array): void {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      let t = re[i];
      re[i] = re[j];
      re[j] = t;
      t = im[i];
      im[i] = im[j];
      im[j] = t;
    }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const half = len >> 1;
    const stride = n / len;
    for (let i = 0; i < n; i += len) {
      for (let k = 0; k < half; k++) {
        const wr = cos[k * stride];
        const wi = sin[k * stride];
        const a = i + k;
        const b = a + half;
        const xr = re[b] * wr - im[b] * wi;
        const xi = re[b] * wi + im[b] * wr;
        re[b] = re[a] - xr;
        im[b] = im[a] - xi;
        re[a] += xr;
        im[a] += xi;
      }
    }
  }
}

/** not-a-knot cubic spline through (k·dx, y[k]), evaluated at xq (scipy interp1d kind="cubic") */
function cubicNotAKnot(y: Float64Array, dx: number, xq: Float64Array): Float64Array {
  const n = y.length;
  const M = new Float64Array(n);
  const rhs = new Float64Array(n);
  const h2 = 6 / (dx * dx);
  for (let i = 1; i < n - 1; i++) rhs[i] = h2 * (y[i + 1] - 2 * y[i] + y[i - 1]);
  // not-a-knot on a uniform grid: M0 = 2M1 − M2 makes row 1 read 6·M1 = rhs1
  M[1] = rhs[1] / 6;
  M[n - 2] = rhs[n - 2] / 6;
  // tridiagonal rows 2..n−3: M[i−1] + 4M[i] + M[i+1] = rhs[i]
  const m = n - 4;
  if (m > 0) {
    const cp = new Float64Array(m);
    const dp = new Float64Array(m);
    for (let r = 0; r < m; r++) {
      const i = r + 2;
      let d = rhs[i];
      if (r === 0) d -= M[1];
      if (r === m - 1) d -= M[n - 2];
      const denom = 4 - (r > 0 ? cp[r - 1] : 0);
      cp[r] = 1 / denom;
      dp[r] = (d - (r > 0 ? dp[r - 1] : 0)) / denom;
    }
    M[m + 1] = dp[m - 1];
    for (let r = m - 2; r >= 0; r--) M[r + 2] = dp[r] - cp[r] * M[r + 3];
  }
  M[0] = 2 * M[1] - M[2];
  M[n - 1] = 2 * M[n - 2] - M[n - 3];
  const out = new Float64Array(xq.length);
  for (let q = 0; q < xq.length; q++) {
    const x = xq[q];
    let i = Math.floor(x / dx);
    if (i < 0) i = 0;
    if (i > n - 2) i = n - 2;
    const a = (i + 1) * dx - x;
    const b = x - i * dx;
    out[q] = (M[i] * a * a * a + M[i + 1] * b * b * b) / (6 * dx) + (y[i] / dx - (M[i] * dx) / 6) * a + (y[i + 1] / dx - (M[i + 1] * dx) / 6) * b;
  }
  return out;
}

/**
 * synctoolbox estimate_tuning(x, Fs) with libfmp's defaults (N 16384, γ 100,
 * local STFT average, 101-cent local-average rectification): the tuning
 * offset in integer cents, −50 … 49. Throws if x is shorter than 2·N, like
 * libfmp.
 */
export function estimateTuningCents(x: Float32Array, sr: number, N = 16384, gamma = 100, filtLen = 101): number {
  const L = x.length;
  if (N > Math.floor(L / 2)) throw new RangeError(`The signal length (${L}) should be twice as long as the window length (${N})`);
  const H = Math.floor(N / 2);
  const nBins = N / 2 + 1;
  // periodic Hann, as scipy get_window("hann", N, fftbins=True)
  const win = new Float64Array(N);
  const stepW = (2 * Math.PI) / N;
  for (let i = 0; i < N; i++) win[i] = 0.5 + 0.5 * Math.cos(i * stepW + -Math.PI);
  // real FFT of size N via a complex FFT of size N/2
  const half = N / 2;
  const cosT = new Float64Array(half / 2);
  const sinT = new Float64Array(half / 2);
  for (let k = 0; k < half / 2; k++) {
    cosT[k] = Math.cos((-2 * Math.PI * k) / half);
    sinT[k] = Math.sin((-2 * Math.PI * k) / half);
  }
  const twr = new Float64Array(half);
  const twi = new Float64Array(half);
  for (let k = 0; k < half; k++) {
    twr[k] = Math.cos((-2 * Math.PI * k) / N);
    twi[k] = Math.sin((-2 * Math.PI * k) / N);
  }
  const re = new Float64Array(half);
  const im = new Float64Array(half);
  const Y = new Float64Array(nBins);
  const Y32 = new Float32Array(nBins);
  const nFrames = 1 + Math.floor(L / H);
  for (let t = 0; t < nFrames; t++) {
    const off = t * H - N / 2;
    for (let k = 0; k < half; k++) {
      const i0 = off + 2 * k;
      const i1 = i0 + 1;
      re[k] = i0 >= 0 && i0 < L ? x[i0] * win[2 * k] : 0;
      im[k] = i1 >= 0 && i1 < L ? x[i1] * win[2 * k + 1] : 0;
    }
    fftInPlace(re, im, cosT, sinT);
    for (let k = 0; k <= half; k++) {
      const a = k % half;
      const b = (half - k) % half;
      const er = 0.5 * (re[a] + re[b]);
      const ei = 0.5 * (im[a] - im[b]);
      const or = 0.5 * (im[a] + im[b]);
      const oi = -0.5 * (re[a] - re[b]);
      let wr = 1;
      let wi = 0;
      if (k < half) {
        wr = twr[k];
        wi = twi[k];
      } else {
        wr = -1;
        wi = 0;
      }
      const xr = Math.fround(er + (or * wr - oi * wi));
      const xi = Math.fround(ei + (or * wi + oi * wr));
      // complex64 magnitude squared and log compression in float32, like librosa + libfmp
      const mag = Math.fround(Math.hypot(xr, xi));
      const pow = Math.fround(mag * mag);
      const v = Math.fround(Math.log(Math.fround(1 + Math.fround(gamma * pow))));
      Y32[k] = Math.fround(Y32[k] + v);
    }
  }
  for (let k = 0; k < nBins; k++) Y[k] = Y32[k];

  const fPitch = (p: number) => 440 * 2 ** ((p - 69) / 12);
  const fMin = fPitch(24);
  const fMax = fPitch(108);
  const nLog = Math.ceil((1200 * Math.log2(fMax / fMin)) / 1);
  const fLog = new Float64Array(nLog);
  for (let i = 0; i < nLog; i++) fLog[i] = 2 ** ((i * 1) / 1200) * fMin;
  const dx = 1.0 / (N * (1.0 / sr));
  const yInt = cubicNotAKnot(Y, dx, fLog);

  // subtract a centred 101-bin moving average and rectify
  const halfLen = Math.floor(filtLen / 2);
  const v = new Float64Array(nLog);
  let max = 0;
  for (let i = 0; i < nLog; i++) {
    let s = 0;
    for (let j = Math.max(0, i - halfLen); j <= Math.min(nLog - 1, i + (filtLen - 1 - halfLen)); j++) s += yInt[j];
    const r = yInt[i] - s / filtLen;
    v[i] = r < 0 ? 0 : r;
    if (v[i] > max) max = v[i];
  }
  for (let i = 0; i < nLog; i++) v[i] /= max;

  // comb templates for θ = −50 … 49
  const sim = new Float64Array(100);
  let simMax = -Infinity;
  for (let ti = 0; ti < 100; ti++) {
    const theta = ti - 50;
    let s = 0;
    for (let pos = theta; pos < nLog; pos += 100) if (pos >= 0) s += v[pos];
    sim[ti] = s;
    if (s > simMax) simMax = s;
  }
  let best = 0;
  for (let ti = 0; ti < 100; ti++) {
    sim[ti] /= simMax;
    if (sim[ti] > sim[best]) best = ti;
  }
  return best - 50;
}
