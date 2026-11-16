"use client";

import { useCallback, useMemo } from "react";
import { appliedOf, mergeAlignmentDetailed, measureAtRecordingTime, recordingToScoreTime, scoreToRecordingTime, type ManualMarker, type MeasureAlignment, type SyncState } from "@/shared/sync";
import { useProject } from "./project";
import { usePlayback } from "./playback";

export { recordingToScoreTime, scoreToRecordingTime };

type Merged = ReturnType<typeof mergeAlignmentDetailed>;
/** one merge per (auto, applied) pair: a marker edit replaces only `manual`, so audible timing keeps its identity (ADR 0018) */
const mergeCache = new WeakMap<MeasureAlignment[], WeakMap<ManualMarker[], Merged>>();
const EMPTY: ManualMarker[] = [];

/** Audible timing of a sync state: the aligner's bars with the applied markers merged in. */
export function mergedAlignment(sync: Pick<SyncState, "auto" | "manual" | "applied">): Merged {
  const applied = appliedOf(sync) ?? EMPTY;
  let inner = mergeCache.get(sync.auto);
  if (!inner) {
    inner = new WeakMap();
    mergeCache.set(sync.auto, inner);
  }
  let hit = inner.get(applied);
  if (!hit) {
    hit = mergeAlignmentDetailed(sync.auto, applied);
    inner.set(applied, hit);
  }
  return hit;
}

/**
 * Two clocks: the transport runs in recording time when a recording exists
 * (score time otherwise). The visual always reads score time, so these map
 * one onto the other through the merged alignment.
 */
export function useProjectTiming() {
  const infoMap = useProject((s) => s.infoMap);
  const sync = useProject((s) => s.sync);
  const hasRecording = useProject((s) => s.summary?.hasRecording ?? false);

  const auto = sync?.auto;
  const applied = sync ? appliedOf(sync) : undefined;
  // keyed on the arrays, not the sync object: editing a marker changes nothing audible
  const aligned = useMemo(() => (auto && applied && hasRecording ? mergedAlignment({ auto, manual: applied, applied }).aligned : []), [auto, applied, hasRecording]);

  /** score-time clock for the Stage */
  const clock = useCallback(() => {
    const t = usePlayback.getState().time;
    if (!infoMap || aligned.length === 0) return t;
    return recordingToScoreTime(infoMap, aligned, t);
  }, [infoMap, aligned]);

  const measureAt = useCallback(
    (t: number) => {
      if (!infoMap) return 1;
      if (aligned.length > 0) return measureAtRecordingTime(aligned, t);
      const ms = infoMap.measures;
      let lo = 0;
      let hi = ms.length - 1;
      while (lo < hi) {
        const mid = (lo + hi + 1) >> 1;
        if (ms[mid].startTime <= t) lo = mid;
        else hi = mid - 1;
      }
      return ms[lo]?.number ?? 1;
    },
    [infoMap, aligned],
  );

  const measureStart = useCallback(
    (n: number) => {
      if (!infoMap) return 0;
      if (aligned.length > 0) return aligned[n - 1]?.startSec ?? 0;
      return infoMap.measures[n - 1]?.startTime ?? 0;
    },
    [infoMap, aligned],
  );

  const seekMeasure = useCallback(
    (n: number) => {
      usePlayback.getState().seek(measureStart(n));
    },
    [measureStart],
  );

  /** seek the transport to a score time (a note clicked in the notation) */
  const seekScoreTime = useCallback(
    (scoreSec: number) => {
      const t = infoMap && aligned.length > 0 ? scoreToRecordingTime(infoMap, aligned, scoreSec) : scoreSec;
      usePlayback.getState().seek(Math.max(0, t));
    },
    [infoMap, aligned],
  );

  /** transport seconds of a score time */
  const toTransport = useCallback(
    (scoreSec: number) => (infoMap && aligned.length > 0 ? scoreToRecordingTime(infoMap, aligned, scoreSec) : scoreSec),
    [infoMap, aligned],
  );
  /** score seconds of a transport time */
  const toScore = useCallback((t: number) => (infoMap && aligned.length > 0 ? recordingToScoreTime(infoMap, aligned, t) : t), [infoMap, aligned]);

  return { clock, measureAt, measureStart, seekMeasure, seekScoreTime, toTransport, toScore, aligned, hasRecording };
}
