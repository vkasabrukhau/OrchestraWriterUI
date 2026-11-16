"use client";

import { memo, useMemo, useRef, useState } from "react";
import { SkipForward } from "lucide-react";
import type { InfoMap } from "@/shared/info-map";
import { CONFIDENCE_BANDS, UNCERTAIN_THRESHOLD, confidenceBand, markerPosition, type MeasureAlignment } from "@/shared/sync";
import { useProject } from "@/lib/store/project";
import { useSyncUi, type BandFilter, type MeasureSort } from "@/lib/store/sync-ui";
import { cx } from "@/lib/utils/format";
import { Button } from "@/components/ui/Button";
import { Segmented } from "@/components/ui/Segmented";
import { barNumber } from "@/components/music/bars";
import { MarkerIcon } from "../markers/MarkerIcon";
import { markerAccessibleName } from "../markers/markerName";
import { useDisplayedMarkers, type DisplayedMarker } from "../markers/useDisplayedMarkers";
import { useSyncActions } from "../workspace/SyncActions";
import { SidebarSection } from "./SidebarSection";

/** Bars sorted and filtered for the Measures list (confidence and order, owner). */
export function filterMeasures(
  auto: MeasureAlignment[],
  opts: { sort: MeasureSort; bands: Set<BandFilter>; from?: number | null; to?: number | null },
): MeasureAlignment[] {
  let list = auto.filter((a) => (opts.from == null || a.n >= opts.from) && (opts.to == null || a.n <= opts.to));
  if (opts.bands.size > 0) list = list.filter((a) => opts.bands.has(confidenceBand(a.confidence).id));
  if (opts.sort === "confidence") list = [...list].sort((a, b) => a.confidence - b.confidence || a.n - b.n);
  return list;
}

/** The next uncertain bar after `from` that has no marker (owner: skip bars with a marker). */
export function nextUncertain(auto: MeasureAlignment[], marked: Set<number>, from: number): number | null {
  const candidates = auto.filter((a) => a.confidence < UNCERTAIN_THRESHOLD && !marked.has(a.n));
  if (candidates.length === 0) return null;
  return (candidates.find((a) => a.n > from) ?? candidates[0]).n;
}

/**
 * Measures: every bar with its confidence (from the last sync) and markers.
 * Sort by order or confidence, filter by confidence band and bar range;
 * click a bar to jump there. A grid: ↑/↓ rows, ←/→ cells, Home/End,
 * Enter on a bar jumps, Enter on a marker opens it.
 */
export function MeasuresSection({ infoMap, current }: { infoMap: InfoMap; current: number }) {
  const auto = useProject((s) => s.sync?.auto ?? EMPTY);
  const sort = useSyncUi((s) => s.measureSort);
  const bands = useSyncUi((s) => s.bands);
  const barFrom = useSyncUi((s) => s.barFrom);
  const barTo = useSyncUi((s) => s.barTo);
  const setUi = useSyncUi((s) => s.set);
  const { jumpTo } = useSyncActions();
  const { list: markers, bars: pendingSet } = useDisplayedMarkers();
  const byBar = useMemo(() => {
    const m = new Map<number, DisplayedMarker[]>();
    for (const d of markers) {
      const l = m.get(d.marker.measure) ?? [];
      l.push(d);
      m.set(d.marker.measure, l);
    }
    return m;
  }, [markers]);
  const marked = useMemo(() => new Set(markers.filter((d) => d.state !== "deleted").map((d) => d.marker.measure)), [markers]);
  const rows = useMemo(() => filterMeasures(auto, { sort, bands, from: barFrom, to: barTo }), [auto, sort, bands, barFrom, barTo]);
  const [active, setActive] = useState<{ row: number; cell: 0 | 1 }>({ row: 0, cell: 0 });
  const gridRef = useRef<HTMLDivElement>(null);
  const toCheck = auto.filter((a) => a.confidence < UNCERTAIN_THRESHOLD && !marked.has(a.n)).length;

  const goNext = () => {
    const n = nextUncertain(auto, marked, current);
    if (n) jumpTo({ measure: n, position: 0 });
  };
  const rowCount = rows.length;
  const activeRow = Math.min(active.row, Math.max(0, rowCount - 1));
  const activate = (row: number, cell: 0 | 1) => {
    setActive({ row, cell });
    document.getElementById(`measure-row-${rows[row]?.n}-${cell}`)?.scrollIntoView({ block: "nearest" });
  };

  return (
    <SidebarSection id="measures" title="Measures" summary={`${toCheck} to check`}>
      <div className="mb-2 flex flex-wrap items-center gap-1.5">
        <Segmented<MeasureSort>
          size="sm"
          ariaLabel="Sort measures"
          value={sort}
          onChange={(v) => setUi({ measureSort: v })}
          options={[
            { value: "order", label: "Order" },
            { value: "confidence", label: "Confidence" },
          ]}
        />
        <Button variant="secondary" size="sm" leading={<SkipForward size={12} />} onClick={goNext} disabled={toCheck === 0} title="Next uncertain bar without a marker (N)">
          Next uncertain
        </Button>
      </div>
      <div className="mb-2 flex flex-wrap items-center gap-1" role="group" aria-label="Filter by confidence">
        {CONFIDENCE_BANDS.map((b) => {
          const on = bands.has(b.id);
          return (
            <button
              key={b.id}
              type="button"
              aria-pressed={on}
              className={cx("inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[11px]", on ? "border-ink-3 bg-paper-3 text-ink" : "border-line text-ink-3")}
              onClick={() => {
                const next = new Set(bands);
                if (on) next.delete(b.id);
                else next.add(b.id);
                setUi({ bands: next });
              }}
            >
              <span className="h-2 w-2 rounded-sm" style={{ background: b.token }} aria-hidden />
              {b.label}
            </button>
          );
        })}
        <label className="ml-1 inline-flex items-center gap-1 text-[11px] text-ink-3">
          Bars
          <input
            className="h-6 w-12 rounded border border-line bg-paper px-1 tnum"
            inputMode="numeric"
            aria-label="From bar"
            value={barFrom ?? ""}
            onChange={(e) => setUi({ barFrom: e.target.value ? Number(e.target.value) || null : null })}
          />
          –
          <input
            className="h-6 w-12 rounded border border-line bg-paper px-1 tnum"
            inputMode="numeric"
            aria-label="To bar"
            value={barTo ?? ""}
            onChange={(e) => setUi({ barTo: e.target.value ? Number(e.target.value) || null : null })}
          />
        </label>
      </div>
      {rowCount === 0 ? (
        <p className="text-[12px] text-ink-3">
          No measures match.{" "}
          <button type="button" className="text-brass-3 underline" onClick={() => setUi({ bands: new Set(), barFrom: null, barTo: null })}>
            Clear filters
          </button>
        </p>
      ) : (
        <div
          ref={gridRef}
          role="grid"
          aria-label="Measures"
          aria-rowcount={rowCount}
          tabIndex={0}
          aria-activedescendant={rows[activeRow] ? `measure-row-${rows[activeRow].n}-${active.cell}` : undefined}
          data-local-keys="ArrowUp ArrowDown ArrowLeft ArrowRight Enter Home End"
          className="scroll-thin max-h-72 overflow-y-auto rounded border border-line outline-none focus-visible:ring-2 focus-visible:ring-brass"
          onKeyDown={(e) => {
            let handled = true;
            if (e.key === "ArrowDown") activate(Math.min(rowCount - 1, activeRow + 1), active.cell);
            else if (e.key === "ArrowUp") activate(Math.max(0, activeRow - 1), active.cell);
            else if (e.key === "ArrowRight") activate(activeRow, 1);
            else if (e.key === "ArrowLeft") activate(activeRow, 0);
            else if (e.key === "Home") activate(0, active.cell);
            else if (e.key === "End") activate(rowCount - 1, active.cell);
            else if (e.key === "Enter" || e.key === " ") {
              const r = rows[activeRow];
              if (!r) return;
              if (active.cell === 0) jumpTo({ measure: r.n, position: 0 });
              else document.querySelector<HTMLButtonElement>(`#measure-row-${r.n}-1 button`)?.click();
            } else handled = false;
            if (handled) {
              e.preventDefault();
              e.stopPropagation();
            }
          }}
        >
          {rows.map((a, i) => (
            <MeasureRow
              key={a.n}
              infoMap={infoMap}
              a={a}
              index={i}
              current={a.n === current}
              pending={pendingSet.has(a.n)}
              markers={byBar.get(a.n)}
              active={i === activeRow ? active.cell : null}
              onJump={() => {
                setActive({ row: i, cell: 0 });
                jumpTo({ measure: a.n, position: 0 });
              }}
              gridRef={gridRef}
            />
          ))}
        </div>
      )}
    </SidebarSection>
  );
}

