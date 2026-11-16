import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it, vi } from "vitest";
import type { InfoMap } from "@/shared/info-map";
import { parseMusicXml } from "@/shared/score";
import { CONFIDENCE_BANDS, type AlignAudio, type SyncState } from "@/shared/sync";
import { alignChromaDtw, chromaDtwAligner, type ChromaDtwDetail } from "@/lib/align";
import { alignInWorker } from "@/lib/align/worker-client";
import type { AlignResponse } from "@/lib/align/protocol";
import { renderDemoRecording, type DemoTruth } from "../../../scripts/lib/demo-audio";

/**
 * End-to-end: the demo score is synthesized with the same tempo warp as
 * fixtures/audio/orchestra-demo.mp3 (4% faster, then 5% slower, 1.2 s of
 * leading silence) and aligned back. Truth = the warp applied to each measure
 * start, as stored in fixtures/audio/orchestra-demo.json.
 */

const fixtures = fileURLToPath(new URL("../../../fixtures/", import.meta.url));
const GP_MEASURE = 40; // written bar 32, every part rests

let infoMap: InfoMap;
let audio: AlignAudio;
let truth: DemoTruth;
let detail: ChromaDtwDetail;
let errors: number[];

beforeAll(async () => {
  const parsed = parseMusicXml({ bytes: new Uint8Array(readFileSync(fixtures + "scores/orchestra-demo.musicxml")), filename: "orchestra-demo.musicxml" });
  if (!parsed.ok) throw new Error(parsed.error);
  infoMap = parsed.infoMap;
  const rec = renderDemoRecording(infoMap);
  truth = rec.truth;
  audio = { samples: rec.samples, sampleRate: rec.sampleRate, durationSec: rec.samples.length / rec.sampleRate };
  detail = await alignChromaDtw(infoMap, audio);
  errors = detail.sync.auto.map((a, i) => Math.abs(a.startSec - truth.measures[i].recordingStartSec));
}, 20_000);

