import { describe, expect, it } from "vitest";
import type { InfoMap } from "@/shared/info-map";
import type { DisplaySettings } from "@/shared/project-file";
import { DEFAULT_SECTION_COLORS } from "@/shared/sections";
import { laneOpacity, laneRows } from "@/components/music/PartLanes";
import { normalizeHex, sectionTints, shade } from "@/components/customize/color";

const note = (time: number, duration: number, dynamics: "p" | "f" | "mf", measure: number) => ({ time, duration, pitch: 60, dynamics, styleMarking: null, measure });

const infoMap: InfoMap = {
  instruments: [
    { id: "F", name: "Flute", shortName: "Fl.", section: "Woodwinds", notes: [note(0, 1, "p", 1), note(1, 1, "p", 1), note(2, 1, "f", 2)] },
    { id: "V", name: "Violin I", shortName: "Vln. I", section: "Strings", notes: [note(0, 2, "mf", 1)] },
    { id: "X", name: "Celesta", shortName: "Cel.", section: "Other", notes: [] },
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

const display: DisplaySettings = {
  visibleParts: ["F", "V", "X"],
  positions: {},
  colors: {},
  sectionColors: { ...DEFAULT_SECTION_COLORS },
  sections: {},
  showLabels: true,
  labelMode: "sections",
  reducedMotion: false,
  glowScale: 1,
};

describe("laneRows", () => {
  it("orders rows by section like the instruments panel", () => {
    expect(laneRows(infoMap, display).map((r) => r.inst.id)).toEqual(["V", "F", "X"]);
  });

  it("follows a section reassignment", () => {
    const rows = laneRows(infoMap, { ...display, sections: { V: "Other" } });
    expect(rows.map((r) => r.inst.id)).toEqual(["F", "V", "X"]);
  });

  it("marks a dynamic only where it changes", () => {
    const flute = laneRows(infoMap, display).find((r) => r.inst.id === "F")!;
    expect(flute.segments.map((s) => s.dynamic)).toEqual(["p", "f"]);
    expect(flute.changes.map((s) => [s.start, s.dynamic])).toEqual([
      [0, "p"],
      [2, "f"],
    ]);
  });

  it("gives silent parts an empty lane", () => {
    expect(laneRows(infoMap, display).find((r) => r.inst.id === "X")!.segments).toEqual([]);
  });
});

describe("laneOpacity", () => {
  it("rises with the written dynamic", () => {
    expect(laneOpacity("pp")).toBeLessThan(laneOpacity("mf"));
    expect(laneOpacity("mf")).toBeLessThan(laneOpacity("fff"));
    expect(laneOpacity("fff")).toBe(1);
  });
});

describe("color helpers", () => {
  it("normalizes hex input", () => {
    expect(normalizeHex("D97A68")).toBe("#d97a68");
    expect(normalizeHex(" #D97A68 ")).toBe("#d97a68");
    expect(normalizeHex("#fff")).toBeNull();
    expect(normalizeHex("zzzzzz")).toBeNull();
  });

  it("shades toward white and black", () => {
    expect(shade("#808080", 1)).toBe("#ffffff");
    expect(shade("#808080", -1)).toBe("#000000");
    expect(shade("#808080", 0)).toBe("#808080");
  });

  it("builds six tints with the section color in the middle", () => {
    const t = sectionTints("#E2B04C");
    expect(t).toHaveLength(6);
    expect(t[2]).toBe("#e2b04c");
    expect(new Set(t).size).toBe(6);
  });
});
