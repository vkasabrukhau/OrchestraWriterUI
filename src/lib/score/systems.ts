/**
 * Geometry of an engraved score laid out once (ADR 0016): systems stacked
 * top to bottom, each owning a horizontal band of the sheet. Pure functions
 * so they can be tested without a browser.
 */

export interface Band {
  top: number;
  bottom: number;
}

/**
 * Cut lines between systems: halfway through each gap, plus the sheet's top
 * and bottom. `bands` are the systems' staff extents, top to bottom.
 * Returns bands.length + 1 values; system k owns [cuts[k], cuts[k + 1]).
 */
export function systemCuts(bands: Band[], sheetHeight: number): number[] {
  if (bands.length === 0) return [0, sheetHeight];
  const cuts = [0];
  for (let k = 0; k + 1 < bands.length; k++) cuts.push((bands[k].bottom + bands[k + 1].top) / 2);
  cuts.push(Math.max(sheetHeight, bands[bands.length - 1].bottom));
  return cuts;
}

/** System index owning a vertical position (by the cuts). */
export function systemAt(cuts: number[], y: number): number {
  let lo = 0;
  let hi = cuts.length - 2;
  if (hi < 0) return 0;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (cuts[mid] <= y) lo = mid;
    else hi = mid - 1;
  }
  return lo;
}

/** Systems overlapping [top, bottom] (inclusive indices), or null when none. */
export function systemsInView(cuts: number[], top: number, bottom: number): [number, number] | null {
  const count = cuts.length - 1;
  if (count <= 0 || bottom < cuts[0] || top > cuts[count]) return null;
  return [systemAt(cuts, Math.max(top, cuts[0])), systemAt(cuts, Math.min(bottom, cuts[count] - 1e-6))];
}

/**
 * Where to scroll so that a system is in view while following playback.
 * `offset` keeps the reader's place inside a tall system (a fraction of the
 * system's height, null = its top). Short systems sit at the top with the
 * next one visible below, so the music ahead is always on screen.
 */
export function followScrollTop(cuts: number[], k: number, offset: number | null, headroom = 0): number {
  const top = cuts[k] ?? 0;
  const height = (cuts[k + 1] ?? top) - top;
  if (offset === null) return Math.max(0, top - headroom);
  return Math.max(0, top + offset * height);
}

/** Contiguous runs of a sorted list of integers: [1,2,3,7,8] → [[1,3],[7,8]]. */
export function runs(sorted: number[]): Array<[number, number]> {
  const out: Array<[number, number]> = [];
  for (const n of sorted) {
    const last = out[out.length - 1];
    if (last && n === last[1] + 1) last[1] = n;
    else if (!last || n > last[1]) out.push([n, n]);
  }
  return out;
}
