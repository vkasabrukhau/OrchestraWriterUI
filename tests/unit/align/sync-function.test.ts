import { beforeEach, describe, expect, it, vi } from "vitest";
import type { InfoMap } from "@/shared/info-map";
import type { ManualMarker, MeasureAlignment, SyncState } from "@/shared/sync";

/** runSync keeps a marker run's changes where the changed markers reach (ADR 0024). */

const alignInWorker = vi.fn();
vi.mock("@/lib/align/worker-client", () => ({ alignInWorker: (...args: unknown[]) => alignInWorker(...args) }));

const { runSync } = await import("@/lib/align/sync-function");

const infoMap = {
  instruments: [],
  measures: Array.from({ length: 8 }, (_, i) => ({ number: i + 1, startTime: i * 2, duration: 2 })),
  duration: 16,
  tempo: 120,
  timeSignature: "4/4",
  warnings: [],
} as InfoMap;
const recording = { numberOfChannels: 1, length: 22050 * 20, sampleRate: 22050, getChannelData: () => new Float32Array(22050 * 20) };
const bars = (times: number[], confidence = 80): MeasureAlignment[] => times.map((startSec, i) => ({ n: i + 1, startSec, confidence }));
const marker = (measure: number, startSec: number): ManualMarker => ({ id: `m${measure}`, measure, startSec, createdAt: "", basis: "time" } as ManualMarker);

const previous = bars([0, 2, 4, 6, 8, 10, 12, 14]);
// the new run moves bars 3–4 (around the marker on bar 3) and, unsupported, bar 7
const fresh: SyncState = { method: "integrated-tempo", auto: bars([0, 2, 4.5, 6.4, 8, 10, 12.6, 14], 90), manual: [], averageConfidence: 90 };

describe("runSync with markers", () => {
  beforeEach(() => {
    alignInWorker.mockReset();
    alignInWorker.mockResolvedValue(fresh);
  });

  const run = (previousMarkers: ManualMarker[] | undefined, previousMethod: string | undefined) =>
    runSync({ infoMap, recording, auto: previous, range: null, style: "smooth", markers: [marker(3, 4.5)], previousMarkers, previousMethod });

  it("passes the markers to the aligner as anchors", async () => {
    await run([], "integrated-tempo");
    expect(alignInWorker.mock.calls[0][4].anchors).toEqual([{ scoreSec: 4, sec: 4.5 }]);
  });

  it("keeps the previous timing outside the stretch a new marker reaches", async () => {
    const out = await run([], "integrated-tempo");
    expect(out.auto.map((a) => a.startSec)).toEqual([0, 2, 4.5, 6.4, 8, 10, 12, 14]);
    expect(out.auto[6].confidence).toBe(80);
    expect(out.averageConfidence).toBe(Math.round(out.auto.reduce((s, a) => s + a.confidence, 0) / 8));
  });

  it("takes the whole new run when the markers did not change or the method did", async () => {
    expect((await run([marker(3, 4.5)], "integrated-tempo")).auto).toEqual(fresh.auto);
    expect((await run([], "redline")).auto).toEqual(fresh.auto);
    expect((await run(undefined, undefined)).auto).toEqual(fresh.auto);
  });
});
