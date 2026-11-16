import type { InfoMap } from "@/shared/info-map";

/**
 * Playback bars (repeats expanded, what the clock and the sync use) versus
 * written bars (what engraved notation draws). A written bar inside a repeat
 * is played more than once.
 */

/**
 * Written index (0-based) of every playback bar. Info maps from before
 * `writtenIndex` existed fall back to the printed labels: playback visits
 * each written bar for the first time in written order, so the n-th distinct
 * label is written bar n.
 */
export function writtenIndices(infoMap: InfoMap): number[] {
  const ms = infoMap.measures;
  if (infoMap.timing || ms.some((m) => m.writtenIndex !== undefined)) return ms.map((m, k) => m.writtenIndex ?? k);
  if (!ms.some((m) => m.label !== undefined)) return ms.map((_, k) => k);
  const firstSeen = new Map<string, number>();
  return ms.map((m) => {
    const label = m.label ?? String(m.number);
    if (!firstSeen.has(label)) firstSeen.set(label, firstSeen.size);
    return firstSeen.get(label)!;
  });
}

/** Number of written bars. */
export function writtenCount(written: number[]): number {
  return written.reduce((max, w) => Math.max(max, w + 1), 0);
}

/** The playback occurrence of a written bar closest to the current playback bar (1-based), or null. */
export function playbackBarFor(written: number[], writtenIndex: number, currentMeasure: number): number | null {
  let best: number | null = null;
  for (let k = 0; k < written.length; k++) {
    if (written[k] !== writtenIndex) continue;
    const n = k + 1;
    if (best === null || Math.abs(n - currentMeasure) < Math.abs(best - currentMeasure)) best = n;
  }
  return best;
}

/** Written bar range [first, last] (0-based, inclusive) of a page. */
export function pageRange(page: number, perPage: number, count: number): [number, number] {
  const first = Math.max(0, Math.min(page * perPage, Math.max(0, count - 1)));
  return [first, Math.min(count - 1, first + perPage - 1)];
}
