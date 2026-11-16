import { describe, expect, it } from "vitest";
import type { InfoMap } from "@/shared/info-map";
import { barAt, beatIn, beatsOf, landmarks, noteOnsets, resolveGoTo, stepBar, stepOnset } from "@/lib/score/navigation";
import { parseOk } from "./helpers";

/** six 2 s bars; bars 4–5 replay printed bars 2–3; rehearsal A at printed 2, B at printed 3 */
function map(): InfoMap {
  const labels = [undefined, undefined, undefined, "2", "3", "4"];
  const marks = [undefined, "A", "B", "A", "B", undefined];
  return {
    instruments: [
      { id: "P1", name: "Flute", shortName: "Fl.", section: "Woodwinds", notes: [0, 1, 2.5, 6, 6.5].map((time) => ({ time, duration: 0.5, pitch: 72, dynamics: "mf", styleMarking: null, measure: Math.floor(time / 2) + 1 })) },
      { id: "P2", name: "Violin I", shortName: "Vln. I", section: "Strings", notes: [0.5, 2.5, 7].map((time) => ({ time, duration: 0.5, pitch: 60, dynamics: "mf", styleMarking: null, measure: Math.floor(time / 2) + 1 })) },
    ],
    measures: labels.map((label, k) => ({ number: k + 1, startTime: 2 * k, duration: 2, ...(label ? { label } : {}), ...(marks[k] ? { rehearsal: marks[k] } : {}) })),
    duration: 12,
    tempo: 60,
    timeSignature: "2/4",
    warnings: [],
    timing: { tempo: [{ time: 0, bpm: 60 }, { time: 8, bpm: 90 }], fermatas: [] },
  } as InfoMap;
}

describe("resolveGoTo", () => {
  it("finds printed bar numbers, picking the pass nearest the playhead", () => {
    expect(resolveGoTo("3", map(), 1)).toEqual({ kind: "bar", measure: 3, scoreTime: 4 });
    expect(resolveGoTo("3", map(), 6)).toEqual({ kind: "bar", measure: 5, scoreTime: 8 });
    expect(resolveGoTo("4", map(), 1)).toMatchObject({ kind: "bar", measure: 6 });
  });

  it("finds rehearsal marks plainly or explicitly", () => {
    expect(resolveGoTo("b", map(), 1)).toMatchObject({ kind: "bar", measure: 3 });
    expect(resolveGoTo("letter A", map(), 6)).toMatchObject({ kind: "bar", measure: 4 });
    expect(resolveGoTo("[B]", map(), 1)).toMatchObject({ measure: 3 });
    expect(resolveGoTo("rA", map(), 1)).toMatchObject({ measure: 2 });
    expect(resolveGoTo("letter Q", map())).toMatchObject({ kind: "error" });
  });

  it("reads times in the recording", () => {
    expect(resolveGoTo("1:05", map(), 1, 300)).toEqual({ kind: "time", sec: 65 });
    expect(resolveGoTo("12.5s", map(), 1, 300)).toEqual({ kind: "time", sec: 12.5 });
    expect(resolveGoTo("9:00", map(), 1, 300)).toMatchObject({ kind: "error" });
  });

  it("explains a miss", () => {
    expect(resolveGoTo("99", map())).toEqual({ kind: "error", message: "Bar 99 is not in this score (it ends at bar 4)." });
    expect(resolveGoTo("  ", map())).toMatchObject({ kind: "error" });
    expect(resolveGoTo("Coda", map())).toMatchObject({ kind: "error" });
  });
});

describe("landmarks", () => {
  it("lists rehearsal marks and tempo changes in playback order", () => {
    expect(landmarks(map())).toEqual([
      { measure: 2, kind: "rehearsal", text: "A" },
      { measure: 3, kind: "rehearsal", text: "B" },
      { measure: 4, kind: "rehearsal", text: "A" },
      { measure: 5, kind: "rehearsal", text: "B" },
      { measure: 5, kind: "tempo", text: "♩ = 90" },
    ]);
  });

  it("reads marks parsed from a real file", () => {
    const { infoMap } = parseOk("quirks/rehearsal.musicxml");
    expect(landmarks(infoMap).filter((l) => l.kind === "rehearsal").map((l) => [l.measure, l.text])).toEqual([
      [2, "A"],
      [3, "B"],
      [4, "A"],
      [5, "B"],
    ]);
  });
});

describe("note and bar stepping", () => {
  it("collects onsets of the visible parts plus every downbeat", () => {
    expect(noteOnsets(map())).toEqual([0, 0.5, 1, 2, 2.5, 4, 6, 6.5, 7, 8, 10]);
    expect(noteOnsets(map(), new Set(["P2"]))).toEqual([0, 0.5, 2, 2.5, 4, 6, 7, 8, 10]);
  });

  it("steps note by note, skipping the onset just passed when going back", () => {
    const on = noteOnsets(map());
    expect(stepOnset(on, 1, 1)).toBe(2);
    expect(stepOnset(on, 1.02, -1)).toBe(0.5);
    expect(stepOnset(on, 1.2, -1)).toBe(1);
    expect(stepOnset(on, 10.5, 1)).toBe(10);
    expect(stepOnset(on, 0, -1)).toBe(0);
  });

  it("steps bar by bar", () => {
    const ms = map().measures;
    expect(stepBar(ms, 3, 1)).toBe(4);
    expect(stepBar(ms, 3, -1)).toBe(2);
    expect(stepBar(ms, 2.01, -1)).toBe(0);
    expect(stepBar(ms, 11, 1)).toBe(10);
    expect(barAt(ms, 3.999)).toBe(2);
  });

  it("reports the beat", () => {
    const m = map().measures[1];
    expect(beatsOf("3/4")).toBe(3);
    expect(beatsOf("C")).toBe(4);
    expect(beatIn(m, 2, 2)).toBe(1);
    expect(beatIn(m, 3.1, 2)).toBe(2);
    expect(beatIn(m, 4, 2)).toBe(2);
  });
});
