import { describe, expect, it } from "vitest";
import {
  PITCH_COUNT,
  PITCH_MIN,
  decimate5,
  designPitchFilterbank,
  estimateTuningCents,
  pitchFeatures,
  quantizeChroma,
  syncToolboxChroma,
} from "@/lib/align/integrated/filterbank";

const SR = 22050;

function tone(freq: number, seconds: number, amp = 0.3): Float32Array {
  const x = new Float32Array(Math.round(seconds * SR));
  for (let i = 0; i < x.length; i++) x[i] = amp * Math.sin((2 * Math.PI * freq * i) / SR);
  return x;
}

/** scipy reference values: synctoolbox generate_filterbank(cents)[pitch], first and last sos row */
const SCIPY_SOS: Array<{ cents: number; pitch: number; sections: number; first: number[]; last: number[] }> = [
  {
    cents: 0,
    pitch: 69,
    sections: 4,
    first: [0.003137275111264314, -0.004848970074004076, 0.003137275111264314, 1.0, -1.6060527087907364, 0.9911224448971978],
    last: [1.0, -1.648825239878478, 1.0000000000000002, 1.0, -1.6317420281405663, 0.9970596778140248],
  },
  {
    cents: 7,
    pitch: 94,
    sections: 5,
    first: [0.000970586726230836, 0.0, -0.000970586726230836, 1.0, 1.7494051220902291, 0.9635263730536934],
    last: [1.0, 1.8424717510600823, 1.0, 1.0, 1.8199342146225128, 0.9940408231358384],
  },
  {
    cents: -13,
    pitch: 30,
    sections: 4,
    first: [0.0031461456923885574, -0.005891573468089499, 0.0031461456923885583, 1.0, -1.8877704309869976, 0.9953553825246734],
    last: [1.0, -1.902305503981325, 1.0000000000000002, 1.0, -1.896682493965567, 0.9984680979466726],
  },
  {
    cents: 49,
    pitch: 100,
    sections: 4,
    first: [0.0031349804783383384, -0.0041497466819971915, 0.003134980478338338, 1.0, -1.4143329859178413, 0.9890717077234297],
    last: [1.0, -1.4744886178698788, 1.0, 1.0, -1.450213084637772, 0.9963705313895136],
  },
];

describe("Sync Toolbox filterbank port", () => {
  it("designs the same elliptic sections as scipy", () => {
    for (const ref of SCIPY_SOS) {
      const sos = designPitchFilterbank(ref.cents).get(ref.pitch)!;
      expect(sos.length / 6).toBe(ref.sections);
      const rows = [Array.from(sos.subarray(0, 6)), Array.from(sos.subarray(sos.length - 6))];
      [ref.first, ref.last].forEach((want, r) =>
        want.forEach((v, j) => expect(Math.abs(rows[r][j] - v)).toBeLessThanOrEqual(1e-9 * Math.max(1, Math.abs(v)))),
      );
    }
  });

  it("decimates by 5 with ceil(n / 5) samples and keeps a low tone", () => {
    const x = tone(100, 1);
    const y = decimate5(x);
    expect(y.length).toBe(Math.ceil(x.length / 5));
    // sample j of the output sits at input sample 5j
    for (const j of [500, 1000, 2000]) expect(y[j]).toBeCloseTo(x[5 * j], 3);
  });

  it("puts a pure A4 in pitch 69 and pitch class 9", () => {
    const f = pitchFeatures(tone(440, 2), 0);
    expect(f.n).toBe(1 + Math.ceil((2 * SR) / 441));
    const k = 50; // one second in
    let best = 0;
    for (let i = 1; i < PITCH_COUNT; i++) if (f.pitch[k * PITCH_COUNT + i] > f.pitch[k * PITCH_COUNT + best]) best = i;
    expect(best + PITCH_MIN).toBe(69);
    const { chroma } = syncToolboxChroma(tone(440, 2), 0);
    expect(chroma[k * 12 + 9]).toBe(1);
    expect(Array.from(chroma.subarray(k * 12, k * 12 + 12)).filter((v) => v > 0)).toHaveLength(1);
  });

  it("estimates the tuning of a 7-cent-sharp tone", () => {
    expect(estimateTuningCents(tone(440 * 2 ** (7 / 1200), 3), SR)).toBe(7);
    expect(estimateTuningCents(tone(440, 3), SR)).toBe(0);
  });

  it("leaves silent frames all zero (not uniform)", () => {
    const { n, chroma } = syncToolboxChroma(new Float32Array(SR), 0);
    expect(n).toBe(1 + Math.ceil(SR / 441));
    expect(chroma.every((v) => v === 0)).toBe(true);
  });

  it("quantizes like quantize_chroma", () => {
    const raw = new Float64Array(24);
    raw.set([0.5, 0.25, 0.15, 0.06, 0.04, 0, 0, 0, 0, 0, 0, 0]);
    raw.set([0.0005, 0.0005, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0], 12); // nothing above 0.001
    const q = quantizeChroma(raw, 2);
    expect(Array.from(q.subarray(0, 5))).toEqual([1, 0.75, 0.5, 0.25, 0]);
    expect(Array.from(q.subarray(12)).every((v) => v === 0)).toBe(true);
  });
});
