"use client";

import { useEffect, useState } from "react";
import { AlertTriangle, RefreshCw } from "lucide-react";
import type { InfoMap } from "@/shared/info-map";
import type { AlignResult, Job } from "@/shared/jobs";
import { resolveGoTo } from "@/lib/score/navigation";
import { barAt } from "@/lib/score/navigation";
import { usePlayback } from "@/lib/store/playback";
import { useSyncUi } from "@/lib/store/sync-ui";
import { useProjectTiming } from "@/lib/store/useProjectTiming";
import { SYNC_STYLES, methodForStyle, type SyncStyle } from "@/lib/align/methods";
import { Button } from "@/components/ui/Button";
import { Segmented } from "@/components/ui/Segmented";
import { JobLine } from "@/components/export/shared";
import { barsText, pendingRanges, recomputeLabel } from "../markers/markerName";
import { useDisplayedMarkers } from "../markers/useDisplayedMarkers";
import { useSyncActions } from "../workspace/SyncActions";
import { SidebarSection } from "./SidebarSection";

/** "Bars 6–16 recomputed · 3 markers applied · 1 still pending · 81% average" */
export function resultLine(r: AlignResult): string {
  const what = r.range ? `${barsText(r.range).replace(/^b/, "B")} recomputed` : `Whole piece recomputed`;
  const parts = [what];
  if (r.applied) parts.push(`${r.applied} marker${r.applied === 1 ? "" : "s"} applied`);
  if (r.stillPending) parts.push(`${r.stillPending} still pending`);
  parts.push(`${Math.round(r.averageConfidence)}% average`);
  return parts.join(" · ") + (r.fellBack ? " (used the fallback aligner)" : "");
}

/**
 * Sync: run the sync function (a black box for now) over a measure range or
 * the whole piece, with the chosen method. A run applies the pending markers
 * inside its range; timing and confidence then update together.
 */
export function SyncSection({ infoMap, job, lastResult, startError }: { infoMap: InfoMap; job: Job<AlignResult> | null; lastResult: AlignResult | null; startError: string | null }) {
  const { recompute, running } = useSyncActions();
  const { pending } = useDisplayedMarkers();
  const syncFrom = useSyncUi((s) => s.syncFrom);
  const syncTo = useSyncUi((s) => s.syncTo);
  const setUi = useSyncUi((s) => s.set);
  const transportRange = usePlayback((s) => s.range);
  const { toScore } = useProjectTiming();
  const [style, setStyle] = useState<SyncStyle>("smooth");
  const [error, setError] = useState<string | null>(null);
  const count = infoMap.measures.length;
  const ranges = pendingRanges(pending, count);

  // a passage picked in the score (Shift-click two notes) fills the fields; clearing it keeps them
  useEffect(() => {
    if (!transportRange) return;
    const a = barAt(infoMap.measures, toScore(transportRange.start));
    const b = barAt(infoMap.measures, Math.max(toScore(transportRange.start), toScore(transportRange.end) - 1e-3));
    useSyncUi.getState().set({ syncFrom: String(a), syncTo: String(b) });
  }, [transportRange, infoMap, toScore]);

  const runRange = () => {
    setError(null);
    // the fields hold playback bars (what the page shows); rehearsal marks and printed numbers also work
    const parse = (v: string) => {
      const t = v.trim();
      if (/^\d+$/.test(t) && Number(t) >= 1 && Number(t) <= count) return Number(t);
      const g = resolveGoTo(t, infoMap, 1);
      return g.kind === "bar" ? g.measure : null;
    };
    const from = parse(syncFrom || "1");
    const to = parse(syncTo || String(count));
    if (from === null || to === null) return setError("Enter bar numbers or rehearsal marks.");
    if (to < from) return setError("The last bar comes before the first.");
    if (!methodForStyle(style)) return setError("That method is not available yet.");
    recompute(from <= 1 && to >= count ? null : [{ from, to }]);
  };

  return (
    <SidebarSection id="sync" title="Sync" summary={pending.length ? `${pending.length} pending` : undefined}>
      {pending.length > 0 ? (
        <div className="mb-3 rounded bg-paper-2 p-2 text-[12px]">
          <p className="text-ink-2">
            {pending.length} marker change{pending.length === 1 ? "" : "s"} pending in {ranges.map(barsText).join(", ")}.
          </p>
          <Button size="sm" className="mt-1.5" leading={<RefreshCw size={12} />} onClick={() => recompute(ranges)} disabled={running} data-recompute-button>
            {recomputeLabel(ranges, pending.length)}
          </Button>
        </div>
      ) : (
        <p className="mb-3 text-[12px] text-ink-3">No pending markers. Placing a marker changes nothing you hear until you recompute.</p>
      )}

      <form
        className="space-y-2"
        onSubmit={(e) => {
          e.preventDefault();
          runRange();
        }}
      >
        <div className="flex items-center gap-1.5 text-[12px]">
          <label className="text-ink-3" htmlFor="sync-from">
            Bars
          </label>
          <input id="sync-from" className="h-7 w-16 rounded border border-line bg-paper px-1.5 tnum" placeholder="1" value={syncFrom} onChange={(e) => setUi({ syncFrom: e.target.value })} aria-label="Re-sync from bar" />
          <span aria-hidden>–</span>
          <input className="h-7 w-16 rounded border border-line bg-paper px-1.5 tnum" placeholder={String(count)} value={syncTo} onChange={(e) => setUi({ syncTo: e.target.value })} aria-label="Re-sync to bar" />
          <button type="button" className="text-[11px] text-brass-3 hover:underline" onClick={() => setUi({ syncFrom: "", syncTo: "" })}>
            Whole piece
          </button>
        </div>
        <p className="text-[11px] text-ink-3">Shift-click two notes in the score to pick bars (this also repeats them).</p>
        <div className="flex items-center gap-2">
          <Segmented<SyncStyle>
            size="sm"
            ariaLabel="Sync method"
            value={style}
            onChange={setStyle}
            options={SYNC_STYLES.map((s) => ({ value: s.style, label: s.label, disabled: !methodForStyle(s.style) }))}
          />
          <span className="text-[11px] text-ink-3">{methodForStyle(style)?.description ?? "Not available yet"}</span>
        </div>
        <Button type="submit" size="sm" variant="outline" leading={<RefreshCw size={12} className={running ? "animate-spin" : ""} />} disabled={running}>
          Run sync
        </Button>
      </form>

      <div className="mt-2 text-[12px]" aria-live="polite">
        {(error || startError) && (
          <p className="flex items-center gap-1.5 text-danger" role="alert">
            <AlertTriangle size={12} aria-hidden /> {error ?? startError}
          </p>
        )}
        {job && (job.status === "running" || job.status === "queued") ? (
          <JobLine job={job} />
        ) : job?.status === "failed" ? (
          <p className="flex items-center gap-1.5 text-danger" role="alert">
            <AlertTriangle size={12} aria-hidden /> {job.error ?? "The sync failed."}
          </p>
        ) : lastResult ? (
          <p className="text-ink-2" data-testid="sync-result">
            {resultLine(lastResult)}
          </p>
        ) : null}
      </div>
    </SidebarSection>
  );
}
