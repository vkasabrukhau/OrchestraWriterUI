import type { BarGeometry, Engraving } from "./engrave";

/**
 * A score laid out in chunks of bars, on demand (ADR 0016). Chunk k covers a
 * fixed range of written bars and always ends a line at its last bar, so a
 * chunk can be laid out on its own, in any order, with the same result.
 * Chunks not laid out yet are placeholders sized from the ones that are.
 * Pure, so the stacking can be tested without a browser.
 */

/** Written bar ranges [first, last] of each chunk. Small scores are one chunk. */
export function chunkGrid(count: number, size: number): Array<[number, number]> {
  if (count <= 0) return [];
  if (count <= Math.ceil(size * 1.5)) return [[0, count - 1]];
  const out: Array<[number, number]> = [];
  for (let a = 0; a < count; a += size) out.push([a, Math.min(count - 1, a + size - 1)]);
  // a short tail joins the chunk before it
  const last = out[out.length - 1];
  if (out.length > 1 && last[1] - last[0] + 1 < size / 2) {
    out.pop();
    out[out.length - 1][1] = last[1];
  }
  return out;
}

/**
 * Chunk ranges that end at natural page turns. A file with its own page
 * breaks is cut only there (pages grouped until a chunk has about `size`
 * bars). Otherwise each chunk ends near `size` bars, at the most natural turn
 * within `window` bars of it (see LayoutHints.strength), avoiding ends that
 * leave a short last line, the nearer one on a tie.
 */
export function chunkGridAt(
  count: number,
  size: number,
  hints: { newPage: ReadonlySet<number>; strength: readonly number[] },
  /** bars a line usually holds, once a layout has shown it: chunk ends that would leave a short last line are avoided */
  lineBars = 0,
  window = 8,
): Array<[number, number]> {
  if (count <= 0) return [];
  const out: Array<[number, number]> = [];
  const pages = [...hints.newPage].filter((b) => b > 0 && b < count).sort((a, b) => a - b);
  let start = 0;
  while (start < count) {
    if (count - start <= Math.ceil(size * 1.5)) {
      out.push([start, count - 1]);
      break;
    }
    let next = -1;
    if (pages.length > 0) {
      // the first page break once the chunk has a fair share of bars, unless the next one is far off
      next = pages.find((b) => b >= start + Math.round(size * 0.6)) ?? -1;
      if (next > start + size * 2.5) next = -1;
    }
    if (next < 0) {
      const target = start + size;
      let best = -Infinity;
      for (let b = Math.max(start + Math.round(size / 2), target - window); b <= Math.min(count - 1, target + window); b++) {
        // a chunk ending part-way through a line leaves that line short (and maybe alone on a page)
        const rest = lineBars > 1 ? (b - start) % lineBars : 0;
        // an orphaned bar or two (a third of a line or less) is worse than any musical turn; a half-empty line nearly so
        const shortLine = rest === 0 ? 0 : rest <= lineBars / 3 ? 8 : rest <= lineBars / 2 ? 5 : 1;
        const score = (hints.strength[b] ?? 0) - shortLine - Math.abs(b - target) * 0.05;
        if (score > best) {
          best = score;
          next = b;
        }
      }
    }
    if (next <= start || next >= count) {
      out.push([start, count - 1]);
      break;
    }
    out.push([start, next - 1]);
    start = next;
  }
  return out;
}

/** Chunk index holding written bar `bar`. */
export function chunkOf(grid: Array<[number, number]>, bar: number): number {
  for (let k = 0; k < grid.length; k++) if (bar <= grid[k][1]) return k;
  return Math.max(0, grid.length - 1);
}

/** One line of music on the sheet, or a chunk still to be laid out. */
export interface Row {
  top: number;
  height: number;
  chunk: number;
  firstBar: number;
  lastBar: number;
  /** the system's SVG; absent while the chunk is pending */
  markup?: string;
}

export interface Page {
  top: number;
  height: number;
}

export interface Sheet {
  rows: Row[];
  /** row k owns [cuts[k], cuts[k + 1]) */
  cuts: number[];
  /** by written index, in sheet coordinates; `system` is the row index */
  bars: Map<number, BarGeometry>;
  /** pages, top to bottom (page view); empty when the sheet is one long strip */
  pages: Page[];
  width: number;
  height: number;
}

/** Page view: systems are set on fixed pages, as printed (MuseScore, Sibelius and Dorico page view). */
export interface PageFormat {
  width: number;
  height: number;
  /** space kept clear at the top and bottom of a page */
  margin: number;
  /** space between pages */
  gap: number;
}

