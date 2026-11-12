import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";
import type { InfoMap } from "@/shared/info-map";
import { parseMusicXml } from "@/shared/score";
import { mergeAlignment, type AlignAudio, type ManualMarker } from "@/shared/sync";
import { anchorColumnBounds, anchorMapping, cleanAnchors, markerAnchors, shiftAnchors } from "@/lib/align/anchors";
import { dtw } from "@/lib/align/dtw";
import { alignChromaDtw } from "@/lib/align/index";
import { alignIntegrated, type IntegratedDetail } from "@/lib/align/integrated";
import { sliceInfoMap } from "@/lib/align/range";
import { renderDemoRecording, type DemoTruth } from "../../../scripts/lib/demo-audio";

/** Manual markers as fixed anchors inside the aligners (ADR 0021). */

const fixtures = fileURLToPath(new URL("../../../fixtures/", import.meta.url));
const marker = (measure: number, startSec: number, position?: number): ManualMarker => ({ id: `m${measure}:${position ?? 0}`, measure, startSec, position, createdAt: "", basis: "time" });

describe("anchor helpers", () => {
  it("keeps anchors sorted, one per note, and drops one that runs time backwards", () => {
    const out = cleanAnchors([
      { scoreSec: 10, sec: 12 },
      { scoreSec: 2, sec: 3 },
      { scoreSec: 6, sec: 2 }, // before the anchor at score 2 in the recording
      { scoreSec: 10, sec: 12.5 }, // same note: the later edit wins
    ]);
    expect(out).toEqual([
      { scoreSec: 2, sec: 3 },
      { scoreSec: 10, sec: 12.5 },
    ]);
  });

  it("converts markers on bars and notes to score seconds", () => {
    const infoMap = {
      measures: [
        { number: 1, startTime: 0, duration: 2 },
        { number: 2, startTime: 2, duration: 2 },
      ],
    } as unknown as InfoMap;
    expect(markerAnchors(infoMap, [marker(2, 5, 0.5), marker(1, 1), marker(9, 3)])).toEqual([
      { scoreSec: 0, sec: 1 },
      { scoreSec: 3, sec: 5 },
    ]);
  });

  it("shifts anchors into a slice and keeps the one on the next downbeat", () => {
    const a = [
      { scoreSec: 1, sec: 1 },
      { scoreSec: 4, sec: 5 },
      { scoreSec: 8, sec: 9 },
      { scoreSec: 20, sec: 21 },
    ];
    expect(shiftAnchors(a, 4, 4, 3, 10)).toEqual([
      { scoreSec: 0, sec: 2 },
      { scoreSec: 4, sec: 6 },
    ]);
  });

  it("fences rows on each side of an anchor", () => {
    const { lo, hi } = anchorColumnBounds([{ row: 5, col: 20 }], 10, 40, 1);
    expect([lo[4], hi[4]]).toEqual([0, 21]);
    expect([lo[5], hi[5]]).toEqual([19, 21]);
    expect([lo[6], hi[6]]).toEqual([19, 39]);
  });

  it("re-times a mapping through the anchors, proportionally between them and shifted outside", () => {
    const m = anchorMapping({ score: [0, 10, 20], recording: [0, 10, 20] }, [
      { scoreSec: 5, sec: 7 },
      { scoreSec: 15, sec: 16 },
    ]);
    const at = (s: number) => m.recording[m.score.indexOf(s)];
    expect(at(5)).toBe(7);
    expect(at(15)).toBe(16);
    expect(at(0)).toBeCloseTo(2);
    expect(at(10)).toBeCloseTo(11.5);
    expect(at(20)).toBeCloseTo(21);
    for (let k = 1; k < m.recording.length; k++) expect(m.recording[k]).toBeGreaterThan(m.recording[k - 1]);
  });
});

describe("DTW with anchors", () => {
  it("passes within one column of an anchor the features disagree with", () => {
    // score: 20 rows of pitch class 0 then 20 of pitch class 6; recording: 10 then 30
    const vec = (c: number) => Float32Array.from({ length: 12 }, (_, k) => (k === c ? 1 : 0));
    const seq = (parts: Array<[number, number]>) => {
      const out: number[] = [];
      for (const [c, len] of parts) for (let i = 0; i < len; i++) out.push(...vec(c));
      return Float32Array.from(out);
    };
    const X = seq([
      [0, 20],
      [6, 20],
    ]);
    const Y = seq([
      [0, 10],
      [6, 30],
    ]);
    const free = dtw(X, Y, { radius: 40 });
    const colAt = (p: typeof free, row: number) => p.cols[p.rows.indexOf(row)];
    expect(colAt(free, 20)).toBeLessThanOrEqual(11);
    const pinned = dtw(X, Y, { radius: 40, anchors: [{ row: 20, col: 25 }] });
    for (let k = 0; k < pinned.rows.length; k++) if (pinned.rows[k] === 20) expect(Math.abs(pinned.cols[k] - 25)).toBeLessThanOrEqual(1);
  });
});

