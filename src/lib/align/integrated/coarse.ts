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
/** cost per skipped score row in a score jump: the joint cost of a cell with no evidence */
const SKIPPED_ROW_COST = 0.5;
/** step codes of the two jumps (after STEPS) */
const JUMP_RECORDING = 3;
const JUMP_SCORE = 4;

/**
 * Jumps for the DTWs (not in the reference). A recording jump goes from row
 * i − 1 at any column ≤ j − 3 to (i, j): recording material the score does
 * not have (a repeat the score lacks, a pause, applause). A score jump goes
 * from column j − 1 at any row ≤ i − 3 to (i, j): score the recording skips
 * (a cut, a repeat not taken), paying 0.5 (no evidence) for each skipped
 * row so skipping music is never cheaper than matching it badly. Each also
 * costs a fixed penalty plus the cell, so
 * ordinary tempo changes never use them; they exist so that manual markers
 * that imply such a jump always have a path through them, without warping
 * the music around the jump.
 *
 * Per row it keeps the previous row's running minimum (for recording jumps)
 * and, per column, the minimum over rows ≤ i − 3 (for score jumps).
 */
class JumpTracker {
  private readonly prefix: Float64Array;
  private readonly prefixCol: Int32Array;
  private readonly colMin: Float64Array;
  private readonly colRow: Int32Array;
  private prevRow = -1;
  private row = 0;
  private lo = 0;

  constructor(m: number) {
    this.prefix = new Float64Array(m).fill(Infinity);
    this.prefixCol = new Int32Array(m).fill(-1);
    this.colMin = new Float64Array(m).fill(Infinity);
    this.colRow = new Int32Array(m).fill(-1);
  }

  /**
   * Before row i: running minimum over row i − 1 (columns rowLo…rowHi of
   * that row's band) and the column minima over rows ≤ i − 3.
   * `cell(r, j)` is the index of (r, j) in D, or −1 outside the band.
   */
  nextRow(
    D: Float64Array,
    i: number,
    m: number,
    rowLo: number,
    rowHi: number,
    cell: (r: number, j: number) => number,
    bandOf?: (r: number) => [number, number],
    upTo = m - 1,
  ): void {
    // only columns rowLo…upTo are read for this row (best() checks j − 3 ≥ rowLo, j ≤ upTo)
    let best = Infinity;
    let arg = -1;
    for (let j = rowLo; j <= rowHi; j++) {
      const c = cell(i - 1, j);
      if (c >= 0 && D[c] < best) {
        best = D[c];
        arg = j;
      }
      this.prefix[j] = best;
      this.prefixCol[j] = arg;
    }
    for (let j = rowHi + 1; j <= upTo; j++) {
      this.prefix[j] = best;
      this.prefixCol[j] = arg;
    }
    this.lo = rowLo;
    if (i >= 3) {
      // stored relative to the row, so a jump from row r into row i pays
      // SKIPPED_ROW_COST for each of the i − r − 1 rows it skips
      const r = i - 3;
      const [a, b] = bandOf ? bandOf(r) : [0, m - 1];
      for (let j = a; j <= b; j++) {
        const c = cell(r, j);
        if (c >= 0 && D[c] - r * SKIPPED_ROW_COST < this.colMin[j]) {
          this.colMin[j] = D[c] - r * SKIPPED_ROW_COST;
          this.colRow[j] = r;
        }
      }
    }
    this.prevRow = i - 1;
    this.row = i;
  }

  /** the cheaper jump into column j of the current row, `add` = penalty + cell cost */
  best(j: number, add: number): { value: number; step: number; row: number; col: number } {
    let value = Infinity;
    let step = 0;
    let row = -1;
    let col = -1;
    if (j - 3 >= this.lo && this.prefixCol[j - 3] >= 0) {
      value = this.prefix[j - 3] + add;
      step = JUMP_RECORDING;
      row = this.prevRow;
      col = this.prefixCol[j - 3];
    }
    const skip = this.colMin[j - 1] + (this.row - 1) * SKIPPED_ROW_COST + add;
    if (j >= 1 && this.colRow[j - 1] >= 0 && skip < value) {
      value = skip;
      step = JUMP_SCORE;
      row = this.colRow[j - 1];
      col = j - 1;
    }
    return { value, step, row, col };
  }
}

/**
 * `bounds` (optional): per score row, the recording columns the path may use
 * (manual-marker anchors, ADR 0021). Cells outside are never on the path.
 */
