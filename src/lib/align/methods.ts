import { CHROMA_DTW_METHOD } from "./index";
import { INTEGRATED_METHOD } from "./integrated";
import { REDLINE_METHOD } from "./redline";
import type { AlignMethod } from "./select";

/**
 * The sync methods a user can pick (owner: "rigid or smooth", one per run).
 * Smooth is today's tempo-fit aligner (ADR 0014). Rigid is shown but not
 * available until it is built: implement it behind runSync, add its id to
 * AlignMethod and a case in runAlignment, register it here with style
 * "rigid", and write an ADR. Chroma DTW stays an internal fallback.
 */
export type SyncStyle = "smooth" | "rigid" | "redline";

export interface SyncMethod {
  id: AlignMethod;
  style: SyncStyle;
  label: string;
  description: string;
}

export const SYNC_METHODS: readonly SyncMethod[] = [
  { id: INTEGRATED_METHOD, style: "smooth", label: "Smooth", description: "Tempo fitted to the recording" },
  // redline experiment: picked in components/sync/experiment/AlignerChoice (not in SYNC_STYLES)
  { id: REDLINE_METHOD, style: "redline", label: "Redline", description: "Coarse-to-fine DTW on note onsets" },
];

export const SYNC_STYLES: Array<{ style: SyncStyle; label: string }> = [
  { style: "smooth", label: "Smooth" },
  { style: "rigid", label: "Rigid" },
];

export function methodForStyle(style: SyncStyle): SyncMethod | null {
  return SYNC_METHODS.find((m) => m.style === style) ?? null;
}

/** Plain name of a stored method id, for result lines. */
export function methodLabel(id: string): string {
  if (id === INTEGRATED_METHOD) return "Smooth";
  if (id === CHROMA_DTW_METHOD) return "fallback aligner";
  if (id === REDLINE_METHOD) return "Redline";
  return id;
}
