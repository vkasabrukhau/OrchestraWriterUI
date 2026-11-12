"use client";

import { useMemo } from "react";
import { RefreshCw } from "lucide-react";
import { appliedOf, pendingOf, type PendingItem } from "@/shared/sync";
import { useProject } from "@/lib/store/project";
import { mergedAlignment } from "@/lib/store/useProjectTiming";
import { Button } from "@/components/ui/Button";
import { pendingRanges, recomputeLabel } from "./markerName";
import { useSyncActions } from "../workspace/SyncActions";

/** A marker this far from where its note plays now suggests a recompute (owner: "upon placing certain markers"). */
export const SUGGEST_AFTER_SEC = 0.25;
/** …or this many markers waiting. */
export const SUGGEST_AFTER_PENDING = 5;

/** Whether the app should suggest a recompute, and for which local ranges. */
export function recomputeSuggestion(items: PendingItem[], landingOf: (m: { measure: number; position?: number }) => number | null, count: number) {
  if (items.length === 0) return null;
  const far = items.filter((i) => {
    if (!i.intended) return false;
    const at = landingOf(i.intended);
    return at !== null && Math.abs(i.intended.startSec - at) > SUGGEST_AFTER_SEC;
  });
  if (far.length === 0 && items.length < SUGGEST_AFTER_PENDING) return null;
  const ranges = pendingRanges(items, count);
  return { ranges, markers: items.length, label: recomputeLabel(ranges, items.length) };
}

/** The non-blocking suggestion in the toolbar. It never runs by itself. */
export function RecomputeSuggestion() {
  const sync = useProject((s) => s.sync);
  const infoMap = useProject((s) => s.infoMap);
  const { recompute, running } = useSyncActions();
  const suggestion = useMemo(() => {
    if (!sync || !infoMap) return null;
    const items = pendingOf(sync.manual, appliedOf(sync));
    const { aligned } = mergedAlignment(sync);
    const landingOf = (m: { measure: number; position?: number }) => {
      const a = aligned[m.measure - 1];
      if (!a) return null;
      const next = aligned[m.measure];
      return a.startSec + (m.position ?? 0) * ((next?.startSec ?? a.startSec) - a.startSec);
    };
    return recomputeSuggestion(items, landingOf, infoMap.measures.length);
  }, [sync, infoMap]);
  if (!suggestion) return null;
  return (
    <div className="flex items-center gap-2" role="status">
      <span className="sr-only">Markers are waiting to be applied.</span>
      <Button size="sm" leading={<RefreshCw size={12} />} onClick={() => recompute(suggestion.ranges)} disabled={running} data-recompute-button>
        {suggestion.label}
      </Button>
    </div>
  );
}
