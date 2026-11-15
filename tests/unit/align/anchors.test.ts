import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";
import type { InfoMap } from "@/shared/info-map";
import { parseMusicXml } from "@/shared/score";
import { mergeAlignment, type AlignAudio, type ManualMarker } from "@/shared/sync";
import { anchorColumnBounds, anchorMapping, changedMarkerBars, cleanAnchors, localizeMarkerRun, markerAnchors, shiftAnchors } from "@/lib/align/anchors";
import { bandedDtw, subsequenceDtw } from "@/lib/align/integrated/coarse";
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

  it("re-times a mapping through the anchors, proportionally between them, fading out outside", () => {
    const m = anchorMapping({ score: [0, 10, 20, 60], recording: [0, 10, 20, 60] }, [
      { scoreSec: 5, sec: 7 },
      { scoreSec: 15, sec: 16 },
    ]);
    const at = (s: number) => m.recording[m.score.indexOf(s)];
    expect(at(5)).toBe(7);
    expect(at(15)).toBe(16);
    // 5 s outside an anchor: 5/6 of its correction (it fades over ANCHOR_TAPER_SEC = 30 s)
    expect(at(0)).toBeCloseTo(2 * (25 / 30));
    expect(at(10)).toBeCloseTo(11.5);
    expect(at(20)).toBeCloseTo(20 + 25 / 30);
    // far from every anchor the mapping is untouched
    expect(at(60)).toBeCloseTo(60);
    for (let k = 1; k < m.recording.length; k++) expect(m.recording[k]).toBeGreaterThan(m.recording[k - 1]);
  });
});

describe("marker runs stay where the markers reach (ADR 0024)", () => {
  const bars = (times: number[]) => times.map((startSec, i) => ({ n: i + 1, startSec, confidence: 80 }));

  it("takes the new timing across the stretch connected to a changed marker, plus one bar", () => {
    const prev = bars([0, 2, 4, 6, 8, 10, 12, 14, 16, 18]);
    // marker on bar 4: bars 3–5 moved; bar 9 also moved, unconnected to it
    const next = bars([0, 2, 4.4, 6.5, 8.3, 10, 12, 14, 16.4, 18]).map((a, i) => ({ ...a, confidence: i === 3 ? 100 : 60 }));
    const out = localizeMarkerRun(prev, next, [4]);
    expect(out.map((a) => a.startSec)).toEqual([0, 2, 4.4, 6.5, 8.3, 10, 12, 14, 16, 18]);
    expect(out[3].confidence).toBe(100);
    expect(out[8].confidence).toBe(80);
  });

  it("re-times as far as the departure runs (the whole piece if it does)", () => {
    const prev = bars([0, 2, 4, 6, 8, 10]);
    const next = bars([1, 3, 5, 7, 9, 11]);
    expect(localizeMarkerRun(prev, next, [6]).map((a) => a.startSec)).toEqual([1, 3, 5, 7, 9, 11]);
  });

  it("keeps the seams in order and returns the new run when there is nothing to compare", () => {
    const prev = bars([0, 2, 4, 6]);
    const next = bars([0, 2, 1.95, 6]);
    const out = localizeMarkerRun(prev, next, [3]);
    for (let i = 1; i < out.length; i++) expect(out[i].startSec).toBeGreaterThan(out[i - 1].startSec);
    expect(localizeMarkerRun([], next, [3])).toBe(next);
    expect(localizeMarkerRun(prev, next, [])).toBe(next);
  });

  it("lists bars of markers added, moved or removed", () => {
    const before = [marker(3, 5), marker(8, 20)];
    const after = [marker(3, 5), marker(8, 20.4), marker(12, 30)];
    expect(changedMarkerBars(before, after)).toEqual([8, 12]);
    expect(changedMarkerBars(after, [marker(3, 5)])).toEqual([8, 12]);
    expect(changedMarkerBars(before, before)).toEqual([]);
  });
});

