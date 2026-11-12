/**
 * Web Worker entry for alignment. Created by worker-client.ts with
 *   new Worker(new URL("./worker.ts", import.meta.url), { type: "module" })
 * Receives one AlignRequest, posts progress messages, then a result or an error.
 * Cancellation = the client terminates the worker.
 */
import type { AlignRequest, AlignResponse } from "./protocol";
import { runAlignment } from "./select";

interface WorkerScope {
  onmessage: ((event: MessageEvent<AlignRequest>) => void) | null;
  postMessage(message: AlignResponse): void;
}

const scope = globalThis as unknown as WorkerScope;

scope.onmessage = (event) => {
  const req = event.data;
  if (!req || req.type !== "align") return;
  runAlignment(req.infoMap, { samples: req.samples, sampleRate: req.sampleRate, durationSec: req.durationSec }, req.options, (progress, message) =>
    scope.postMessage({ type: "progress", progress, message }),
  )
    .then((result) => scope.postMessage({ type: "result", result }))
    .catch((err: unknown) =>
      scope.postMessage({
        type: "error",
        error: err instanceof Error ? err.message : String(err),
        name: err instanceof Error ? err.name : undefined,
      }),
    );
};