describe("chroma-DTW aligner on the warped demo recording", () => {
  it("agrees with the committed truth file", () => {
    const committed = JSON.parse(readFileSync(fixtures + "audio/orchestra-demo.json", "utf8")) as DemoTruth;
    expect(committed).toEqual(truth);
  });

  it("recovers measure starts: ≥ 90% within ±150 ms, all within ±300 ms", () => {
    const within150 = errors.filter((e) => e <= 0.15).length / errors.length;
    expect(within150).toBeGreaterThanOrEqual(0.9);
    expect(Math.max(...errors)).toBeLessThanOrEqual(0.3);
  });

  it("returns a SyncState: method, one entry per measure, no manual markers, average confidence", () => {
    const sync = detail.sync;
    expect(sync.method).toBe("chroma-dtw");
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

  it("finds the start after the 1.2 s lead-in", () => {
    expect(detail.sync.auto[0].startSec).toBeGreaterThan(1.05);
    expect(detail.sync.auto[0].startSec).toBeLessThan(1.35);
  });

  it("reports low confidence for the bar where every part rests", () => {
    const conf = detail.sync.auto.map((a) => a.confidence);
    const gp = conf[GP_MEASURE - 1];
    const sorted = [...conf].sort((a, b) => a - b);
    const median = sorted[Math.floor(sorted.length / 2)];
    expect(gp).toBeLessThan(median);
    const uncertain = CONFIDENCE_BANDS.find((b) => b.id === "low")!;
    const check = CONFIDENCE_BANDS.find((b) => b.id === "mid")!;
    expect(gp).toBeLessThan(check.min); // shown as "Uncertain"
    expect(uncertain.min).toBe(0);
  });

  it("flags misaligned bars: when the clarinet's transposition is ignored, bars off by > 300 ms score below 90", async () => {
    const written = await alignChromaDtw(infoMap, audio, { transpose: {} });
    const off = written.sync.auto.filter((a, i) => Math.abs(a.startSec - truth.measures[i].recordingStartSec) > 0.3);
    expect(off.length).toBeGreaterThan(0); // the written-pitch clarinet solo really does mislead it
    for (const a of off) expect(a.confidence).toBeLessThan(90);
  });
});

describe("Aligner interface, progress and cancellation", () => {
  it("chromaDtwAligner.align returns the same SyncState", async () => {
    const sync = await chromaDtwAligner.align(infoMap, audio);
    expect(sync).toEqual(detail.sync);
  });

  it("reports progress through the three phases", async () => {
    const seen: Array<[number, string]> = [];
    await chromaDtwAligner.align(infoMap, audio, (p, m) => seen.push([p, m]));
    const messages = [...new Set(seen.map(([, m]) => m))];
    expect(messages).toEqual(["Computing chroma", "Warping", "Scoring confidence"]);
    for (let k = 1; k < seen.length; k++) expect(seen[k][0]).toBeGreaterThanOrEqual(seen[k - 1][0]);
    expect(seen[0][0]).toBe(0);
    expect(seen[seen.length - 1][0]).toBe(1);
  });

  it("rejects with AbortError when aborted before or during the run", async () => {
    const pre = new AbortController();
    pre.abort();
    await expect(chromaDtwAligner.align(infoMap, audio, undefined, pre.signal)).rejects.toMatchObject({ name: "AbortError" });

    const mid = new AbortController();
    const onProgress = (_p: number, message: string) => {
      if (message === "Warping") mid.abort();
    };
    await expect(chromaDtwAligner.align(infoMap, audio, onProgress, mid.signal)).rejects.toMatchObject({ name: "AbortError" });
  });

  it("refuses silent recordings and empty scores with a clear error", async () => {
    const silent: AlignAudio = { samples: new Float32Array(22050 * 3), sampleRate: 22050, durationSec: 3 };
    await expect(chromaDtwAligner.align(infoMap, silent)).rejects.toThrow(/silent/);
    await expect(chromaDtwAligner.align({ ...infoMap, measures: [], duration: 0 }, audio)).rejects.toThrow(/no measures/);
  });

  it("alignInWorker runs on the main thread when Worker is unavailable", async () => {
    expect(typeof Worker).toBe("undefined");
    const original = audio.samples;
    const sync = await alignInWorker(infoMap, audio, undefined, undefined, { method: "chroma-dtw" });
    expect(sync).toEqual(detail.sync);
    expect(audio.samples).toBe(original);
  });

  it("alignInWorker warns and falls back to the main thread when the worker fails to load", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      // the constructor throws (e.g. a CSP or bundler problem)
      vi.stubGlobal(
        "Worker",
        class {
          constructor() {
            throw new Error("blocked by CSP");
          }
        },
      );
      expect(await alignInWorker(infoMap, audio, undefined, undefined, { method: "chroma-dtw" })).toEqual(detail.sync);
      expect(warn).toHaveBeenCalledWith("[align] worker unavailable, running on the main thread:", "blocked by CSP");

      // the script 404s: onerror fires before the worker says anything
      warn.mockClear();
      vi.stubGlobal(
        "Worker",
        class {
          onmessage: unknown = null;
          onerror: ((e: { message: string; preventDefault(): void }) => void) | null = null;
          postMessage() {
            setTimeout(() => this.onerror?.({ message: "", preventDefault() {} }), 0);
          }
          terminate() {}
        },
      );
      expect(await alignInWorker(infoMap, audio, undefined, undefined, { method: "chroma-dtw" })).toEqual(detail.sync);
      expect(warn).toHaveBeenCalledWith("[align] worker unavailable, running on the main thread:", "the worker script failed to load");
    } finally {
      vi.unstubAllGlobals();
      warn.mockRestore();
    }
  });

  it("the worker entry answers an align request with progress and a result", async () => {
    const posted: AlignResponse[] = [];
    const scope = globalThis as unknown as { postMessage?: (m: AlignResponse) => void; onmessage?: ((e: { data: unknown }) => void) | null };
    const done = new Promise<SyncState>((resolve, reject) => {
      scope.postMessage = (m) => {
        posted.push(m);
        if (m.type === "result") resolve(m.result);
        if (m.type === "error") reject(new Error(m.error));
      };
    });
    vi.resetModules();
    await import("@/lib/align/worker");
    scope.onmessage!({
      data: { type: "align", infoMap, samples: audio.samples.slice(), sampleRate: audio.sampleRate, durationSec: audio.durationSec, options: { method: "chroma-dtw" } },
    });
    const result = await done;
    expect(result).toEqual(detail.sync);
    expect(posted.some((m) => m.type === "progress")).toBe(true);
    delete scope.postMessage;
    scope.onmessage = null;
  });
});
