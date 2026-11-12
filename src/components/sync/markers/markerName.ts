import type { InfoMap } from "@/shared/info-map";
import { markerPosition, type ManualMarker, type PendingItem } from "@/shared/sync";
import { recomputeRanges } from "@/lib/align/range";
import { formatTime } from "@/lib/utils/format";
import { spotText } from "@/components/music/bars";

export type MarkerState = "applied" | "pending" | "deleted";

/** "Horn entry" or "Bar 12, beat 3" */
export function markerTitle(infoMap: InfoMap, m: ManualMarker): string {
  return m.label ?? spotText(infoMap, m.measure, markerPosition(m), true);
}

/** The accessible name of a marker icon. */
export function markerAccessibleName(infoMap: InfoMap, m: ManualMarker, state: MarkerState): string {
  const where = spotText(infoMap, m.measure, markerPosition(m));
  const name = m.label ? `Marker ‘${m.label}’, ${where}` : `Marker on ${where}`;
  const status = state === "applied" ? "applied" : state === "pending" ? "pending: recompute to apply" : "deleted: recompute to apply";
  return `${name} at ${formatTime(m.startSec, true)}, ${status} — edit`;
}

/** "bars 6–10" / "bar 6" */
export function barsText(r: { from: number; to: number }): string {
  return r.from === r.to ? `bar ${r.from}` : `bars ${r.from}–${r.to}`;
}

/** The local ranges a recompute of these pending items covers (each bar ± 2, merged). */
export function pendingRanges(items: PendingItem[], count: number): Array<{ from: number; to: number }> {
  return recomputeRanges(
    items.flatMap((i) => i.bars),
    count,
  );
}

/** One formatter for the suggestion copy everywhere (toolbar, Sync section, details). */
export function recomputeLabel(ranges: Array<{ from: number; to: number }>, markers: number): string {
  const what = `${markers} marker${markers === 1 ? "" : "s"}`;
  if (ranges.length === 1) return `Recompute ${barsText(ranges[0])} to apply ${what}`;
  return `Recompute ${ranges.length} passages to apply ${what}`;
}
