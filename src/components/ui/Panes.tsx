"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";
import { ChevronDown, ChevronUp } from "lucide-react";
import { cx } from "@/lib/utils/format";

export interface PaneSpec<Id extends string> {
  id: Id;
  title: string;
  /** smallest expanded height, px */
  min: number;
  /** shown on the minimized strip (e.g. the selection) */
  summary?: ReactNode;
  children: ReactNode;
}

/** height of a minimized section */
const STRIP = 22;
/** the dividing line's hit area (the line itself is 1 px) */
const SEP = 7;
const KEY_STEP = 0.04;

/**
 * Sections stacked in one box, divided by single lines (ADR 0017; owner: no
 * buffer, no title bars). Drag a line, or focus it and use the arrow keys
 * (Home/End go to the limits, Enter minimizes or restores the section below).
 * Each section has a small minimize button in its top corner; a minimized
 * section is a thin strip with its name that restores it, and its room goes
 * to the others. The last open section cannot be minimized. Sizes are shares
 * of the height; the caller stores them on user changes only.
 */
export function Panes<Id extends string>({
  panes,
  sizes,
  collapsed,
  onResize,
  onToggle,
  className,
}: {
  panes: PaneSpec<Id>[];
  sizes: Record<Id, number>;
  collapsed: Id[];
  /** new shares after a drag or key resize (called on release) */
  onResize: (sizes: Record<Id, number>) => void;
  onToggle: (id: Id) => void;
  className?: string;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [height, setHeight] = useState(0);
  const [live, setLive] = useState<Record<Id, number> | null>(null);
  const shares = live ?? sizes;

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setHeight(el.clientHeight));
    ro.observe(el);
    setHeight(el.clientHeight);
    return () => ro.disconnect();
  }, []);

  const isOpen = (id: Id) => !collapsed.includes(id);
  const open = panes.filter((p) => isOpen(p.id));
  const fixed = (panes.length - open.length) * STRIP + (panes.length - 1) * 1;
  const room = Math.max(0, height - fixed);
  const total = open.reduce((s, p) => s + shares[p.id], 0) || 1;
  const px = (id: Id) => (shares[id] / total) * room;

  /** move the boundary below pane `a` (and above the next open pane) by `dy` px */
  const shift = (base: Record<Id, number>, a: Id, b: Id, dy: number): Record<Id, number> => {
    const perPx = total / Math.max(1, room);
    const minA = panes.find((p) => p.id === a)!.min * perPx;
    const minB = panes.find((p) => p.id === b)!.min * perPx;
    const sum = base[a] + base[b];
    const nextA = Math.max(Math.max(0.02, Math.min(minA, sum / 2)), Math.min(sum - Math.max(0.02, Math.min(minB, sum / 2)), base[a] + dy * perPx));
    return { ...base, [a]: nextA, [b]: sum - nextA };
  };

  const neighbours = (i: number): [Id, Id] | null => {
    const above = [...panes.slice(0, i + 1)].reverse().find((p) => isOpen(p.id));
    const below = panes.slice(i + 1).find((p) => isOpen(p.id));
    return above && below ? [above.id, below.id] : null;
  };

  return (
    <div ref={ref} className={cx("flex h-full min-h-0 flex-col", className)}>
      {panes.map((p, i) => {
        const openNow = isOpen(p.id);
        const canCollapse = !openNow || open.length > 1;
        const pair = i < panes.length - 1 ? neighbours(i) : null;
        return (
          <div key={p.id} className="contents">
            {openNow ? (
              <section className="group/pane relative min-h-0 overflow-hidden" style={{ height: px(p.id), flex: "none" }} role="region" aria-label={p.title} id={`pane-${p.id}`}>
                {p.children}
                {canCollapse && (
                  <button
                    type="button"
                    className="absolute right-1 top-1 z-30 rounded p-0.5 text-ink-4 opacity-60 hover:bg-paper-3 hover:text-ink hover:opacity-100 focus-visible:opacity-100 group-hover/pane:opacity-100"
                    onClick={() => onToggle(p.id)}
                    aria-label={`Minimize ${p.title.toLowerCase()}`}
                    title={`Minimize ${p.title.toLowerCase()}`}
                    data-pane-toggle={p.id}
                  >
                    <ChevronUp size={12} />
                  </button>
                )}
              </section>
            ) : (
              <button
                type="button"
                className="flex shrink-0 items-center gap-1.5 bg-paper-2 px-2 text-left text-[11px] text-ink-3 hover:text-ink"
                style={{ height: STRIP }}
                onClick={() => onToggle(p.id)}
                aria-label={`Restore ${p.title.toLowerCase()}`}
                aria-expanded={false}
                data-pane-toggle={p.id}
              >
                <ChevronDown size={12} aria-hidden />
                {p.title}
                {p.summary && <span className="truncate text-ink-4">· {p.summary}</span>}
              </button>
            )}
            {i < panes.length - 1 && (
              <div
                role="separator"
                aria-orientation="horizontal"
                aria-label={`Resize ${p.title.toLowerCase()} and ${panes[i + 1].title.toLowerCase()}`}
                aria-valuenow={pair ? Math.round((shares[pair[0]] / total) * 100) : undefined}
                aria-valuemin={0}
                aria-valuemax={100}
                tabIndex={pair ? 0 : -1}
                className={cx("group relative z-20 h-px shrink-0 bg-line outline-none", pair && "cursor-row-resize focus-visible:h-[3px] focus-visible:bg-brass")}
                onKeyDown={(e) => {
                  if (!pair) return;
                  const step = KEY_STEP * room;
                  let next: Record<Id, number> | null = null;
                  if (e.key === "ArrowUp") next = shift(shares, pair[0], pair[1], -step);
                  else if (e.key === "ArrowDown") next = shift(shares, pair[0], pair[1], step);
                  else if (e.key === "Home") next = shift(shares, pair[0], pair[1], -room);
                  else if (e.key === "End") next = shift(shares, pair[0], pair[1], room);
                  else if (e.key === "Enter") {
                    e.preventDefault();
                    onToggle(pair[1]);
                    return;
                  }
                  if (!next) return;
                  e.preventDefault();
                  e.stopPropagation();
                  onResize(next);
                }}
              >
                {pair && (
                  <span
                    className="absolute inset-x-0 block group-hover:bg-brass/30"
                    style={{ top: -(SEP - 1) / 2, height: SEP }}
                    onPointerDown={(e) => {
                      e.preventDefault();
                      const start = e.clientY;
                      const base = { ...shares };
                      let last = base;
                      const move = (ev: PointerEvent) => {
                        last = shift(base, pair[0], pair[1], ev.clientY - start);
                        setLive(last);
                      };
                      const up = () => {
                        window.removeEventListener("pointermove", move);
                        window.removeEventListener("pointerup", up);
                        setLive(null);
                        onResize(last);
                      };
                      window.addEventListener("pointermove", move);
                      window.addEventListener("pointerup", up);
                    }}
                    aria-hidden
                  />
                )}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}
