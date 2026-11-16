import type { AlignResult } from "@/shared/jobs";
import { pendingOf, UNCERTAIN_THRESHOLD, type ManualMarker, type SyncState } from "@/shared/sync";
import { spliceAuto } from "@/lib/align/range";

/** What a sync run produced, before it is written (the black box's output). */
export interface RunOutput {
  auto: SyncState["auto"];
  method: string;
  fellBack: boolean;
  diagnostics?: SyncState["diagnostics"];
  averageConfidence: number;
}

/**
 * The state a run writes (ADR 0018/0019), shared by the real API and the mock.
 * Whole piece: everything from the run, every marker applied. Range: the
 * run's bars spliced in, `method` and `diagnostics` kept from the last
 * whole-piece run, and only the pending markers fully inside the range applied.
 */
export function writeRun(
  prev: SyncState | null,
  out: RunOutput,
  range: { from: number; to: number } | null,
  manual: ManualMarker[],
  nextApplied: ManualMarker[],
): { sync: SyncState; summary: AlignResult } {
  let sync: SyncState;
  let seamClamped = 0;
  if (!range || !prev) {
    sync = { method: out.method, auto: out.auto, manual, applied: nextApplied, averageConfidence: out.averageConfidence };
    if (out.diagnostics) sync.diagnostics = out.diagnostics;
  } else {
    const spliced = spliceAuto(prev.auto, out.auto, range);
    seamClamped = spliced.seamClamped;
    sync = { method: prev.method, auto: spliced.auto, manual, applied: nextApplied, averageConfidence: spliced.averageConfidence };
    if (prev.diagnostics) sync.diagnostics = prev.diagnostics;
  }
  const before = prev ? pendingOf(prev.manual, prev.applied ?? prev.manual).length : 0;
  const stillPending = pendingOf(manual, nextApplied).length;
  const summary: AlignResult = {
    measures: sync.auto.length,
    averageConfidence: sync.averageConfidence,
    uncertainMeasures: sync.auto.filter((m) => m.confidence < UNCERTAIN_THRESHOLD).length,
    method: out.method,
    applied: Math.max(0, before - stillPending),
    stillPending,
    fellBack: out.fellBack,
  };
  if (range) summary.range = range;
  if (seamClamped) summary.seamClamped = seamClamped;
  return { sync, summary };
}
