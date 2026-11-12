import { describe, expect, it } from "vitest";
import { followScrollTop, runs, systemAt, systemCuts, systemsInView } from "@/lib/score/systems";

const bands = [
  { top: 70, bottom: 800 },
  { top: 900, bottom: 1600 },
  { top: 1700, bottom: 2500 },
];

describe("system geometry", () => {
  it("cuts the sheet halfway through each gap", () => {
    expect(systemCuts(bands, 2600)).toEqual([0, 850, 1650, 2600]);
    expect(systemCuts([], 300)).toEqual([0, 300]);
    // a sheet reported shorter than its last system still covers it
    expect(systemCuts(bands, 2000)).toEqual([0, 850, 1650, 2500]);
  });

  it("finds the system owning a position and the systems in a view", () => {
    const cuts = systemCuts(bands, 2600);
    expect(systemAt(cuts, 0)).toBe(0);
    expect(systemAt(cuts, 849)).toBe(0);
    expect(systemAt(cuts, 850)).toBe(1);
    expect(systemAt(cuts, 9999)).toBe(2);
    expect(systemsInView(cuts, 700, 1000)).toEqual([0, 1]);
    expect(systemsInView(cuts, 2000, 2600)).toEqual([2, 2]);
    expect(systemsInView(cuts, 3000, 3500)).toBeNull();
  });

  it("scrolls a short system to the top and keeps the reader's place in a tall one", () => {
    const cuts = systemCuts(bands, 2600);
    expect(followScrollTop(cuts, 1, null, 30)).toBe(820);
    expect(followScrollTop(cuts, 1, 0.5)).toBe(1250);
    expect(followScrollTop(cuts, 0, null, 30)).toBe(0);
  });

  it("groups consecutive bars into runs", () => {
    expect(runs([1, 2, 3, 7, 8, 10])).toEqual([
      [1, 3],
      [7, 8],
      [10, 10],
    ]);
    expect(runs([])).toEqual([]);
  });
});
