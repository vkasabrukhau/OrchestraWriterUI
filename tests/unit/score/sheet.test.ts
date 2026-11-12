import { describe, expect, it } from "vitest";
import type { Engraving } from "@/lib/score/engrave";
import { buildSheet, chunkGrid, chunkOf, rowOfBar } from "@/lib/score/sheet";

/** a laid-out chunk: one 100 px system per two bars */
function chunk(from: number, to: number): Engraving {
  const systems = [];
  const cuts = [0];
  const bars = new Map();
  for (let a = from, k = 0; a <= to; a += 2, k++) {
    systems.push({ markup: `<svg data-k="${k}"/>`, firstBar: a, lastBar: Math.min(to, a + 1) });
    cuts.push(100 * (k + 1));
    for (const b of [a, a + 1]) if (b <= to) bars.set(b, { box: { left: 10, top: 100 * k + 20, width: 50, height: 60 }, onsets: [], staves: [{ top: 100 * k + 20, bottom: 100 * k + 80, onsets: [] }], system: k });
  }
  return { width: 800, height: cuts[cuts.length - 1], cuts, systems, bars, renderMs: 1 };
}

describe("chunkGrid", () => {
  it("keeps a small score in one chunk and splits a large one, folding a short tail in", () => {
    expect(chunkGrid(48, 40)).toEqual([[0, 47]]);
    expect(chunkGrid(95, 40)).toEqual([
      [0, 39],
      [40, 94],
    ]);
    expect(chunkGrid(130, 40)).toEqual([
      [0, 39],
      [40, 79],
      [80, 129],
    ]);
    expect(chunkGrid(0, 40)).toEqual([]);
    expect(chunkOf(chunkGrid(130, 40), 85)).toBe(2);
  });
});

describe("buildSheet", () => {
  it("stacks laid-out chunks and sizes pending ones from them", () => {
    const grid = chunkGrid(130, 40);
    const sheet = buildSheet(grid, new Map([[1, chunk(40, 79)]]));
    // chunk 0 pending (40 bars × 50 px per bar from chunk 1), then chunk 1's 20 systems, then chunk 2 pending
    expect(sheet.rows[0]).toMatchObject({ top: 0, height: 2000, chunk: 0, firstBar: 0, lastBar: 39 });
    expect(sheet.rows[0].markup).toBeUndefined();
    expect(sheet.rows[1]).toMatchObject({ top: 2000, height: 100, firstBar: 40, lastBar: 41, markup: '<svg data-k="0"/>' });
    expect(sheet.rows).toHaveLength(1 + 20 + 1);
    expect(sheet.rows[21]).toMatchObject({ top: 4000, height: 2500, chunk: 2 });
    expect(sheet.height).toBe(6500);
    expect(sheet.cuts).toHaveLength(sheet.rows.length + 1);
    // bars move to sheet coordinates and point at their row
    expect(sheet.bars.get(43)).toMatchObject({ box: { top: 2120 }, system: 2 });
    expect(sheet.bars.get(43)!.staves[0]).toMatchObject({ top: 2120, bottom: 2180 });
    expect(rowOfBar(sheet, 43)).toBe(2);
    expect(rowOfBar(sheet, 100)).toBe(21);
  });

  it("gives pending chunks a default height before anything is laid out", () => {
    const sheet = buildSheet(chunkGrid(48, 40), new Map());
    expect(sheet.rows).toEqual([{ top: 0, height: 48 * 160, chunk: 0, firstBar: 0, lastBar: 47 }]);
  });
});

