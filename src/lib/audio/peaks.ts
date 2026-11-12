import type { AudioBufferLike } from "./decode";

/**
 * Min/max peaks of the recording at several zoom levels, for the zoomable
 * waveform on Sync. Level 0 has one min/max pair per `base` samples; each
 * next level halves the count. Max over channels, no downmix copy.
 */
export interface PeakPyramid {
  sampleRate: number;
  durationSec: number;
  /** samples per bucket at level 0 */
  base: number;
  /** per level: interleaved [min, max] pairs */
  levels: Float32Array[];
}

const YIELD_EVERY = 1_000_000;

export async function buildPeakPyramid(buffer: AudioBufferLike, base = 256, signal?: AbortSignal): Promise<PeakPyramid> {
  const n = buffer.length;
  const buckets = Math.max(1, Math.ceil(n / base));
  const level0 = new Float32Array(buckets * 2);
  const ch = Math.max(1, buffer.numberOfChannels);
  const data = Array.from({ length: ch }, (_, c) => buffer.getChannelData(c));
  let sinceYield = 0;
  for (let b = 0; b < buckets; b++) {
    let lo = 0;
    let hi = 0;
    const end = Math.min(n, (b + 1) * base);
    for (let c = 0; c < ch; c++) {
      const d = data[c];
      for (let i = b * base; i < end; i++) {
        const v = d[i];
        if (v < lo) lo = v;
        else if (v > hi) hi = v;
      }
    }
    level0[b * 2] = lo;
    level0[b * 2 + 1] = hi;
    sinceYield += (end - b * base) * ch;
    if (sinceYield >= YIELD_EVERY) {
      sinceYield = 0;
      if (signal?.aborted) throw Object.assign(new Error("Aborted"), { name: "AbortError" });
      await new Promise((r) => setTimeout(r, 0));
    }
  }
  const levels = [level0];
  while (levels[levels.length - 1].length > 2 * 64) {
    const prev = levels[levels.length - 1];
    const count = Math.ceil(prev.length / 4);
    const next = new Float32Array(count * 2);
    for (let b = 0; b < count; b++) {
      const a = b * 4;
      next[b * 2] = Math.min(prev[a], prev[a + 2] ?? prev[a]);
      next[b * 2 + 1] = Math.max(prev[a + 1], prev[a + 3] ?? prev[a + 1]);
    }
    levels.push(next);
  }
  return { sampleRate: buffer.sampleRate, durationSec: buffer.sampleRate > 0 ? n / buffer.sampleRate : 0, base, levels };
}

/** The coarsest level that still has at least one bucket per pixel column over [t0, t1]. */
export function levelFor(p: PeakPyramid, t0: number, t1: number, columns: number): { level: Float32Array; secPerBucket: number } {
  const span = Math.max(1e-6, t1 - t0);
  let k = 0;
  while (k + 1 < p.levels.length) {
    const secPerBucket = (p.base * 2 ** (k + 1)) / p.sampleRate;
    if (span / secPerBucket < columns) break;
    k++;
  }
  return { level: p.levels[k], secPerBucket: (p.base * 2 ** k) / p.sampleRate };
}
