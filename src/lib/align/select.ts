/**
 * Which aligner runs. "integrated-tempo" (ADR 0014) is the default; if it
 * cannot run (recording under 2 s or over 40 minutes, a broad match too large
 * for memory, no path), alignment falls back to chroma DTW (ADR 0009) so the
 * user still gets a result. Cancellation is never turned into a fallback.
 */
import type { InfoMap } from "@/shared/info-map";
import type { AlignAudio, AlignProgress, SyncState } from "@/shared/sync";
import { CHROMA_DTW_METHOD, createChromaDtwAligner, type ChromaDtwOptions } from "./index";
import { INTEGRATED_METHOD, createIntegratedAligner, type IntegratedOptions } from "./integrated";

export type AlignMethod = typeof INTEGRATED_METHOD | typeof CHROMA_DTW_METHOD;
export const DEFAULT_ALIGN_METHOD: AlignMethod = INTEGRATED_METHOD;

export interface AlignOptions extends ChromaDtwOptions, IntegratedOptions {
  method?: AlignMethod;
  /** let an integrated failure through instead of falling back on the same audio (a range run falls back on its inner window) */
  noFallback?: boolean;
}

export async function runAlignment(
  infoMap: InfoMap,
  audio: AlignAudio,
  options: AlignOptions = {},
  onProgress?: AlignProgress,
  signal?: AbortSignal,
): Promise<SyncState> {
  const { method = DEFAULT_ALIGN_METHOD, noFallback = false, ...rest } = options;
  const chroma = () => createChromaDtwAligner(rest).align(infoMap, audio, onProgress, signal);
  if (method === CHROMA_DTW_METHOD) return chroma();
  try {
    return await createIntegratedAligner(rest).align(infoMap, audio, onProgress, signal);
  } catch (err) {
    if ((err instanceof Error && err.name === "AbortError") || noFallback) throw err;
    console.warn("[align] integrated aligner failed, falling back to chroma DTW:", err instanceof Error ? err.message : err);
    return chroma();
  }
}
