"use client";

import { useMemo, useRef, type KeyboardEvent, type PointerEvent } from "react";
import type { MeasureAlignment } from "@/shared/sync";
import { CONFIDENCE_BANDS, confidenceBand } from "@/shared/sync";

/**
 * Whole-piece confidence overview: one thin column per bar, colored by band,
 * with the page's one confidence legend underneath. Click or drag to pick a
 * bar; arrow keys move the selection.
 */
export function ConfidenceStrip({
  aligned,
  manual,
  current,
  selected,
  onPick,
  labelOf = String,
  pending,
  className,
  barClassName = "h-9",
}: {
  aligned: MeasureAlignment[];
  manual: Set<number>;
  /** bars holding a marker change that a recompute has not applied (hatched) */
  pending?: Set<number>;
  barClassName?: string;
  current: number;
  selected: number | null;
  onPick: (measure: number) => void;
  /** "41 (33)" for bars whose printed number differs */
  labelOf?: (measure: number) => string;
  className?: string;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const n = aligned.length;
  const cols = useMemo(() => aligned.map((a) => ({ n: a.n, token: confidenceBand(a.confidence).token, c: a.confidence })), [aligned]);
  const focus = selected ?? current;
  const pick = (e: PointerEvent) => {
    const r = ref.current!.getBoundingClientRect();
    const i = Math.floor(((e.clientX - r.left) / r.width) * n);
    onPick(Math.max(1, Math.min(n, i + 1)));
  };
  const onKeyDown = (e: KeyboardEvent) => {
    const step = e.shiftKey ? 10 : 1;
    let next: number | null = null;
    if (e.key === "ArrowLeft") next = focus - step;
    else if (e.key === "ArrowRight") next = focus + step;
    else if (e.key === "Home") next = 1;
    else if (e.key === "End") next = n;
    if (next === null) return;
    // keep the transport's arrow-key seeking from firing too
    e.preventDefault();
    e.stopPropagation();
    onPick(Math.max(1, Math.min(n, next)));
  };
  const focusConf = aligned[focus - 1]?.confidence;

  return (
    <div className={className}>
      <div
        ref={ref}
        className={`focus-round relative ${barClassName} w-full cursor-crosshair overflow-hidden rounded-[var(--radius-sm)] border border-line bg-paper-3`}
        onPointerDown={pick}
        onPointerMove={(e) => e.buttons === 1 && pick(e)}
        onKeyDown={onKeyDown}
        tabIndex={0}
        role="slider"
        aria-label="Confidence by bar"
        aria-valuemin={1}
        aria-valuemax={n}
        aria-valuenow={focus}
        aria-valuetext={focusConf !== undefined ? `Bar ${labelOf(focus)}, ${focusConf}%` : undefined}
      >
        <svg className="absolute inset-0 h-full w-full" viewBox={`0 0 ${Math.max(1, n)} 10`} preserveAspectRatio="none" aria-hidden>
          {cols.map((c, i) => (
            <rect key={c.n} x={i} y={10 - Math.max(2, (c.c / 100) * 10)} width={1} height={Math.max(2, (c.c / 100) * 10)} fill={c.token} opacity={manual.has(c.n) ? 1 : 0.75} />
          ))}
          {[...manual].map((m) => (
            <rect key={m} x={m - 1} y={0} width={1} height={10} fill="var(--ink)" opacity={0.6} />
          ))}
        </svg>
        {pending &&
          n > 0 &&
          [...pending].map((b) => (
            <div key={`p${b}`} className="pending-hatch pointer-events-none absolute top-0 bottom-0" style={{ left: `${((b - 1) / n) * 100}%`, width: `max(3px, ${100 / n}%)` }} data-pending-bar={b} />
          ))}
        {selected && n > 0 && (
          <div
            className="pointer-events-none absolute top-0 bottom-0 border-x border-ink/60 bg-ink/5"
            style={{ left: `${((selected - 1) / n) * 100}%`, width: `${Math.max(0.4, 100 / n)}%` }}
          />
        )}
        {n > 0 && <div className="pointer-events-none absolute top-0 bottom-0 w-px bg-brass-2 shadow-[0_0_6px_var(--brass-glow)]" style={{ left: `${((current - 0.5) / n) * 100}%` }} />}
      </div>
      <div className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1 text-[12px] text-ink-3" aria-label="Confidence legend">
        {CONFIDENCE_BANDS.map((b) => (
          <span key={b.id} className="inline-flex items-center gap-1.5">
            <span className="h-2.5 w-2.5 rounded-sm" style={{ background: b.token }} aria-hidden />
            {b.label} <span className="text-ink-4">{b.description}</span>
          </span>
        ))}
        <span className="inline-flex items-center gap-1.5">
          <span className="h-2.5 w-[2px] bg-ink" aria-hidden /> Marker
        </span>
        {pending && (
          <span className="inline-flex items-center gap-1.5">
            <span className="pending-hatch h-2.5 w-3 rounded-sm" aria-hidden /> Pending marker: recompute to apply
          </span>
        )}
      </div>
    </div>
  );
}
