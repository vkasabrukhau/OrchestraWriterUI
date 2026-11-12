import { describe, expect, it } from "vitest";
import type { InfoMap, MeasureInfo } from "@/shared/info-map";
import { pageRange, playbackBarFor, writtenCount, writtenIndices } from "@/lib/score/written";
import { parseOk } from "./helpers";

const map = (measures: MeasureInfo[], timing?: InfoMap["timing"]): InfoMap => ({ instruments: [], measures, duration: measures.length, tempo: 120, timeSignature: "4/4", warnings: [], timing });
const bar = (number: number, extra: Partial<MeasureInfo> = {}): MeasureInfo => ({ number, startTime: number - 1, duration: 1, ...extra });

describe("playback bars ↔ written bars", () => {
  it("reads the parser's writtenIndex for repeats", () => {
    const { infoMap } = parseOk("quirks/repeats.musicxml");
    const written = writtenIndices(infoMap);
    expect(written).toHaveLength(infoMap.measures.length);
    // a repeat plays some written bar twice, and every written bar is played
    expect(new Set(written).size).toBeLessThan(written.length);
    expect(new Set(written).size).toBe(writtenCount(written));
  });

  it("is the identity without repeats", () => {
    expect(writtenIndices(map([bar(1), bar(2), bar(3)], { tempo: [], fermatas: [] }))).toEqual([0, 1, 2]);
    expect(writtenIndices(map([bar(1), bar(2)]))).toEqual([0, 1]);
  });

  it("falls back to printed labels for info maps saved before writtenIndex", () => {
    // written 1 2 3 | repeat 2 3 | 4
    const old = map([bar(1), bar(2), bar(3), bar(4, { label: "2" }), bar(5, { label: "3" }), bar(6, { label: "4" })]);
    expect(writtenIndices(old)).toEqual([0, 1, 2, 1, 2, 3]);
  });

  it("clicks on a repeated written bar go to the occurrence nearest the playhead", () => {
    const written = [0, 1, 2, 1, 2, 3];
    expect(playbackBarFor(written, 1, 1)).toBe(2);
    expect(playbackBarFor(written, 1, 5)).toBe(4);
    expect(playbackBarFor(written, 3, 1)).toBe(6);
    expect(playbackBarFor(written, 9, 1)).toBeNull();
  });

  it("pages cover the written bars without running past the end", () => {
    expect(pageRange(0, 8, 20)).toEqual([0, 7]);
    expect(pageRange(2, 8, 20)).toEqual([16, 19]);
    expect(pageRange(5, 8, 20)).toEqual([19, 19]);
  });
});
