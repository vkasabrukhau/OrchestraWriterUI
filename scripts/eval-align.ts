/**
 * Compare the aligners on the demo fixture against its known tempo warp.
 *
 *   npx tsx scripts/eval-align.ts            synthesized PCM scenarios
 *   npx tsx scripts/eval-align.ts --mp3      also the committed MP3 (needs ffmpeg on PATH)
 *
 * Prints per-scenario accuracy (measure starts within ±150 / ±300 ms of the
 * truth), max / mean error, run time and the confidence spread. Numbers
 * feed docs/decisions/0014-integrated-alignment.md.
 */
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { parseMusicXml } from "../src/shared/score";
import type { AlignAudio, SyncState } from "../src/shared/sync";
import { alignChromaDtw } from "../src/lib/align";
import { alignIntegrated } from "../src/lib/align/integrated";
import {
  makeTempoWarp,
  renderInfoMapAudio,
} from "../src/lib/score/synth-notes";
import { renderDemoRecording } from "./lib/demo-audio";

const parsed = parseMusicXml({
  bytes: new Uint8Array(
    readFileSync("fixtures/scores/orchestra-demo.musicxml"),
  ),
  filename: "orchestra-demo.musicxml",
});
if (!parsed.ok) throw new Error(parsed.error);
const infoMap = parsed.infoMap;

interface Scenario {
  name: string;
  audio: AlignAudio;
  truth: number[];
}

function scenario(
  name: string,
  samples: Float32Array,
  sampleRate: number,
  truth: number[],
): Scenario {
  return {
    name,
    audio: { samples, sampleRate, durationSec: samples.length / sampleRate },
    truth,
  };
}

const demo = renderDemoRecording(infoMap);
const demoTruth = demo.truth.measures.map((m) => m.recordingStartSec);
const scenarios: Scenario[] = [
  scenario("Synthesized, demo warp", demo.samples, demo.sampleRate, demoTruth),
];

// smooth rubato ±8 % and 30 % slower, rendered with the same synth
for (const [name, spec] of [
  [
    "Smooth rubato ±8 %",
    {
      leadingSilenceSec: 1.2,
      splitScoreSec: infoMap.duration / 3,
      firstTempoFactor: 1.08,
      secondTempoFactor: 0.92,
    },
  ],
  [
    "Played 30 % slower",
    {
      leadingSilenceSec: 2,
      splitScoreSec: infoMap.duration / 2,
      firstTempoFactor: 0.77,
      secondTempoFactor: 0.77,
    },
  ],
] as const) {
  const warp = makeTempoWarp(spec);
  const samples = renderInfoMapAudio(infoMap, {
    sampleRate: 22050,
    warp,
    tailSec: 1.5,
  });
  scenarios.push(
    scenario(
      name,
      samples,
      22050,
      infoMap.measures.map((m) => warp(m.startTime)),
    ),
  );
}

if (process.argv.includes("--mp3")) {
  const pcm = execFileSync(
    "ffmpeg",
    [
      "-v",
      "error",
      "-i",
      "fixtures/audio/orchestra-demo.mp3",
      "-f",
      "f32le",
      "-ac",
      "1",
      "-ar",
      "22050",
      "-",
    ],
    { maxBuffer: 1 << 28 },
  );
  const samples = new Float32Array(
    pcm.buffer,
    pcm.byteOffset,
    pcm.byteLength / 4,
  ).slice();
  scenarios.push(scenario("Committed MP3, decoded", samples, 22050, demoTruth));
}

function report(name: string, sync: SyncState, truth: number[], ms: number) {
  const err = sync.auto.map((a, i) => Math.abs(a.startSec - truth[i]));
  const w150 = err.filter((e) => e <= 0.15).length;
  const w300 = err.filter((e) => e <= 0.3).length;
  const conf = sync.auto.map((a) => a.confidence);
  const below90 = conf.filter((c) => c < 90).length;
  console.log(
    `  ${name.padEnd(16)} ±150 ms ${w150}/${err.length}  ±300 ms ${w300}/${err.length}  max ${(Math.max(...err) * 1000).toFixed(0)} ms  mean ${((err.reduce((s, e) => s + e, 0) / err.length) * 1000).toFixed(0)} ms  ${ms.toFixed(0)} ms  avg conf ${sync.averageConfidence}  <90: ${below90}`,
  );
}

async function main() {
  for (const s of scenarios) {
    console.log(s.name);
    let t = performance.now();
    const chroma = await alignChromaDtw(infoMap, s.audio);
    report("chroma-dtw", chroma.sync, s.truth, performance.now() - t);
    t = performance.now();
    const integrated = await alignIntegrated(infoMap, s.audio);
    report("integrated-tempo", integrated.sync, s.truth, performance.now() - t);
    console.log("   ", JSON.stringify(integrated.sync.diagnostics));
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
