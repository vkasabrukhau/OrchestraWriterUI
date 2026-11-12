"use client";

import { useMemo } from "react";
import type { InfoMap } from "@/shared/info-map";
import { markerPosition, sameMarkerSpot } from "@/shared/sync";
import { useProject } from "@/lib/store/project";
import { useSyncUi } from "@/lib/store/sync-ui";
import { barOnsets } from "@/lib/score/stamps";
import { formatTime } from "@/lib/utils/format";
import { ScoreView } from "@/components/music/ScoreView";
import type { ScoreMarker } from "@/components/music/EngravedScore";
import { spotText } from "@/components/music/bars";
import { markerAccessibleName } from "../markers/markerName";
import { useDisplayedMarkers } from "../markers/useDisplayedMarkers";
import { useSyncActions } from "../workspace/SyncActions";

/** The next or previous note onset (any part) from a spot, crossing bars. */
export function stepSpot(infoMap: InfoMap, spot: { measure: number; position: number }, dir: 1 | -1): { measure: number; position: number } | null {
  const onsets = barOnsets(infoMap, spot.measure);
  if (dir > 0) {
    const next = onsets.find((o) => o > spot.position + 1e-6);
    if (next !== undefined) return { measure: spot.measure, position: next };
    if (spot.measure >= infoMap.measures.length) return null;
    return { measure: spot.measure + 1, position: barOnsets(infoMap, spot.measure + 1)[0] ?? 0 };
  }
  const before = onsets.filter((o) => o < spot.position - 1e-6);
  if (before.length > 0) return { measure: spot.measure, position: before[before.length - 1] };
  if (spot.measure <= 1) return null;
  const prev = barOnsets(infoMap, spot.measure - 1);
  return { measure: spot.measure - 1, position: prev[prev.length - 1] ?? 0 };
}

/**
 * The score on Sync: left-click selects a note (the start point); right-click
 * opens the note menu ("Add marker"); markers show as pins (applied filled,
 * pending dashed, deleted crossed out) that open their details. With focus
 * here, ←/→ move the selected note (and seek), announcing it.
 */
export function ScorePane({ projectId, infoMap, current }: { projectId: string; infoMap: InfoMap; current: number }) {
  const sync = useProject((s) => s.sync)!;
  const { list } = useDisplayedMarkers();
  const { jumpTo, select } = useSyncActions();
  const confidence = useMemo(() => new Map(sync.auto.map((a) => [a.n, a.confidence])), [sync.auto]);
  const markers = useMemo<ScoreMarker[]>(
    () => list.map((d) => ({ id: d.marker.id, measure: d.marker.measure, position: markerPosition(d.marker), state: d.state, name: markerAccessibleName(infoMap, d.marker, d.state) })),
    [list, infoMap],
  );

  const announce = (spot: { measure: number; position: number }) => {
    const mk = sync.manual.find((m) => sameMarkerSpot(m, spot.measure, spot.position));
    const where = spotText(infoMap, spot.measure, spot.position, true);
    useSyncUi.getState().announce(mk ? `${where} · marker${mk.label ? ` ‘${mk.label}’` : ""} at ${formatTime(mk.startSec, true)}` : `${where} · no marker`);
  };

  return (
    <div
      className="flex h-full min-h-0 min-w-0 flex-col overflow-hidden"
      data-local-keys="ArrowLeft ArrowRight"
      onKeyDown={(e) => {
        if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return;
        if (e.shiftKey || e.metaKey || e.ctrlKey || e.altKey) return; // the transport's skips
        const el = e.target as HTMLElement;
        if (el.tagName === "INPUT" || el.getAttribute("role") === "slider") return;
        const from = useSyncUi.getState().selected ?? { measure: current, position: 0 };
        const next = stepSpot(infoMap, from, e.key === "ArrowRight" ? 1 : -1);
        e.preventDefault();
        e.stopPropagation();
        if (!next) return;
        jumpTo(next);
        announce(next);
      }}
    >
      <ScoreView
        key={projectId}
        projectId={projectId}
        infoMap={infoMap}
        currentMeasure={current}
        onSeekMeasure={(n) => jumpTo({ measure: n, position: 0 })}
        maxParts={6}
        confidence={confidence}
        mode="sync"
        fill
        className="min-h-0 flex-1"
        markers={markers}
        onPick={(spot) => {
          select(spot);
          announce(spot);
        }}
        onMarkerPress={(id, el) => useSyncUi.getState().openPopover(id, el)}
        onSpotContextMenu={(spot, at) => useSyncUi.getState().openMenu(spot, at.x, at.y)}
      />
    </div>
  );
}