describe("buildSheet: page view", () => {
  const page = { width: 800, height: 500, margin: 40, gap: 20 };

  it("sets systems on pages, starting a page when the next one does not fit", async () => {
    const { pageAt } = await import("@/lib/score/sheet");
    // one chunk of 8 bars: 4 systems of 100 px; a page holds 420 px between margins → 4 fit
    const sheet = buildSheet([[0, 7]], new Map([[0, chunk(0, 7)]]), page);
    // 4 systems of 100 px between 40 px margins: the page ends below its music
    expect(sheet.pages).toEqual([{ top: 0, height: 480 }]);
    expect(sheet.rows.map((r) => r.top)).toEqual([40, 140, 240, 340]);
    expect(sheet.bars.get(2)).toMatchObject({ box: { top: 160 }, system: 1 });

    // 10 bars: 5 systems → the fifth starts page 2
    const two = buildSheet([[0, 9]], new Map([[0, chunk(0, 9)]]), page);
    expect(two.pages).toEqual([
      { top: 0, height: 480 },
      { top: 500, height: 180 },
    ]);
    expect(two.rows[4].top).toBe(540);
    expect(two.bars.get(9)).toMatchObject({ box: { top: 560 }, system: 4 });
    expect(two.height).toBe(700);
    expect(pageAt(two.pages, 600)).toBe(1);
    expect(pageAt(two.pages, 10)).toBe(0);
  });

  it("starts each chunk on a new page and gives pending chunks blank pages", () => {
    const grid = chunkGrid(130, 40);
    const sheet = buildSheet(grid, new Map([[0, chunk(0, 39)]]), page);
    // chunk 0: 20 systems of 100 px, 4 per page → 5 pages; chunk 1 pending at 50 px/bar → 2000 px → 5 pages
    expect(sheet.pages.slice(0, 6).map((p) => p.top)).toEqual([0, 500, 1000, 1500, 2000, 2500]);
    const pending = sheet.rows.find((r) => r.chunk === 1)!;
    expect(pending).toMatchObject({ top: 2500, firstBar: 40, lastBar: 79 });
    expect(pending.markup).toBeUndefined();
  });

  it("gives a system taller than a page a page of its own, grown to fit", () => {
    const tall = chunk(0, 1);
    tall.cuts = [0, 700];
    tall.height = 700;
    const sheet = buildSheet([[0, 1]], new Map([[0, tall]]), page);
    expect(sheet.pages).toEqual([{ top: 0, height: 780 }]);
  });
});

describe("chunkGridAt: chunks end at natural page turns", () => {
  const none = (n: number) => ({ newPage: new Set<number>(), strength: new Array<number>(n).fill(0) });

  it("ends a chunk at the strongest turn near the target, the nearer one on a tie", async () => {
    const { chunkGridAt } = await import("@/lib/score/sheet");
    const h = none(100);
    // a double barline before bar 27 and a fermata turn before bar 20
    h.strength[27] = 3;
    h.strength[20] = 4;
    expect(chunkGridAt(100, 24, h)[0]).toEqual([0, 19]);
    // nothing special: exactly at the target
    expect(chunkGridAt(100, 24, none(100))[0]).toEqual([0, 23]);
  });

  it("cuts only at the file's own page breaks when it has them", async () => {
    const { chunkGridAt } = await import("@/lib/score/sheet");
    const h = none(100);
    for (const b of [9, 18, 27, 36, 45, 54, 63, 72, 81, 90]) h.newPage.add(b);
    const grid = chunkGridAt(100, 24, h);
    // each chunk starts on a file page and holds at least 60% of the target
    expect(grid.map(([a]) => a)).toEqual([0, 18, 36, 54, 72]);
    expect(grid[grid.length - 1][1]).toBe(99);
    // contiguous and complete
    grid.forEach(([, b], k) => k + 1 < grid.length && expect(grid[k + 1][0]).toBe(b + 1));
  });

  it("does not end a chunk where it would leave a bar alone on a line", async () => {
    const { chunkGridAt } = await import("@/lib/score/sheet");
    const h = none(100);
    h.strength[16] = 7; // a repeat ends before bar 17 (index 16)
    // 3 bars a line: ending at 16 leaves one bar over; 18 and 24 leave full lines
    const [first] = chunkGridAt(100, 24, h, 3);
    expect((first[1] + 1) % 3).toBe(0);
    // without knowing the line length, the musical turn wins
    expect(chunkGridAt(100, 24, h)[0]).toEqual([0, 15]);
  });

  it("keeps a short score in one chunk", async () => {
    const { chunkGridAt } = await import("@/lib/score/sheet");
    expect(chunkGridAt(30, 24, none(30))).toEqual([[0, 29]]);
  });
});

describe("buildSheet: the file's page breaks", () => {
  it("starts a page where the file does, even with room left", () => {
    const page = { width: 800, height: 500, margin: 40, gap: 20 };
    // 4 systems of 100 px would fit one page; the file breaks the page before bar 4 (third system)
    const sheet = buildSheet([[0, 7]], new Map([[0, chunk(0, 7)]]), page, new Set([4]));
    expect(sheet.pages.map((p) => p.top)).toEqual([0, 300]);
    expect(sheet.pages.map((p) => p.height)).toEqual([280, 280]);
    expect(sheet.rows.map((r) => r.top)).toEqual([40, 140, 340, 440]);
  });
});