export function subsequenceDtw(
  cost: Float32Array,
  n: number,
  m: number,
  topK = 3,
  bounds?: { lo: Int32Array; hi: Int32Array },
  jumpPenalty = Infinity,
): CoarseMatch {
  if (n < 1 || m < 1) throw new Error("No frames to match.");
  if (n * m > MAX_COARSE_CELLS) throw new Error("The score and recording are too long for the broad match (over 8 million cells at 2 Hz).");
  const D = new Float64Array(n * m).fill(Infinity);
  const steps = new Uint8Array(n * m);
  const jumps = Number.isFinite(jumpPenalty);
  const from = jumps ? new Int32Array(n * m) : null;
  const jump = jumps ? new JumpTracker(m) : null;
  const allowed = (i: number, j: number) => !bounds || (j >= bounds.lo[i] && j <= bounds.hi[i]);
  for (let j = 0; j < m; j++) if (allowed(0, j)) D[j] = cost[j];
  for (let i = 1; i < n; i++) {
    jump?.nextRow(D, i, m, 0, m - 1, (r, j) => r * m + j);
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
      if (jump && from) {
        const j2 = jump.best(j, jumpPenalty + c);
        if (j2.value < best) {
          best = j2.value;
          step = j2.step;
          from[i * m + j] = j2.row * m + j2.col;
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
      const st = steps[i * m + j];
      if (st >= JUMP_RECORDING && from) {
        const o = from[i * m + j];
        i = Math.floor(o / m);
        j = o % m;
      } else {
        const [di, dj] = STEPS[st];
        i -= di;
        j -= dj;
      }
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

/**
 * Banded DTW with the same steps and weights as `subsequenceDtw`, for a
 * finer pass around an earlier path: row i may only use columns
 * lo[i]…hi[i]. Only band cells are stored, so long pieces stay small. The
 * path starts anywhere in row 0's band and ends at the cheapest column of
 * the last row (accumulated cost / rows). `cost(i, j)` is read once per cell.
 */
export function bandedDtw(
  cost: (i: number, j: number) => number,
  n: number,
  lo: Int32Array,
  hi: Int32Array,
  jumpPenalty = Infinity,
): { rows: Int32Array; cols: Int32Array; cost: number; jumps: number } {
  if (n < 1) throw new Error("No frames to match.");
  const offset = new Int32Array(n + 1);
  let m = 0;
  for (let i = 0; i < n; i++) {
    offset[i + 1] = offset[i] + Math.max(0, hi[i] - lo[i] + 1);
    m = Math.max(m, hi[i] + 1);
  }
  const D = new Float64Array(offset[n]).fill(Infinity);
  const steps = new Uint8Array(offset[n]);
  const at = (i: number, j: number) => (j < lo[i] || j > hi[i] ? -1 : offset[i] + j - lo[i]);
  const jump = Number.isFinite(jumpPenalty) ? new JumpTracker(m) : null;
  const from = jump ? new Float64Array(offset[n]) : null;
  for (let j = lo[0]; j <= hi[0]; j++) D[at(0, j)] = cost(0, j);
  for (let i = 1; i < n; i++) {
    jump?.nextRow(D, i, m, lo[i - 1], hi[i - 1], at, (r) => [lo[r], hi[r]], hi[i]);
    for (let j = lo[i]; j <= hi[i]; j++) {
      let best = Infinity;
      let step = 0;
      let c = NaN;
      for (let k = 0; k < STEPS.length; k++) {
        const [di, dj, w] = STEPS[k];
        if (i < di || j < dj) continue;
        const prev = at(i - di, j - dj);
        if (prev < 0 || !Number.isFinite(D[prev])) continue;
        if (Number.isNaN(c)) c = cost(i, j);
        const v = D[prev] + w * c;
        if (v < best) {
          best = v;
          step = k;
        }
      }
      const cell = at(i, j);
      if (jump && from) {
        if (Number.isNaN(c)) c = cost(i, j);
        const j2 = jump.best(j, jumpPenalty + c);
        if (j2.value < best) {
          best = j2.value;
          step = j2.step;
          from[cell] = j2.row * m + j2.col;
        }
      }
      D[cell] = best;
      steps[cell] = step;
    }
  }
  let end = -1;
  for (let j = lo[n - 1]; j <= hi[n - 1]; j++) if (Number.isFinite(D[at(n - 1, j)]) && (end < 0 || D[at(n - 1, j)] < D[at(n - 1, end)])) end = j;
  if (end < 0) throw new Error("No path inside the band.");
  const rows: number[] = [n - 1];
  const cols: number[] = [end];
  let i = n - 1;
  let j = end;
  let jumps = 0;
  while (i > 0) {
    const st = steps[at(i, j)];
    if (st >= JUMP_RECORDING && from) {
      const o = from[at(i, j)];
      i = Math.floor(o / m);
      j = o % m;
      jumps++;
    } else {
      const [di, dj] = STEPS[st];
      i -= di;
      j -= dj;
    }
    rows.push(i);
    cols.push(j);
  }
  rows.reverse();
  cols.reverse();
  return { rows: Int32Array.from(rows), cols: Int32Array.from(cols), cost: D[at(n - 1, end)] / n, jumps };
}