/** Height a pending chunk is given before it is laid out, px per bar (no chunk laid out yet). */
const FALLBACK_PX_PER_BAR = 160;

/**
 * Stack the chunks. Without `page`, systems follow one another as drawn.
 * With it, systems are set on pages: a page takes systems while they fit
 * between its margins and ends just below the last one (no blank space at
 * the bottom), a system taller than a page gets a page of its own, a page break written in the file is kept, and every
 * chunk starts a new page so that laying out a chunk never moves the
 * systems of another.
 */
export function buildSheet(
  grid: Array<[number, number]>,
  rendered: ReadonlyMap<number, Engraving>,
  page?: PageFormat,
  /** bars that start a page in the file: a system starting there starts a page here too */
  pageBreaks?: ReadonlySet<number>,
): Sheet {
  let px = 0;
  let barsDone = 0;
  let width = page?.width ?? 0;
  for (const [k, e] of rendered) {
    const g = grid[k];
    if (!g) continue;
    px += e.height;
    barsDone += g[1] - g[0] + 1;
    width = Math.max(width, e.width);
  }
  const perBar = barsDone > 0 ? px / barsDone : FALLBACK_PX_PER_BAR;

  const rows: Row[] = [];
  const bars = new Map<number, BarGeometry>();
  const pages: Page[] = [];
  let y = 0;
  grid.forEach(([from, to], k) => {
    const e = rendered.get(k);
    if (!e) {
      const drawn = Math.max(80, perBar * (to - from + 1));
      if (!page) {
        rows.push({ top: y, height: drawn, chunk: k, firstBar: from, lastBar: to });
        y += drawn;
        return;
      }
      // as many blank pages as the chunk is likely to need
      const content = page.height - 2 * page.margin;
      const n = Math.max(1, Math.ceil(drawn / content));
      const height = n * (page.height + page.gap);
      rows.push({ top: y, height, chunk: k, firstBar: from, lastBar: to });
      for (let i = 0; i < n; i++) pages.push({ top: y + i * (page.height + page.gap), height: page.height });
      y += height;
      return;
    }
    const base = rows.length;
    if (!page) {
      e.systems.forEach((s, j) => {
        rows.push({ top: y + e.cuts[j], height: e.cuts[j + 1] - e.cuts[j], chunk: k, firstBar: s.firstBar, lastBar: s.lastBar, markup: s.markup });
      });
      for (const [idx, b] of e.bars) bars.set(idx, shiftBar(b, y, base));
      y += e.height;
      return;
    }
    // set the chunk's systems on pages
    const shifts: number[] = [];
    let pageTop = y;
    let cursor = pageTop + page.margin;
    const close = () => {
      // a page ends just below its music: the page height is what a page may hold, not a size to fill
      const height = cursor - pageTop + page.margin;
      pages.push({ top: pageTop, height });
      return height;
    };
    e.systems.forEach((s, j) => {
      const h = e.cuts[j + 1] - e.cuts[j];
      const started = cursor > pageTop + page.margin;
      if (started && (cursor + h > pageTop + page.height - page.margin || pageBreaks?.has(s.firstBar))) {
        pageTop += close() + page.gap;
        cursor = pageTop + page.margin;
      }
      shifts.push(cursor - e.cuts[j]);
      rows.push({ top: cursor, height: h, chunk: k, firstBar: s.firstBar, lastBar: s.lastBar, markup: s.markup });
      cursor += h;
    });
    y = pageTop + close() + page.gap;
    for (const [idx, b] of e.bars) bars.set(idx, shiftBar(b, shifts[b.system] ?? 0, base));
  });
  return { rows, cuts: [...rows.map((r) => r.top), y], bars, pages, width, height: y };
}

function shiftBar(b: BarGeometry, dy: number, rowBase: number): BarGeometry {
  return {
    box: { ...b.box, top: b.box.top + dy },
    onsets: b.onsets,
    staves: b.staves.map((s) => ({ ...s, top: s.top + dy, bottom: s.bottom + dy })),
    system: rowBase + b.system,
  };
}

/** Page holding a sheet position (the last page above it). */
export function pageAt(pages: Page[], y: number): number {
  let k = 0;
  for (let i = 0; i < pages.length; i++) if (pages[i].top <= y + 1e-6) k = i;
  return k;
}

/** Row holding written bar `bar` (a pending chunk's row when it is not laid out). */
export function rowOfBar(sheet: Sheet, bar: number): number {
  const known = sheet.bars.get(bar);
  if (known) return known.system;
  const k = sheet.rows.findIndex((r) => bar >= r.firstBar && bar <= r.lastBar);
  return Math.max(0, k);
}