const EMPTY: MeasureAlignment[] = [];

const MeasureRow = memo(function MeasureRow({
  infoMap,
  a,
  index,
  current,
  pending,
  markers,
  active,
  onJump,
  gridRef,
}: {
  infoMap: InfoMap;
  a: MeasureAlignment;
  index: number;
  current: boolean;
  pending: boolean;
  markers?: DisplayedMarker[];
  active: 0 | 1 | null;
  onJump: () => void;
  gridRef: React.RefObject<HTMLDivElement | null>;
}) {
  const band = confidenceBand(a.confidence);
  return (
    <div role="row" aria-rowindex={index + 1} className={cx("flex items-center border-b border-line/50 last:border-b-0", current && "bg-brass-soft")}>
      <div
        role="gridcell"
        id={`measure-row-${a.n}-0`}
        aria-selected={active === 0}
        className={cx("flex-1 cursor-pointer px-2 py-1 text-[12px]", active === 0 && "outline outline-2 -outline-offset-2 outline-brass/60")}
        onClick={onJump}
        data-confidence={a.confidence}
        data-pending={pending ? "true" : undefined}
      >
        <span className="tnum text-ink">Bar {barNumber(infoMap, a.n)}</span>
        <span className="tnum ml-2 inline-flex items-center gap-1 text-ink-3">
          <span className="h-2 w-2 rounded-full" style={{ background: band.token }} aria-hidden />
          {a.confidence}% {band.label}
        </span>
        {pending && <span className="ml-2 text-[11px] text-brass-3">pending</span>}
      </div>
      <div role="gridcell" id={`measure-row-${a.n}-1`} aria-selected={active === 1} className={cx("flex w-12 items-center justify-end gap-0.5 px-1.5", active === 1 && "outline outline-2 -outline-offset-2 outline-brass/60")}>
        {markers?.map((d) => (
          <MarkerIcon
            key={`${d.marker.id}:${d.state}`}
            id={d.marker.id}
            state={d.state}
            name={markerAccessibleName(infoMap, d.marker, d.state)}
            tabIndex={-1}
            onPress={(el) => useSyncUi.getState().openPopover(d.marker.id, gridRef.current ? { getBoundingClientRect: () => el.getBoundingClientRect() } : el)}
          />
        ))}
        {markers && markers.length > 0 && <span className="sr-only">{markers.length === 1 ? `has a marker${markerPosition(markers[0].marker) > 0 ? " inside the bar" : ""}` : `has ${markers.length} markers`}</span>}
      </div>
    </div>
  );
});