describe("aligners with anchors on the warped demo recording", () => {
  let infoMap: InfoMap;
  let audio: AlignAudio;
  let truth: DemoTruth;
  let plain: IntegratedDetail;
  const BAR = 20;
  const OFFSET = 0.6;

  beforeAll(async () => {
    const parsed = parseMusicXml({ bytes: new Uint8Array(readFileSync(fixtures + "scores/orchestra-demo.musicxml")), filename: "orchestra-demo.musicxml" });
    if (!parsed.ok) throw new Error(parsed.error);
    infoMap = parsed.infoMap;
    const rec = renderDemoRecording(infoMap);
    truth = rec.truth;
    audio = { samples: rec.samples, sampleRate: rec.sampleRate, durationSec: rec.samples.length / rec.sampleRate };
    plain = await alignIntegrated(infoMap, audio);
  }, 60_000);

  const truthAt = (bar: number) => truth.measures[bar - 1].recordingStartSec;

  it("integrated: lands exactly on true anchors and stays as accurate", async () => {
    const markers = [marker(10, truthAt(10)), marker(30, truthAt(30))];
    const d = await alignIntegrated(infoMap, audio, { anchors: markerAnchors(infoMap, markers) });
    expect(d.sync.auto[9].startSec).toBeCloseTo(Math.round(truthAt(10) * 1000) / 1000, 3);
    expect(d.sync.auto[29].startSec).toBeCloseTo(Math.round(truthAt(30) * 1000) / 1000, 3);
    const errors = d.sync.auto.map((a, i) => Math.abs(a.startSec - truthAt(i + 1)));
    expect(errors.reduce((s, e) => s + e, 0) / errors.length).toBeLessThan(0.04);
  }, 60_000);

  it("integrated: a marker is honoured, and the fit returns to the audio after it (a merge alone would shift every later bar)", async () => {
    const at = truthAt(BAR) + OFFSET;
    const d = await alignIntegrated(infoMap, audio, { anchors: markerAnchors(infoMap, [marker(BAR, at)]) });
    expect(d.sync.auto[BAR - 1].startSec).toBeCloseTo(Math.round(at * 1000) / 1000, 3);
    for (let k = 1; k < d.sync.auto.length; k++) expect(d.sync.auto[k].startSec).toBeGreaterThan(d.sync.auto[k - 1].startSec);
    // bars well after the marker: back on the recording with the anchored fit, off by the offset with a merge only
    const later = infoMap.measures.filter((m) => m.number >= BAR + 6 && m.number <= BAR + 15).map((m) => m.number);
    const anchoredErr = later.map((n) => Math.abs(d.sync.auto[n - 1].startSec - truthAt(n)));
    const merged = mergeAlignment(plain.sync.auto, [marker(BAR, at)]);
    const mergedErr = later.map((n) => Math.abs(merged[n - 1].startSec - truthAt(n)));
    expect(Math.max(...anchoredErr)).toBeLessThan(0.15);
    expect(Math.min(...mergedErr)).toBeGreaterThan(OFFSET - 0.15);
  }, 60_000);

  it("integrated on a slice: the anchors on both edges hold", async () => {
    const from = 12;
    const to = 24;
    const slice = sliceInfoMap(infoMap, from, to);
    const startSec = truthAt(from) - 3;
    const endSec = truthAt(to + 1) + 3;
    const sub = audio.samples.subarray(Math.round(startSec * audio.sampleRate), Math.round(endSec * audio.sampleRate));
    const anchors = shiftAnchors(markerAnchors(infoMap, [marker(from, truthAt(from)), marker(to + 1, truthAt(to + 1))]), infoMap.measures[from - 1].startTime, slice.duration, startSec, endSec - startSec);
    expect(anchors).toHaveLength(2);
    const d = await alignIntegrated(slice, { samples: Float32Array.from(sub), sampleRate: audio.sampleRate, durationSec: sub.length / audio.sampleRate }, { anchors });
    expect(d.sync.auto[0].startSec + startSec).toBeCloseTo(truthAt(from), 2);
    const errors = d.sync.auto.map((a, i) => Math.abs(a.startSec + startSec - truthAt(from + i)));
    expect(Math.max(...errors)).toBeLessThan(0.3);
  }, 60_000);

  it("chroma DTW: lands exactly on the anchor and stays monotonic", async () => {
    const at = truthAt(BAR) + OFFSET;
    const d = await alignChromaDtw(infoMap, audio, { anchors: markerAnchors(infoMap, [marker(BAR, at)]) });
    expect(d.sync.auto[BAR - 1].startSec).toBeCloseTo(Math.round(at * 1000) / 1000, 3);
    for (let k = 1; k < d.sync.auto.length; k++) expect(d.sync.auto[k].startSec).toBeGreaterThan(d.sync.auto[k - 1].startSec);
  }, 60_000);
});
