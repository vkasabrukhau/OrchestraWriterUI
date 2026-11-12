import { describe, expect, it } from "vitest";
import type { InfoMap } from "@/shared/info-map";
import { pendingOf, type ManualMarker, type SyncState } from "@/shared/sync";
import { canonicalPosition, musicalToTimeFraction, normalizeMarkers, timeToMusicalFraction } from "@/lib/score/stamps";

// bar 1: 4 beats at 120 bpm (2 s); bar 2: 2 beats at 120 then 2 at 60 (1 s + 2 s = 3 s)
const infoMap: InfoMap = {
  instruments: [
    {
      id: "P1",
      name: "Violin",
      shortName: "Vln.",
      section: "Strings",
      notes: [0, 0.5, 1, 1.5, 2, 2.5, 3, 4].map((time) => ({ time, duration: 0.4, pitch: 60, dynamics: "mf", styleMarking: null, measure: time < 2 ? 1 : 2 })),
    },
  ],
  measures: [
    { number: 1, startTime: 0, duration: 2 },
    { number: 2, startTime: 2, duration: 3 },
  ],
  duration: 5,
  tempo: 120,
  timeSignature: "4/4",
  warnings: [],
  timing: { tempo: [{ time: 0, bpm: 120 }, { time: 3, bpm: 60 }], fermatas: [] },
};

const mk = (id: string, measure: number, position: number | undefined, extra: Partial<ManualMarker> = {}): ManualMarker => ({
  id,
  measure,
  startSec: measure * 2,
  createdAt: "2026-11-09T00:00:00.000Z",
  ...(position ? { position } : {}),
  ...extra,
});

describe("stamps", () => {
  it("is the identity in a bar without a tempo change", () => {
    expect(musicalToTimeFraction(infoMap, 1, 0.25)).toBeCloseTo(0.25);
  });

  it("round-trips musical and time fractions across a mid-bar tempo change", () => {
    // beat 3 of bar 2 (musical 0.5) sounds 1 s into the 3 s bar
    expect(musicalToTimeFraction(infoMap, 2, 0.5)).toBeCloseTo(1 / 3);
    for (const f of [0, 0.2, 0.5, 0.75, 1]) expect(timeToMusicalFraction(infoMap, 2, musicalToTimeFraction(infoMap, 2, f))).toBeCloseTo(f);
  });

  it("snaps to the nearest onset within 1e-3", () => {
    expect(canonicalPosition(infoMap, 1, 0.2502)).toBe(0.25);
    expect(canonicalPosition(infoMap, 1, 0.3)).toBe(0.3);
  });
});

describe("normalizeMarkers", () => {
  const sync = (manual: ManualMarker[], applied?: ManualMarker[]): SyncState => ({ method: "x", auto: [], manual, ...(applied ? { applied } : {}), averageConfidence: 0 });

  it("converts a legacy OSMD (musical) position to time by the closer reading", () => {
    const out = normalizeMarkers(sync([mk("a", 2, 0.5)]), infoMap);
    expect(out.manual[0].position).toBeCloseTo(1 / 3);
    expect(out.manual[0].basis).toBe("time");
  });

  it("gives a legacy state applied = manual, so nothing is pending", () => {
    const out = normalizeMarkers(sync([mk("a", 1, 0.25), mk("b", 2, undefined)]), infoMap);
    expect(out.applied).toEqual(out.manual);
    expect(pendingOf(out.manual, out.applied!)).toEqual([]);
  });

  it("collapses duplicates on one note to the latest, in both lists", () => {
    const a = mk("a", 1, 0.25, { createdAt: "2026-01-01T00:00:00Z" });
    const b = mk("b", 1, 0.2502, { createdAt: "2026-02-01T00:00:00Z" });
    const out = normalizeMarkers(sync([a, b]), infoMap);
    expect(out.manual.map((m) => m.id)).toEqual(["b"]);
    expect(out.applied!.map((m) => m.id)).toEqual(["b"]);
  });

  it("is idempotent and never creates a pending item", () => {
    const once = normalizeMarkers(sync([mk("a", 2, 0.5)], [mk("a", 2, 0.5)]), infoMap);
    expect(normalizeMarkers(once, infoMap)).toBe(once);
    expect(pendingOf(once.manual, once.applied!)).toEqual([]);
  });
});
