import type { InfoMap } from "@/shared/info-map";
import { mergeAlignment, type AlignmentDiagnostics, type AlignProgress, type ManualMarker, type MeasureAlignment } from "@/shared/sync";
import { toAlignAudio, type AudioBufferLike } from "@/lib/audio/decode";
import { markerAnchors, shiftAnchors } from "./anchors";
import { CHROMA_DTW_METHOD } from "./index";
import { methodForStyle, type SyncStyle } from "./methods";
import { planRangeWindow, sliceInfoMap } from "./range";
import { alignInWorker } from "./worker-client";

/**
 * The sync function: a black box (owner, ADR 0019). It receives the markers a
 * run will apply and hands them to the aligner as fixed anchors (ADR 0021):
 * the fit passes through each one and the tempo around it is refitted. A
 * range run also uses them to narrow its audio window. Merging the applied
 * markers afterwards is then a no-op at the anchors and still keeps the
 * result monotonic.
 */
export interface SyncFunctionInput {
  infoMap: InfoMap;
  /** the decoded recording */
  recording: AudioBufferLike;
  /** the aligner's bars before this run */
  auto: MeasureAlignment[];
  /** null = the whole piece */
  range: { from: number; to: number } | null;
  style: SyncStyle;
  /** the applied set this run will produce */
  markers: ManualMarker[];
  onProgress?: AlignProgress;
  signal?: AbortSignal;
}

export interface SyncFunctionOutput {
  /** the run's bars (the range's, or all), global bar numbers and recording seconds */
  auto: MeasureAlignment[];
  /** what actually ran ("chroma-dtw" after a fallback) */
  method: string;
  fellBack: boolean;
  /** whole-piece integrated runs only */
  diagnostics?: AlignmentDiagnostics;
  averageConfidence: number;
}

export async function runSync(input: SyncFunctionInput): Promise<SyncFunctionOutput> {
  const method = methodForStyle(input.style);
  if (!method) throw new Error("That sync method is not available yet");
  const { infoMap, recording, range, onProgress, signal } = input;
  const durationSec = recording.sampleRate > 0 ? recording.length / recording.sampleRate : 0;
  const anchors = markerAnchors(infoMap, input.markers);

  if (!range || (range.from <= 1 && range.to >= infoMap.measures.length)) {
    const result = await alignInWorker(infoMap, toAlignAudio(recording), onProgress, signal, { method: method.id, anchors, transferSamples: true });
    return { auto: result.auto, method: result.method, fellBack: result.method === CHROMA_DTW_METHOD, diagnostics: result.diagnostics, averageConfidence: result.averageConfidence };
  }

  // planned from the timing this run will produce, so a moved marker's bar is inside the window
  const aligned = mergeAlignment(input.auto, input.markers);
  const win = planRangeWindow(aligned, range, durationSec, input.markers);
  const slice = sliceInfoMap(infoMap, range.from, range.to);
  const sliceStart = infoMap.measures[Math.max(0, Math.min(range.from, infoMap.measures.length) - 1)]?.startTime ?? 0;
  const anchorsIn = (startSec: number, endSec: number) => shiftAnchors(anchors, sliceStart, slice.duration, startSec, endSec - startSec);
  const offset = (list: MeasureAlignment[], startSec: number) =>
    list.map((a) => ({ n: a.n + range.from - 1, startSec: a.startSec + startSec, confidence: a.confidence }));
  let method_ = method.id as string;
  let fellBack = false;
  let auto: MeasureAlignment[];
  try {
    const out = await alignInWorker(slice, toAlignAudio(recording, win), onProgress, signal, {
      method: method.id,
      anchors: anchorsIn(win.startSec, win.endSec),
      noFallback: true,
      transferSamples: true,
    });
    auto = offset(out.auto, win.startSec);
    method_ = out.method;
  } catch (err) {
    if (err instanceof Error && err.name === "AbortError") throw err;
    // fall back on the inner window (chroma DTW stretches over any padding it is given)
    const inner = { startSec: win.innerStartSec, endSec: Math.max(win.innerEndSec, win.innerStartSec + 0.5) };
    const out = await alignInWorker(slice, toAlignAudio(recording, inner), onProgress, signal, {
      method: CHROMA_DTW_METHOD,
      anchors: anchorsIn(inner.startSec, inner.endSec),
      transferSamples: true,
    });
    auto = offset(out.auto, inner.startSec);
    method_ = out.method;
    fellBack = true;
  }
  const averageConfidence = auto.length ? Math.round(auto.reduce((s, a) => s + a.confidence, 0) / auto.length) : 0;
  return { auto, method: method_, fellBack, averageConfidence };
}
