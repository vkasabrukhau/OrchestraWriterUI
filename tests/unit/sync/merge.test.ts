import { describe, expect, it } from "vitest";
import type { InfoMap } from "@/shared/info-map";
import {
  mergeAlignment,
  measureAtRecordingTime,
  recordingToScoreTime,
  sameMarkerSpot,
  scoreToRecordingTime,
  type ManualMarker,
  type MeasureAlignment,
} from "@/shared/sync";

/** n bars of 2 s score time; the recording plays them 1 s late, also 2 s each */
function setup(n = 6) {
  const infoMap = {
    instruments: [],
    measures: Array.from({ length: n }, (_, k) => ({ number: k + 1, startTime: 2 * k, duration: 2 })),
    duration: 2 * n,
    tempo: 60,
    timeSignature: "2/4",
    warnings: [],
  } as InfoMap;
  const auto: MeasureAlignment[] = infoMap.measures.map((m) => ({ n: m.number, startSec: m.startTime + 1, confidence: 70 }));
  return { infoMap, auto };
}

const marker = (measure: number, startSec: number, position?: number): ManualMarker => ({
  id: `mk_${measure}_${position ?? 0}`,
  measure,
  position,
  startSec,
  createdAt: "2026-11-08T00:00:00.000Z",
});

describe("mergeAlignment: downbeat markers", () => {
  it("returns the automatic alignment when there are no markers", () => {
    const { auto } = setup();
    expect(mergeAlignment(auto, [])).toBe(auto);
  });

  it("pins the bar, shifts the bars before and after, and stretches between markers", () => {
    const { auto } = setup();
    const merged = mergeAlignment(auto, [marker(2, 4), marker(4, 8)]);
    // auto starts 1 3 5 7 9 11; bar 2 → 4 (+1), bar 4 → 8 (+1): everything before/after shifts by 1,
    // bar 3 sits halfway between in auto time
    expect(merged.map((a) => a.startSec)).toEqual([2, 4, 6, 8, 10, 12]);
    // markers never change confidence: it is the aligner's (ADR 0018)
    expect(merged.map((a) => a.confidence)).toEqual([70, 70, 70, 70, 70, 70]);
    expect(merged.every((a) => a.points === undefined)).toBe(true);
  });

  it("stays monotonic when a marker is placed before its predecessor", () => {
    const { auto } = setup();
    const merged = mergeAlignment(auto, [marker(3, 0.5)]);
    for (let i = 1; i < merged.length; i++) expect(merged[i].startSec).toBeGreaterThan(merged[i - 1].startSec);
  });
});

describe("mergeAlignment: note-level markers", () => {
  it("adds a point inside the bar and re-times the neighborhood from it", () => {
    const { auto } = setup();
    // the second beat of bar 3 (auto 6.0) is heard at 6.5
    const merged = mergeAlignment(auto, [marker(3, 6.5, 0.5)]);
    expect(merged[2].points).toEqual([{ pos: 0.5, sec: 6.5 }]);
    expect(merged[2].confidence).toBe(70);
    // a single marker shifts everything by its offset
    expect(merged.map((a) => a.startSec)).toEqual([1.5, 3.5, 5.5, 7.5, 9.5, 11.5]);
  });

  it("keeps one marker per note and orders several in one bar", () => {
    const { auto } = setup();
    const merged = mergeAlignment(auto, [marker(2, 3.9, 0.75), marker(2, 3.4, 0.25), marker(2, 3.55, 0.25)]);
    expect(merged[1].points).toEqual([
      { pos: 0.25, sec: 3.55 },
      { pos: 0.75, sec: 3.9 },
    ]);
  });

  it("does not mix up a downbeat marker and a note marker in the same bar", () => {
    expect(sameMarkerSpot(marker(2, 3), 2, 0)).toBe(true);
    expect(sameMarkerSpot(marker(2, 3, 0.5), 2, 0)).toBe(false);
    expect(sameMarkerSpot(marker(2, 3, 0.5), 2, 0.5)).toBe(true);
  });
});

describe("clock maps with note-level points", () => {
  it("passes exactly through a pinned note in both directions", () => {
    const { infoMap, auto } = setup();
    const merged = mergeAlignment(auto, [marker(3, 5, 0), marker(3, 6.5, 0.5), marker(4, 7, 0)]);
    // bar 3: score 4–6, recording 5–7, with its second beat (score 5) at 6.5
    expect(scoreToRecordingTime(infoMap, merged, 5)).toBeCloseTo(6.5, 9);
    expect(recordingToScoreTime(infoMap, merged, 6.5)).toBeCloseTo(5, 9);
    // piecewise between the knots
    expect(scoreToRecordingTime(infoMap, merged, 4.5)).toBeCloseTo(5.75, 9);
    expect(recordingToScoreTime(infoMap, merged, 6.75)).toBeCloseTo(5.5, 9);
    expect(measureAtRecordingTime(merged, 6.9)).toBe(3);
  });

  it("round-trips across the score", () => {
    const { infoMap, auto } = setup();
    const merged = mergeAlignment(auto, [marker(2, 3.2, 0.3), marker(5, 9.4, 0.6)]);
    for (let s = 0; s < 11.9; s += 0.37) {
      expect(recordingToScoreTime(infoMap, merged, scoreToRecordingTime(infoMap, merged, s))).toBeCloseTo(s, 6);
    }
  });

  it("matches the bar-level mapping when there are no points", () => {
    const { infoMap, auto } = setup();
    expect(scoreToRecordingTime(infoMap, auto, 3)).toBeCloseTo(4, 9);
    expect(recordingToScoreTime(infoMap, auto, 4)).toBeCloseTo(3, 9);
    // the last bar runs for its score length
    expect(recordingToScoreTime(infoMap, auto, 12.5)).toBeCloseTo(11.5, 9);
  });
});

