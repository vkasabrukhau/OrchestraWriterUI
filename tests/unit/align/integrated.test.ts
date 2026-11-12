import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it, vi } from "vitest";
import type { InfoMap } from "@/shared/info-map";
import { parseMusicXml } from "@/shared/score";
import { CONFIDENCE_BANDS, type AlignAudio } from "@/shared/sync";
import { alignIntegrated, integratedAligner, protectedIntervals, type IntegratedDetail } from "@/lib/align/integrated";
import { subsequenceDtw } from "@/lib/align/integrated/coarse";
import { directObjective, optimizeTimesDirect, scoreClock, solvePentadiagonal } from "@/lib/align/integrated/optimize";
import { quantizeChroma } from "@/lib/align/integrated/features";
import { runAlignment } from "@/lib/align/select";
import { renderDemoRecording, type DemoTruth } from "../../../scripts/lib/demo-audio";

/**
 * "Integrated tempo from original search" (ADR 0014) on the warped demo
 * recording, plus ports of the reference's focused tests (guide Appendix C).
 */

const fixtures = fileURLToPath(new URL("../../../fixtures/", import.meta.url));
const GP_MEASURE = 40; // every part rests

let infoMap: InfoMap;
let audio: AlignAudio;
let truth: DemoTruth;
let detail: IntegratedDetail;
let errors: number[];

beforeAll(async () => {
  const parsed = parseMusicXml({ bytes: new Uint8Array(readFileSync(fixtures + "scores/orchestra-demo.musicxml")), filename: "orchestra-demo.musicxml" });
  if (!parsed.ok) throw new Error(parsed.error);
  infoMap = parsed.infoMap;
  const rec = renderDemoRecording(infoMap);
  truth = rec.truth;
  audio = { samples: rec.samples, sampleRate: rec.sampleRate, durationSec: rec.samples.length / rec.sampleRate };
  detail = await alignIntegrated(infoMap, audio);
  errors = detail.sync.auto.map((a, i) => Math.abs(a.startSec - truth.measures[i].recordingStartSec));
}, 60_000);

describe("integrated aligner on the warped demo recording", () => {
  it("recovers measure starts: ≥ 95% within ±150 ms, all within ±300 ms, mean under 40 ms", () => {
    expect(errors.filter((e) => e <= 0.15).length / errors.length).toBeGreaterThanOrEqual(0.95);
    expect(Math.max(...errors)).toBeLessThanOrEqual(0.3);
    expect(errors.reduce((s, e) => s + e, 0) / errors.length).toBeLessThan(0.04);
  });

  it("improves on the broad 2 Hz match and accepts the joint fit", () => {
    const d = detail.sync.diagnostics!;
    expect(d.accepted).toBe(true);
    expect(d.converged).toBe(true);
    expect(d.acousticAfter).toBeLessThan(d.acousticBefore);
    expect(d.maxShiftSec).toBeLessThanOrEqual(4);
    expect(detail.fit.stages.map((s) => s.costScaleSec)).toEqual([0.1, 0.04]);
  });

  it("returns a SyncState: method, one entry per measure, no manual markers, average confidence", () => {
    const sync = detail.sync;
    expect(sync.method).toBe("integrated-tempo");
    expect(sync.manual).toEqual([]);
    expect(sync.auto.map((a) => a.n)).toEqual(infoMap.measures.map((m) => m.number));
    expect(sync.averageConfidence).toBe(Math.round(sync.auto.reduce((s, a) => s + a.confidence, 0) / sync.auto.length));
    for (const a of sync.auto) {
      expect(Number.isInteger(a.confidence)).toBe(true);
      expect(a.confidence).toBeGreaterThanOrEqual(0);
      expect(a.confidence).toBeLessThanOrEqual(100);
    }
  });

  it("is strictly monotonic (≥ 10 ms apart) and inside the recording", () => {
    const starts = detail.sync.auto.map((a) => a.startSec);
    for (let k = 1; k < starts.length; k++) expect(starts[k] - starts[k - 1]).toBeGreaterThanOrEqual(0.01 - 1e-9);
    expect(starts[0]).toBeGreaterThanOrEqual(0);
    expect(starts[starts.length - 1]).toBeLessThanOrEqual(audio.durationSec);
  });

  it("protects the general pause and knots it at both edges", () => {
    // written bar 32 (playback 40) is the only ensemble gap in the demo; 112 bpm, 4/4
    expect(detail.protectedQuarters).toHaveLength(1);
    const [a, b] = detail.protectedQuarters[0];
    expect(a).toBeCloseTo(156, 4);
    expect(b).toBeCloseTo(160, 4);
    const knotQuarters = Array.from(detail.fit.knots, (s) => detail.clock.toQuarter(s));
    for (let k = 1; k < knotQuarters.length; k++) expect(knotQuarters[k] - knotQuarters[k - 1]).toBeGreaterThan(1e-4);
  });

  it("reports the general-pause bar as uncertain", () => {
    const conf = detail.sync.auto.map((a) => a.confidence);
    expect(conf[GP_MEASURE - 1]).toBeLessThan(CONFIDENCE_BANDS.find((b) => b.id === "mid")!.min);
  });

  it("integratedAligner.align returns the same SyncState and reports ordered progress", async () => {
    const seen: Array<[number, string]> = [];
    const sync = await integratedAligner.align(infoMap, audio, (p, m) => seen.push([p, m]));
    expect(sync).toEqual(detail.sync);
    for (let k = 1; k < seen.length; k++) expect(seen[k][0]).toBeGreaterThanOrEqual(seen[k - 1][0]);
    expect(seen[0][0]).toBe(0);
    expect(seen[seen.length - 1][0]).toBe(1);
    expect(new Set(seen.map(([, m]) => m))).toContain("Finding the score in the recording");
  }, 60_000);

  it("rejects with AbortError when aborted during the run", async () => {
    const mid = new AbortController();
    const onProgress = (_p: number, message: string) => {
      if (message === "Finding the score in the recording") mid.abort();
    };
    await expect(integratedAligner.align(infoMap, audio, onProgress, mid.signal)).rejects.toMatchObject({ name: "AbortError" });
  }, 60_000);

  it("refuses silent and too-short recordings with a clear error", async () => {
    await expect(integratedAligner.align(infoMap, { samples: new Float32Array(22050 * 3), sampleRate: 22050, durationSec: 3 })).rejects.toThrow(/silent/);
    await expect(integratedAligner.align(infoMap, { samples: audio.samples.slice(0, 22050), sampleRate: 22050, durationSec: 1 })).rejects.toThrow(/2 seconds/);
  });

  it("runAlignment falls back to chroma DTW when the integrated aligner cannot run", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const short: AlignAudio = { samples: audio.samples.slice(0, 33075), sampleRate: 22050, durationSec: 1.5 };
      const sync = await runAlignment(infoMap, short);
      expect(sync.method).toBe("chroma-dtw");
      expect(warn).toHaveBeenCalledWith("[align] integrated aligner failed, falling back to chroma DTW:", expect.stringMatching(/2 seconds/));
    } finally {
      warn.mockRestore();
    }
  });
});

