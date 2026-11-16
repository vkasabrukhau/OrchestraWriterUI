"use client";

import { useMemo } from "react";
import type { InfoMap } from "@/shared/info-map";
import { markerPosition } from "@/shared/sync";
import { useProject } from "@/lib/store/project";
import { useSyncUi } from "@/lib/store/sync-ui";
import { barNumber } from "@/components/music/bars";
import { ConfidenceStrip } from "../ConfidenceStrip";
import { MarkerIcon } from "../markers/MarkerIcon";
import { markerAccessibleName } from "../markers/markerName";
import { useDisplayedMarkers } from "../markers/useDisplayedMarkers";
import { useSyncActions } from "../workspace/SyncActions";

/**
 * The confidence map (owner: reuse the current component, plus markers and
 * the current location): one column per bar colored by the last sync's
 * confidence, bars with a pending marker hatched, marker pins above it.
 */
export function ConfidencePane({ infoMap, current }: { infoMap: InfoMap; current: number }) {
  const auto = useProject((s) => s.sync?.auto);
  const selected = useSyncUi((s) => s.selected);
  const { list, bars } = useDisplayedMarkers();
  const { jumpTo } = useSyncActions();
  const n = auto?.length ?? 0;
  const markedBars = useMemo(() => new Set(list.filter((d) => d.state !== "deleted").map((d) => d.marker.measure)), [list]);
  if (!auto || n === 0) return null;
  return (
    <div className="flex h-full min-h-0 flex-col px-3 pb-2 pt-1">
      <div className="relative h-5 shrink-0" aria-label="Markers along the piece">
        {list.map((d) => (
          <MarkerIcon
            key={`${d.marker.id}:${d.state}`}
            id={d.marker.id}
            state={d.state}
            size={10}
            name={markerAccessibleName(infoMap, d.marker, d.state)}
            className="absolute top-0 -translate-x-1/2"
            style={{ left: `${((d.marker.measure - 1 + markerPosition(d.marker)) / n) * 100}%` }}
            onPress={(el) => useSyncUi.getState().openPopover(d.marker.id, el)}
          />
        ))}
      </div>
      <ConfidenceStrip
        aligned={auto}
        manual={markedBars}
        pending={bars}
        current={current}
        selected={selected?.measure ?? null}
        onPick={(m) => jumpTo({ measure: m, position: 0 })}
        labelOf={(m) => barNumber(infoMap, m)}
        className="min-h-0 flex-1"
        barClassName="h-[max(24px,calc(100%-44px))]"
      />
    </div>
  );
}
