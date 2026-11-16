import type { InfoMap } from "@/shared/info-map";
import type { SyncState } from "@/shared/sync";
import type { AlignOptions } from "./select";

/** Messages between worker-client.ts (page) and worker.ts (Web Worker). */
export interface AlignRequest {
  type: "align";
  infoMap: InfoMap;
  /** mono PCM; its buffer is transferred to the worker */
  samples: Float32Array;
  sampleRate: number;
  durationSec: number;
  options?: AlignOptions;
}

export type AlignResponse =
  | { type: "progress"; progress: number; message: string }
  | { type: "result"; result: SyncState }
  | { type: "error"; error: string; name?: string };