describe("integrated aligner building blocks (reference tests, guide Appendix C)", () => {
  it("uniform mismatch is not discounted by compressing score time", () => {
    const cost = new Float32Array(101 * 250).fill(0.2);
    expect(subsequenceDtw(cost, 101, 250, 1).cost).toBeCloseTo(0.2, 6);
  });

  it("a worse, later, compressed passage cannot beat a better earlier match", () => {
    const n = 101;
    const m = 260;
    const cost = new Float32Array(n * m).fill(10);
    for (let i = 0; i < n; i++) cost[i * m + 10 + i] = 0.2;
    for (let i = 0; i < n; i += 2) cost[i * m + 180 + i / 2] = 0.24;
    const result = subsequenceDtw(cost, n, m, 1);
    expect(result.startCol).toBe(10);
    expect(result.endCol).toBe(110);
    expect(result.cost).toBeCloseTo(0.2, 6);
  });

  it("the direct objective's gradient matches finite differences", () => {
    let seed = 92;
    const rand = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
    const input = {
      sampleTimes: Float64Array.from([0.1, 0.4, 1.2, 1.7, 2.3, 2.8, 3.5]),
      origins: new Float64Array(7),
      costs: Float32Array.from({ length: 7 * 40 }, rand),
      width: 40,
      step: 0.2,
      knots: Float64Array.from([0, 1, 2, 3, 4]),
      initial: Float64Array.from([0, 1, 2, 3, 4]),
      nominal: Float64Array.from([1, 1, 1, 1]),
      weights: Float64Array.from([1, 0.25, 1]),
      spacings: Float64Array.from([0.8, 1, 1.2]),
      regularization: 0.25,
    };
    const x = Float64Array.from([0.23, 1.11, 2.37, 3.41, 4.53]);
    const { grad } = directObjective(x, input);
    for (let k = 0; k < x.length; k++) {
      const h = 1e-6;
      const up = Float64Array.from(x);
      const down = Float64Array.from(x);
      up[k] += h;
      down[k] -= h;
      const numeric = (directObjective(up, input).sumSq - directObjective(down, input).sumSq) / (4 * h); // d(½Σr²)
      expect(grad[k]).toBeCloseTo(numeric, 4);
    }
  });

  it("the direct optimizer reaches the correct audio, not the seed", () => {
    const score = Float64Array.from({ length: 201 }, (_, i) => i * 0.05);
    const audioT = Float64Array.from({ length: 560 }, (_, j) => j * 0.025);
    const costs = new Float32Array(score.length * audioT.length);
    for (let i = 0; i < score.length; i++) for (let j = 0; j < audioT.length; j++) costs[i * audioT.length + j] = (audioT[j] - (score[i] + 1.2)) ** 2;
    const knots = Float64Array.from({ length: 11 }, (_, k) => k);
    const result = optimizeTimesDirect({
      sampleTimes: score,
      origins: new Float64Array(score.length),
      costs,
      width: audioT.length,
      step: 0.025,
      knots,
      initial: knots.map((k) => k + 0.3),
      nominal: new Float64Array(10).fill(1),
    });
    expect(result.accepted).toBe(true);
    expect(result.converged).toBe(true);
    for (let k = 0; k < knots.length; k++) expect(Math.abs(result.times[k] - (knots[k] + 1.2))).toBeLessThan(0.03);
  });

  it("the tempo continuity integral is stable when the knot mesh is refined", () => {
    const penalties = [40, 80, 160].map((count) => {
      const q = Float64Array.from({ length: count + 1 }, (_, i) => (10 * i) / count);
      const h = Float64Array.from({ length: count }, (_, i) => q[i + 1] - q[i]);
      const times = new Float64Array(count + 1);
      for (let i = 0; i < count; i++) times[i + 1] = times[i] + h[i] * Math.exp((0.1 * (q[i] + q[i + 1])) / 2);
      const input = {
        sampleTimes: Float64Array.from([0]),
        origins: new Float64Array(1),
        costs: new Float32Array(2000).fill(1),
        width: 2000,
        step: 0.02,
        knots: q,
        initial: times,
        nominal: h,
        weights: new Float64Array(count - 1).fill(1),
        spacings: Float64Array.from({ length: count - 1 }, (_, t) => (h[t] + h[t + 1]) / 2),
        regularization: 0.25,
      };
      return directObjective(times, input).sumSq - 1; // minus the constant acoustic residual
    });
    for (const p of penalties) expect(p).toBeCloseTo(0.0025, 9);
  });

  it("solves pentadiagonal systems exactly", () => {
    const n = 6;
    const a0 = Float64Array.from([6, 7, 8, 7, 6, 9]);
    const a1 = Float64Array.from([1, -2, 0.5, 1, 2, 0]);
    const a2 = Float64Array.from([0.5, 1, -1, 0.3, 0, 0]);
    const x = Float64Array.from([1, -2, 3, 0.5, -1, 2]);
    const b = new Float64Array(n);
    for (let i = 0; i < n; i++) {
      b[i] += a0[i] * x[i];
      if (i + 1 < n) {
        b[i] += a1[i] * x[i + 1];
        b[i + 1] += a1[i] * x[i];
      }
      if (i + 2 < n) {
        b[i] += a2[i] * x[i + 2];
        b[i + 2] += a2[i] * x[i];
      }
    }
    const solved = solvePentadiagonal(a0, a1, a2, b);
    for (let i = 0; i < n; i++) expect(solved[i]).toBeCloseTo(x[i], 10);
  });

  it("quantizes chroma like Sync Toolbox, with silence as the uniform vector", () => {
    const raw = Float32Array.from([...[0.5, 0.25, 0.15, 0.06, 0.04, 0, 0, 0, 0, 0, 0, 0], ...new Array(12).fill(0)]);
    quantizeChroma(raw, 2);
    expect(Array.from(raw.slice(0, 12))).toEqual([1, 0.75, 0.5, 0.25, 0, 0, 0, 0, 0, 0, 0, 0]);
    expect(Array.from(raw.slice(12))).toEqual(new Array(12).fill(0.25));
  });

  it("finds ensemble gaps and fermatas in quarter positions", () => {
    const clock = scoreClock([{ time: 0, bpm: 60 }], 60);
    const map = {
      ...infoMap,
      instruments: [{ ...infoMap.instruments[0], notes: [{ time: 1, duration: 1, pitch: 60, dynamics: "p" as const, styleMarking: null, measure: 1 }, { time: 3, duration: 1, pitch: 62, dynamics: "p" as const, styleMarking: null, measure: 1 }] }],
      timing: { tempo: [{ time: 0, bpm: 60 }], fermatas: [{ start: 3, end: 4 }] },
    };
    expect(protectedIntervals(map, clock)).toEqual([
      [0, 1],
      [2, 3],
      [3, 4],
    ]);
  });
});
