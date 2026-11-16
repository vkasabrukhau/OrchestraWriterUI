"use client";

import { useMemo } from "react";
import { appliedOf, markerPosition, pendingBars, pendingOf, type ManualMarker, type PendingItem } from "@/shared/sync";
import { useProject } from "@/lib/store/project";
import { mergedAlignment } from "@/lib/store/useProjectTiming";
import type { MarkerState } from "./markerName";

export interface DisplayedMarker {
  marker: ManualMarker;
  state: MarkerState;
  /** too close to a neighbour to keep exactly (pushed by the merge) */
  unhonoured: boolean;
}

/**
 * Every marker as the page shows it: the edited list (applied or pending),
 * plus pending deletions (crossed out, at their applied place), in recording
 * order. Also the pending items and the bars that hold one.
 */
export function useDisplayedMarkers(): { list: DisplayedMarker[]; pending: PendingItem[]; bars: Set<number> } {
  const sync = useProject((s) => s.sync);
  return useMemo(() => {
    if (!sync) return { list: [], pending: [], bars: new Set<number>() };
    const applied = appliedOf(sync);
    const pending = pendingOf(sync.manual, applied);
    const kind = new Map(pending.map((p) => [p.id, p.kind]));
    const { unhonoured } = mergedAlignment(sync);
    const pushed = new Set(unhonoured);
    const list: DisplayedMarker[] = sync.manual.map((m) => ({ marker: m, state: kind.has(m.id) ? "pending" : "applied", unhonoured: pushed.has(m.id) }));
    for (const p of pending) if (p.kind === "deleted" && p.applied) list.push({ marker: p.applied, state: "deleted", unhonoured: false });
    list.sort((a, b) => a.marker.startSec - b.marker.startSec || a.marker.measure - b.marker.measure || markerPosition(a.marker) - markerPosition(b.marker));
    return { list, pending, bars: pendingBars(pending) };
  }, [sync]);
}
