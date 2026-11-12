import { describe, expect, it } from "vitest";
import { barAtScoreTime, fractionAtX, fractionInBar, normalizeOnsets, playheadX } from "@/lib/score/playhead";
import type { MeasureInfo } from "@/shared/info-map";

const measures: MeasureInfo[] = [
  { number: 1, startTime: 0, duration: 2 },
  { number: 2, startTime: 2, duration: 2 },
  { number: 3, startTime: 4, duration: 3 },
];

// a 4/4 bar drawn from x=100 to x=300: quarter notes at 120, 160, 200, 240
const quarters = [
  { stamp: 0, x: 120 },
  { stamp: 0.25, x: 160 },
  { stamp: 0.5, x: 200 },
  { stamp: 0.75, x: 240 },
];

describe("normalizeOnsets", () => {
  it("sorts by stamp and keeps the leftmost x per stamp across staves", () => {
    expect(
      normalizeOnsets([
        { stamp: 0.5, x: 203 },
        { stamp: 0, x: 121 },
        { stamp: 0.5, x: 200 },
        { stamp: 0, x: 120 },
      ]),
    ).toEqual([
      { stamp: 0, x: 120 },
      { stamp: 0.5, x: 200 },
    ]);
  });

  it("drops onsets engraved left of an earlier one so the line never runs backwards", () => {
    expect(
      normalizeOnsets([
        { stamp: 0, x: 120 },
        { stamp: 0.25, x: 110 },
        { stamp: 0.5, x: 200 },
      ]).map((o) => o.stamp),
    ).toEqual([0, 0.5]);
  });

  it("ignores non-finite values", () => {
    expect(normalizeOnsets([{ stamp: Number.NaN, x: 1 }, { stamp: 0, x: Number.POSITIVE_INFINITY }])).toEqual([]);
  });
});

describe("barAtScoreTime / fractionInBar", () => {
  it("finds the playback bar holding a score time", () => {
    expect(barAtScoreTime(measures, 0)).toBe(1);
    expect(barAtScoreTime(measures, 1.99)).toBe(1);
    expect(barAtScoreTime(measures, 2)).toBe(2);
    expect(barAtScoreTime(measures, 99)).toBe(3);
    expect(barAtScoreTime(measures, -1)).toBe(1);
  });

  it("clamps the fraction to the bar", () => {
    expect(fractionInBar(measures[2], 5.5)).toBeCloseTo(0.5);
    expect(fractionInBar(measures[2], 3)).toBe(0);
    expect(fractionInBar(measures[2], 10)).toBe(1);
    expect(fractionInBar({ number: 1, startTime: 0, duration: 0 }, 1)).toBe(0);
  });
});

describe("playheadX", () => {
  it("sits on an onset at its time", () => {
    expect(playheadX(quarters, 100, 300, 0)).toBe(120);
    expect(playheadX(quarters, 100, 300, 0.5)).toBe(200);
  });

  it("glides between onsets in continuous mode", () => {
    expect(playheadX(quarters, 100, 300, 0.375)).toBeCloseTo(180);
  });

  it("glides from the last onset towards the bar's right edge", () => {
    // last onset 240 at 0.75; end point is right − 4 = 296 at 1
    expect(playheadX(quarters, 100, 300, 0.875)).toBeCloseTo(268);
    expect(playheadX(quarters, 100, 300, 1)).toBeCloseTo(296);
  });

  it("steps to the latest onset reached in stepped mode", () => {
    expect(playheadX(quarters, 100, 300, 0.375, true)).toBe(160);
    expect(playheadX(quarters, 100, 300, 0.99, true)).toBe(240);
  });

  it("holds at the first onset before it (pickup space, clef area)", () => {
    expect(playheadX([{ stamp: 0.5, x: 200 }], 100, 300, 0.1)).toBe(200);
  });

  it("falls back to a linear sweep without onsets", () => {
    expect(playheadX([], 100, 300, 0.25)).toBe(150);
  });
});

describe("fractionAtX", () => {
  it("snaps a click to the nearest onset", () => {
    expect(fractionAtX(quarters, 100, 300, 170)).toBe(0.25);
    expect(fractionAtX(quarters, 100, 300, 105)).toBe(0);
    expect(fractionAtX(quarters, 100, 300, 299)).toBe(0.75);
  });

  it("is linear without onsets", () => {
    expect(fractionAtX([], 100, 300, 200)).toBe(0.5);
    expect(fractionAtX([], 100, 100, 200)).toBe(0);
  });
});
