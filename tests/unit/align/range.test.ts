import { describe, expect, it } from "vitest";
import type { InfoMap } from "@/shared/info-map";
import type { MeasureAlignment } from "@/shared/sync";
import { planRangeWindow, recomputeRanges, SEAM_CONFIDENCE_CAP, sliceInfoMap, spliceAuto } from "@/lib/align/range";

const aligned: MeasureAlignment[] = Array.from({ length: 40 }, (_, i) => ({ n: i + 1, startSec: 1 + i * 2, confidence: 80 }));

describe("planRangeWindow", () => {
  it("pads 2–8 s, starts at 0 for bar 1 and ends at the recording end for the last bar", () => {
    const w = planRangeWindow(aligned, { from: 10, to: 20 }, 90, []);
    expect(w.innerStartSec).toBe(19);
    expect(w.innerEndSec).toBe(41);
    expect(w.startSec).toBeCloseTo(19 - 3.3);
    const first = planRangeWindow(aligned, { from: 1, to: 3 }, 90, []);
    expect(first.innerStartSec).toBe(0);
    const last = planRangeWindow(aligned, { from: 38, to: 40 }, 90, []);
    expect(last.innerEndSec).toBe(90);
    expect(last.endSec).toBe(90);
  });

  it("uses 0.25 s on a side pinned by a downbeat marker", () => {
    const w = planRangeWindow(aligned, { from: 10, to: 20 }, 90, [{ id: "a", measure: 10, startSec: 19, createdAt: "" }]);
    expect(w.startSec).toBeCloseTo(18.75);
  });
});

describe("spliceAuto", () => {
  it("keeps bars outside identical and recomputes the average", () => {
    const partial = [10, 11, 12].map((n) => ({ n, startSec: 1 + (n - 1) * 2 + 0.1, confidence: 20 }));
    const { auto, averageConfidence } = spliceAuto(aligned, partial, { from: 10, to: 12 });
    expect(auto[0]).toBe(aligned[0]);
    expect(auto[9].startSec).toBeCloseTo(19.1);
    expect(averageConfidence).toBe(Math.round((37 * 80 + 3 * 20) / 40));
  });

  it("clamps a seam that would break the order and caps its confidence", () => {
    const partial = [{ n: 10, startSec: 10, confidence: 95 }];
    const { auto, seamClamped } = spliceAuto(aligned, partial, { from: 10, to: 10 });
    expect(seamClamped).toBeGreaterThan(0);
    expect(auto[9].startSec).toBeGreaterThan(auto[8].startSec);
    expect(auto[9].confidence).toBeLessThanOrEqual(SEAM_CONFIDENCE_CAP);
  });
});

describe("recomputeRanges", () => {
  it("is local: each pending bar ± 2, merging ranges that touch", () => {
    expect(recomputeRanges([8, 400], 480)).toEqual([
      { from: 6, to: 10 },
      { from: 398, to: 402 },
    ]);
    expect(recomputeRanges([8, 12, 1], 20)).toEqual([
      { from: 1, to: 3 },
      { from: 6, to: 14 },
    ]);
  });
});

describe("sliceInfoMap", () => {
  it("renumbers bars, shifts times and keeps the tempo in force", () => {
    const infoMap: InfoMap = {
      instruments: [{ id: "P1", name: "V", shortName: "V", section: "Strings", notes: [{ time: 4.5, duration: 1, pitch: 60, dynamics: "mf", styleMarking: null, measure: 3 }] }],
      measures: [0, 2, 4, 6].map((startTime, i) => ({ number: i + 1, startTime, duration: 2 })),
      duration: 8,
      tempo: 120,
      timeSignature: "4/4",
      warnings: [],
      timing: { tempo: [{ time: 0, bpm: 120 }, { time: 3, bpm: 90 }], fermatas: [{ start: 3.5, end: 4.5 }] },
    };
    const s = sliceInfoMap(infoMap, 3, 4);
    expect(s.measures.map((m) => [m.number, m.startTime])).toEqual([
      [1, 0],
      [2, 2],
    ]);
    expect(s.instruments[0].notes[0]).toMatchObject({ time: 0.5, measure: 1 });
    expect(s.timing!.tempo[0]).toEqual({ time: 0, bpm: 90 });
    expect(s.timing!.fermatas).toEqual([{ start: 0, end: 0.5 }]);
    expect(s.duration).toBe(4);
  });
});
