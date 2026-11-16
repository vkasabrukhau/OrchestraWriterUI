/**
 * Runs the aligner (runAlignment: integrated tempo, chroma DTW fallback) off the main thread with progress and
 * cancellation. Falls back to the main thread where Worker is unavailable
 * (tests, old browsers); the result is identical.
 *
 * The recording's samples are COPIED before being transferred, so the
 * caller's Float32Array (often an AudioBuffer's channel data) stays usable.
 * Pass `transferSamples: true` when the array is a throwaway (e.g. a fresh
 * mono downmix) to skip the copy; the caller's array is detached afterwards.
 */
import type { InfoMap } from "@/shared/info-map";
import type { AlignAudio, AlignProgress, SyncState } from "@/shared/sync";
import type { AlignRequest, AlignResponse } from "./protocol";
import { runAlignment, type AlignOptions } from "./select";

function abortError(): Error {
  return typeof DOMException !== "undefined"
    ? new DOMException("Alignment cancelled", "AbortError")
    : Object.assign(new Error("Alignment cancelled"), { name: "AbortError" });
}

/** Loud on purpose: the fallback blocks the UI for long recordings, and e2e listens for this line. */
function warnMainThread(reason: unknown) {
  console.warn("[align] worker unavailable, running on the main thread:", reason);
}

function withoutTransfer(options?: AlignOptions & { transferSamples?: boolean }): AlignOptions {
  const rest: AlignOptions & { transferSamples?: boolean } = { ...options };
  delete rest.transferSamples;
  return rest;
}

export async function alignInWorker(
  infoMap: InfoMap,
  audio: AlignAudio,
  onProgress?: AlignProgress,
  signal?: AbortSignal,
  options?: AlignOptions & { transferSamples?: boolean },
): Promise<SyncState> {
  if (signal?.aborted) throw abortError();
  if (typeof Worker === "undefined") {
    return runAlignment(infoMap, audio, withoutTransfer(options), onProgress, signal);
  }

  let worker: Worker;
  try {
    worker = new Worker(new URL("./worker.ts", import.meta.url), { type: "module" });
  } catch (err) {
    warnMainThread(err instanceof Error ? err.message : err);
    return runAlignment(infoMap, audio, withoutTransfer(options), onProgress, signal);
  }

  return new Promise<SyncState>((resolve, reject) => {
    let settled = false;
    const finish = (fn: () => void) => {
      if (settled) return;
      settled = true;
      signal?.removeEventListener("abort", onAbort);
      worker.terminate();
      fn();
    };
    const onAbort = () => finish(() => reject(abortError()));
    signal?.addEventListener("abort", onAbort, { once: true });

    let heardFromWorker = false;
    worker.onmessage = (event: MessageEvent<AlignResponse>) => {
      heardFromWorker = true;
      const msg = event.data;
      if (msg.type === "progress") onProgress?.(msg.progress, msg.message);
      else if (msg.type === "result") finish(() => resolve(msg.result));
      else if (msg.type === "error") finish(() => reject(Object.assign(new Error(msg.error), { name: msg.name ?? "Error" })));
    };
    worker.onerror = (event) => {
      event.preventDefault?.();
      // the worker script failed to load: run on the main thread instead
      if (!heardFromWorker)
        finish(() => {
          warnMainThread(event.message || "the worker script failed to load");
          runAlignment(infoMap, audio, withoutTransfer(options), onProgress, signal).then(resolve, reject);
        });
      else finish(() => reject(new Error(event.message || "Alignment worker failed")));
    };

    const samples = options?.transferSamples ? audio.samples : audio.samples.slice();
    const alignOptions = withoutTransfer(options);
    const request: AlignRequest = {
      type: "align",
      infoMap,
      samples,
      sampleRate: audio.sampleRate,
      durationSec: audio.durationSec,
      options: alignOptions,
    };
    worker.postMessage(request, [samples.buffer]);
  });
}
