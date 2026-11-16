/**
 * The original broad match (guide section 8): the whole score against the
 * whole recording at 2 Hz, subsequence DTW over the joint cost.
 *
 * Same recursion as librosa.sequence.dtw(subseq=True,
 * step_sizes_sigma=[[1,1],[1,2],[2,1]], weights_mul=[1,1,2]): rows are score
 * frames, columns recording frames; the (2,1) step pays twice so compressing
 * score time earns no discount, and endpoints are ranked by accumulated cost
 * divided by the number of score rows.
 */

/** single pairwise matrix limit (MAX_CELLS in the reference) */
export const MAX_COARSE_CELLS = 8_000_000;

export interface CoarseMatch {
  /** score row of each path cell (ascending) */
  rows: Int32Array;
  /** recording column of each path cell */
  cols: Int32Array;
  /** accumulated cost / score rows of the best path */
  cost: number;
  /** next non-overlapping occurrence's cost minus the best one's (null when none) */
  margin: number | null;
  startCol: number;
  endCol: number;
}

const STEPS: Array<[number, number, number]> = [
  [1, 1, 1],
  [1, 2, 1],
  [2, 1, 2],
];

/**
 * `bounds` (optional): per score row, the recording columns the path may use
 * (manual-marker anchors, ADR 0021). Cells outside are never on the path.
 */
export function subsequenceDtw(cost: Float32Array, n: number, m: number, topK = 3, bounds?: { lo: Int32Array; hi: Int32Array }): CoarseMatch {
  if (n < 1 || m < 1) throw new Error("No frames to match.");
  if (n * m > MAX_COARSE_CELLS) throw new Error("The score and recording are too long for the broad match (over 8 million cells at 2 Hz).");
  const D = new Float64Array(n * m).fill(Infinity);
  const steps = new Uint8Array(n * m);
  const allowed = (i: number, j: number) => !bounds || (j >= bounds.lo[i] && j <= bounds.hi[i]);
  for (let j = 0; j < m; j++) if (allowed(0, j)) D[j] = cost[j];
  for (let i = 1; i < n; i++) {
    for (let j = 0; j < m; j++) {
      if (!allowed(i, j)) continue;
      const c = cost[i * m + j];
      let best = Infinity;
      let step = 0;
      for (let k = 0; k < STEPS.length; k++) {
        const [di, dj, w] = STEPS[k];
        if (i < di || j < dj) continue;
        const v = D[(i - di) * m + (j - dj)] + w * c;
        if (v < best) {
          best = v;
          step = k;
        }
      }
      D[i * m + j] = best;
      steps[i * m + j] = step;
    }
  }

  const endings = new Float64Array(m);
  for (let j = 0; j < m; j++) endings[j] = D[(n - 1) * m + j] / n;
  const candidates: number[] = [];
  let bestEnd = -1;
  for (let j = 0; j < m; j++) {
    if (!Number.isFinite(endings[j])) continue;
    if (bestEnd < 0 || endings[j] < endings[bestEnd]) bestEnd = j;
    const left = j > 0 ? endings[j - 1] : Infinity;
    const right = j < m - 1 ? endings[j + 1] : Infinity;
    if (j > 0 && j < m - 1 && endings[j] < left && endings[j] <= right) candidates.push(j);
  }
  if (bestEnd < 0) throw new Error("No path within the tempo constraints.");
  const ordered = [...new Set([bestEnd, ...candidates])].sort((a, b) => endings[a] - endings[b]).slice(0, 100);

  const found: Array<{ rows: number[]; cols: number[]; start: number; end: number; cost: number }> = [];
  for (const end of ordered) {
    const rows: number[] = [];
    const cols: number[] = [];
    let i = n - 1;
    let j = end;
    rows.push(i);
    cols.push(j);
    while (i > 0) {
      const [di, dj] = STEPS[steps[i * m + j]];
      i -= di;
      j -= dj;
      rows.push(i);
      cols.push(j);
    }
    rows.reverse();
    cols.reverse();
    const start = cols[0];
    if (found.some((f) => Math.max(start, f.start) <= Math.min(end, f.end))) continue;
    found.push({ rows, cols, start, end, cost: endings[end] });
    if (found.length >= topK) break;
  }
  const best = found[0];
  return {
    rows: Int32Array.from(best.rows),
    cols: Int32Array.from(best.cols),
    cost: best.cost,
    margin: found.length > 1 ? found[1].cost - best.cost : null,
    startCol: best.start,
    endCol: best.end,
  };
}

/** _mapping: score seconds → mean recording seconds per score row. */
export function pathMapping(match: CoarseMatch, rate: number): { score: number[]; recording: number[] } {
  const score: number[] = [];
  const recording: number[] = [];
  let k = 0;
  while (k < match.rows.length) {
    const r = match.rows[k];
    let sum = 0;
    let count = 0;
    while (k < match.rows.length && match.rows[k] === r) {
      sum += match.cols[k];
      count++;
      k++;
    }
    score.push(r / rate);
    recording.push(sum / count / rate);
  }
  return { score, recording };
}
