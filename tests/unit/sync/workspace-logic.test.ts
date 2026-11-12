import { describe, expect, it } from "vitest";
import type { InfoMap } from "@/shared/info-map";
import type { ManualMarker, MeasureAlignment, PendingItem } from "@/shared/sync";
import { filterMeasures, nextUncertain } from "@/components/sync/sidebar/MeasuresSection";
import { recomputeSuggestion, SUGGEST_AFTER_PENDING } from "@/components/sync/markers/RecomputeSuggestion";
import { recomputeLabel } from "@/components/sync/markers/markerName";
import { resultLine } from "@/components/sync/sidebar/SyncSection";
import { parseTimeField } from "@/components/sync/markers/MarkerDetails";
import { stepSpot } from "@/components/sync/score/ScorePane";
import { buildRollIndex, pitchTicks, queryWindow, zoomAt } from "@/lib/sync/roll";

const auto: MeasureAlignment[] = [95, 40, 70, 20, 99].map((confidence, i) => ({ n: i + 1, startSec: i * 2, confidence }));
const mk = (id: string, measure: number, startSec: number): ManualMarker => ({ id, measure, startSec, createdAt: "", basis: "time" });

describe("Measures", () => {
  it("sorts by confidence and filters by band and bar range", () => {
    expect(filterMeasures(auto, { sort: "confidence", bands: new Set() }).map((a) => a.n)).toEqual([4, 2, 3, 1, 5]);
    expect(filterMeasures(auto, { sort: "order", bands: new Set(["low"]) }).map((a) => a.n)).toEqual([2, 4]);
    expect(filterMeasures(auto, { sort: "order", bands: new Set(), from: 2, to: 3 }).map((a) => a.n)).toEqual([2, 3]);
  });

  it("Next uncertain skips bars with a marker (owner)", () => {
    expect(nextUncertain(auto, new Set([2]), 1)).toBe(3);
    expect(nextUncertain(auto, new Set([2, 3, 4]), 1)).toBeNull();
  });
});

describe("recompute suggestion", () => {
  const item = (id: string, measure: number, startSec: number): PendingItem => ({ id, kind: "new", bars: [measure], intended: mk(id, measure, startSec) });
  const landing = (m: { measure: number }) => (m.measure - 1) * 2;

  it("appears for a marker more than 250 ms from where its note plays, never for a small one", () => {
    expect(recomputeSuggestion([item("a", 3, 4.1)], landing, 480)).toBeNull();
    const s = recomputeSuggestion([item("a", 3, 4.4)], landing, 480)!;
    expect(s.ranges).toEqual([{ from: 1, to: 5 }]);
    expect(s.label).toBe("Recompute bars 1–5 to apply 1 marker");
  });

  it("appears once enough markers are waiting, with local ranges", () => {
    const items = Array.from({ length: SUGGEST_AFTER_PENDING }, (_, k) => item(`m${k}`, 10 + k * 100, (9 + k * 100) * 2));
    const s = recomputeSuggestion(items, landing, 480)!;
    expect(s.ranges.length).toBe(SUGGEST_AFTER_PENDING);
    expect(recomputeLabel(s.ranges, items.length)).toBe(`Recompute ${SUGGEST_AFTER_PENDING} passages to apply ${SUGGEST_AFTER_PENDING} markers`);
  });
});

describe("copy and fields", () => {
  it("reports a run", () => {
    expect(resultLine({ measures: 40, averageConfidence: 81, uncertainMeasures: 3, method: "x", range: { from: 6, to: 16 }, applied: 3, stillPending: 1, fellBack: true })).toBe(
      "Bars 6–16 recomputed · 3 markers applied · 1 still pending · 81% average (used the fallback aligner)",
    );
  });
  it("reads ms or m:ss.mmm", () => {
    expect(parseTimeField("83456")).toBeCloseTo(83.456);
    expect(parseTimeField("1:23.456")).toBeCloseTo(83.456);
    expect(parseTimeField("x")).toBeNull();
  });
});

const infoMap: InfoMap = {
  instruments: [
    { id: "P1", name: "Violin", shortName: "Vln.", section: "Strings", notes: [0, 1, 2, 3].map((time) => ({ time, duration: 1, pitch: 67, dynamics: "mf", styleMarking: null, measure: time < 2 ? 1 : 2 })) },
    { id: "P2", name: "Clarinet", shortName: "Cl.", section: "Woodwinds", transpose: -2, notes: [{ time: 0.5, duration: 1, pitch: 62, dynamics: "mf", styleMarking: null, measure: 1 }] },
  ],
  measures: [
    { number: 1, startTime: 0, duration: 2 },
    { number: 2, startTime: 2, duration: 2 },
  ],
  duration: 4,
  tempo: 120,
  timeSignature: "4/4",
  warnings: [],
};

describe("score keys and the roll model", () => {
  it("steps note by note across bars", () => {
    expect(stepSpot(infoMap, { measure: 1, position: 0 }, 1)).toEqual({ measure: 1, position: 0.25 });
    expect(stepSpot(infoMap, { measure: 1, position: 0.5 }, 1)).toEqual({ measure: 2, position: 0 });
    expect(stepSpot(infoMap, { measure: 2, position: 0 }, -1)).toEqual({ measure: 1, position: 0.5 });
  });

  it("places notes at sounding pitch on the recording's clock, colored by section", () => {
    const aligned: MeasureAlignment[] = [
      { n: 1, startSec: 10, confidence: 90 },
      { n: 2, startSec: 14, confidence: 90 },
    ];
    const index = buildRollIndex(infoMap, aligned, { sections: { P2: "Brass" } } as never);
    const cl = index.notes.find((n) => n.part === 1)!;
    expect(cl.pitch).toBe(60); // written D, sounding C
    expect(cl.section).toBe("Brass"); // reassigned in Customize
    expect(index.notes[0].start).toBe(10);
    expect(queryWindow(index, 11.5, 11.6).length).toBeGreaterThan(0); // a note that started before the window
    expect(index.onsets.map((o) => o.at)).toEqual([10, 11, 12, 14, 15]); // the last bar runs for its score length
  });

  it("labels every C in the pitch gutter and zooms around an anchor", () => {
    expect(pitchTicks(55, 74, 2).map((t) => t.label)).toEqual(["C4", "C5"]);
    const v = zoomAt({ t0: 0, t1: 20 }, 5, 0.5, { min: 1, max: 100 });
    expect(v.t0).toBeCloseTo(2.5);
    expect(v.t1).toBeCloseTo(12.5);
  });
});
