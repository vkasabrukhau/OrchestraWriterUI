/**
 * Run an aligner on a real score + recording and compare its measure starts
 * with a reference table (for example the Python "Integrated tempo from
 * original search" output, measures.csv) or with hand-marked timings.
 *
 *   npx tsx scripts/eval-real.ts SCORE.mxl RECORDING.mp3 [--ref measures.csv]
 *        [--method integrated-tempo|redline|chroma-dtw] [--out result.json]
 *        [--markers "bar:sec,bar:sec"]
 *
 * The reference CSV needs a measure column (`measure`) and a recording
 * column (`recording_sec` or `start`). Needs ffmpeg on PATH to decode.
 */
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { basename } from "node:path";
import { parseMusicXml } from "../src/shared/score";
import type { AlignAudio, SyncState } from "../src/shared/sync";
import { runAlignment, type AlignMethod } from "../src/lib/align/select";
import type { AlignAnchor } from "../src/lib/align/anchors";

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

export function decode(path: string, rate = 22050): AlignAudio {
  const pcm = execFileSync("ffmpeg", ["-v", "error", "-i", path, "-f", "f32le", "-ac", "1", "-ar", String(rate), "-"], { maxBuffer: 2 ** 31 - 1 });
  const samples = new Float32Array(pcm.buffer, pcm.byteOffset, pcm.byteLength / 4).slice();
  return { samples, sampleRate: rate, durationSec: samples.length / rate };
}

export function readReference(path: string): Map<number, number> {
  const [head, ...rows] = readFileSync(path, "utf8").trim().split(/\r?\n/);
  const cols = head.split(",");
  const mi = cols.indexOf("measure");
  const ri = ["recording_sec", "start", "recording_start"].map((c) => cols.indexOf(c)).find((i) => i >= 0) ?? -1;
  if (mi < 0 || ri < 0) throw new Error(`reference needs measure and recording_sec columns, got ${head}`);
  const out = new Map<number, number>();
  for (const r of rows) {
    const c = r.split(",");
    const v = Number(c[ri]);
    if (Number.isFinite(v)) out.set(Number(c[mi]), v);
  }
  return out;
}

export function compare(sync: SyncState, ref: Map<number, number>) {
  const errs: Array<{ measure: number; err: number }> = [];
  for (const a of sync.auto) {
    const r = ref.get(a.n);
    if (r != null) errs.push({ measure: a.n, err: a.startSec - r });
  }
  const abs = errs.map((e) => Math.abs(e.err));
  const within = (t: number) => abs.filter((e) => e <= t).length;
  const sorted = [...abs].sort((a, b) => a - b);
  return {
    n: errs.length,
    w50: within(0.05),
    w100: within(0.1),
    w150: within(0.15),
    w300: within(0.3),
    w1000: within(1),
    meanMs: Math.round((abs.reduce((s, e) => s + e, 0) / Math.max(1, abs.length)) * 1000),
    medianMs: Math.round((sorted[Math.floor(sorted.length / 2)] ?? 0) * 1000),
    maxMs: Math.round((sorted[sorted.length - 1] ?? 0) * 1000),
    worst: [...errs].sort((a, b) => Math.abs(b.err) - Math.abs(a.err)).slice(0, 12).map((e) => `${e.measure}:${Math.round(e.err * 1000)}`),
  };
}

async function main() {
  const [scorePath, audioPath] = process.argv.slice(2).filter((a, i, all) => !a.startsWith("--") && !(i > 0 && all[i - 1].startsWith("--")));
  if (!scorePath || !audioPath) throw new Error("usage: eval-real.ts SCORE RECORDING [--ref measures.csv] [--method m] [--out file]");
  const parsed = parseMusicXml({ bytes: new Uint8Array(readFileSync(scorePath)), filename: basename(scorePath) });
  if (!parsed.ok) throw new Error(parsed.error);
  const infoMap = parsed.infoMap;
  console.log(`score: ${infoMap.instruments.length} parts, ${infoMap.measures.length} bars, ${infoMap.duration.toFixed(1)} s`);
  let t = performance.now();
  const audio = decode(audioPath);
  console.log(`audio: ${audio.durationSec.toFixed(1)} s decoded in ${((performance.now() - t) / 1000).toFixed(1)} s`);
  const method = (arg("--method") ?? "integrated-tempo") as AlignMethod;
  const anchors: AlignAnchor[] = (arg("--markers") ?? "")
    .split(",")
    .filter(Boolean)
    .map((p) => {
      const [bar, sec] = p.split(":").map(Number);
      return { scoreSec: infoMap.measures[bar - 1].startTime, sec };
    });
  t = performance.now();
  const sync = await runAlignment(infoMap, audio, { method, noFallback: true, anchors }, undefined);
  console.log(`${method}: ${((performance.now() - t) / 1000).toFixed(1)} s`, JSON.stringify(sync.diagnostics ?? {}));
  const refPath = arg("--ref");
  if (refPath) console.log(JSON.stringify(compare(sync, readReference(refPath))));
  const out = arg("--out");
  if (out) writeFileSync(out, JSON.stringify({ method, auto: sync.auto.map((a) => [a.n, a.startSec, a.confidence]) }));
}

if (process.argv[1]?.endsWith("eval-real.ts")) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