describe("DTW jumps (recording material the score lacks, score the recording skips)", () => {
  // diagonal of cheap cells with a 12-column detour (a passage played twice) after row 10
  const n = 30;
  const m = 60;
  const costWithDetour = () => {
    const c = new Float32Array(n * m).fill(0.6);
    for (let i = 0; i < n; i++) c[i * m + (i < 10 ? i + 5 : i + 17)] = 0.05;
    return c;
  };

  it("never jumps on an ordinary diagonal", () => {
    const c = new Float32Array(n * m).fill(0.6);
    for (let i = 0; i < n; i++) c[i * m + i + 5] = 0.05;
    const plain = subsequenceDtw(c, n, m, 1);
    const withJumps = subsequenceDtw(c, n, m, 1, undefined, 8);
    expect(Array.from(withJumps.cols)).toEqual(Array.from(plain.cols));
  });

  it("jumps over recording material in one step instead of warping the music around it", () => {
    const match = subsequenceDtw(costWithDetour(), n, m, 1, undefined, 2);
    const at = (row: number) => match.cols[match.rows.lastIndexOf(row)];
    expect(at(9)).toBe(14);
    expect(at(10)).toBe(27);
    expect(at(20)).toBe(37);
  });

  it("a band through anchors on both sides of the detour has a path only with jumps", () => {
    const c = costWithDetour();
    const lo = new Int32Array(n);
    const hi = new Int32Array(n);
    // anchors at rows 9 and 10 two steps of 13 columns apart: no 2× step covers that
    for (let i = 0; i < n; i++) {
      const center = i < 10 ? i + 5 : i + 17;
      lo[i] = Math.max(0, center - 2);
      hi[i] = Math.min(m - 1, center + 2);
    }
    expect(() => bandedDtw((i, j) => c[i * m + j], n, lo, hi)).toThrow();
    const path = bandedDtw((i, j) => c[i * m + j], n, lo, hi, 2);
    expect(path.jumps).toBe(1);
    expect(path.cols[path.rows.lastIndexOf(10)]).toBe(27);
  });

  it("skips score rows the recording leaves out, paying for each skipped row", () => {
    // rows 10–19 are missing from the recording
    const c = new Float32Array(n * m).fill(0.6);
    for (let i = 0; i < n; i++) if (i < 10 || i >= 20) c[i * m + (i < 10 ? i + 5 : i - 5)] = 0.05;
    const free = subsequenceDtw(c, n, m, 1, undefined, 0.5);
    const at = (row: number) => free.cols[free.rows.indexOf(row)];
    expect(at(9)).toBe(14);
    expect(at(20)).toBe(15);
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

  it("integrated: markers around a passage the recording plays twice re-time the music after it (needs a DTW jump)", async () => {
    // 10 s of the recording repeated at bar 30's start: everything after it is 10 s later
    const sr = audio.sampleRate;
    const cut = Math.round(truthAt(30) * sr);
    const extra = Math.round(10 * sr);
    const samples = new Float32Array(audio.samples.length + extra);
    samples.set(audio.samples.subarray(0, cut), 0);
    samples.set(audio.samples.subarray(cut - extra, cut), cut);
    samples.set(audio.samples.subarray(cut), cut + extra);
    const spliced: AlignAudio = { samples, sampleRate: sr, durationSec: samples.length / sr };
    const after = (bar: number) => truthAt(bar) + 10;
    const markers = [marker(29, truthAt(29)), marker(30, after(30))];
    const d = await alignIntegrated(infoMap, spliced, { anchors: markerAnchors(infoMap, markers) });
    const start = (bar: number) => d.sync.auto[bar - 1].startSec;
    expect(start(29)).toBeCloseTo(truthAt(29), 2);
    expect(start(30)).toBeCloseTo(after(30), 2);
    // bar 40 follows the general pause, the aligner's known weak spot (about 0.2 s with or without markers; ADR 0014)
    for (let bar = 31; bar <= 45; bar++) if (bar !== 40) expect(Math.abs(start(bar) - after(bar))).toBeLessThan(0.15);
    for (let bar = 2; bar <= 28; bar++) expect(Math.abs(start(bar) - truthAt(bar))).toBeLessThan(0.15);
  }, 60_000);

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
