"use client";

import { useCallback, useId, useMemo, useRef } from "react";
import { cx } from "@/lib/utils/format";

export function Waveform({
  peaks,
  progress,
  onSeek,
  height = 36,
  className,
  onStage,
  markers,
  bands,
  interactive = true,
}: {
  peaks: number[];
  /** 0–1 */
  progress: number;
  onSeek?: (fraction: number) => void;
  height?: number;
  className?: string;
  onStage?: boolean;
  /** vertical marker lines at fractions, e.g. manual sync markers */
  markers?: Array<{ at: number; color?: string; strong?: boolean }>;
  /** colored ranges, e.g. confidence bands */
  bands?: Array<{ from: number; to: number; color: string }>;
  interactive?: boolean;
}) {
  const id = useId();
  const ref = useRef<HTMLDivElement>(null);
  const n = peaks.length;
  // The bars only change with the peaks. Built once as elements, React skips
  // them on the per-frame re-render while playing; only the clip width moves.
  const bars = useMemo(
    () =>
      peaks.map((p, i) => {
        const h = Math.max(6, p * 100);
        return <rect key={i} x={(i / n) * 100} y={(100 - h) / 2} width={(100 / n) * 0.62} height={h} rx="0.3" />;
      }),
    [peaks, n],
  );

  const seek = useCallback(
    (e: React.PointerEvent) => {
      if (!onSeek || !ref.current || !interactive) return;
      const r = ref.current.getBoundingClientRect();
      onSeek(Math.max(0, Math.min(1, (e.clientX - r.left) / r.width)));
    },
    [onSeek, interactive],
  );

  return (
    <div
      ref={ref}
      className={cx("relative w-full select-none touch-none", interactive && "cursor-pointer", className)}
      style={{ height }}
      onPointerDown={(e) => {
        seek(e);
        (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
      }}
      onPointerMove={(e) => e.buttons === 1 && seek(e)}
      role={interactive ? "slider" : undefined}
      aria-valuenow={Math.round(progress * 100)}
      aria-label="Position"
    >
      <svg width="100%" height="100%" viewBox="0 0 100 100" preserveAspectRatio="none" aria-hidden>
        <defs>
          <clipPath id={`${id}-played`}>
            <rect x="0" y="0" width={progress * 100} height="100" />
          </clipPath>
        </defs>
        {bands?.map((b, i) => (
          <rect key={i} x={b.from * 100} y="0" width={(b.to - b.from) * 100} height="100" fill={b.color} opacity="0.18" />
        ))}
        <g fill={onStage ? "var(--stage-text)" : "var(--ink)"} fillOpacity={onStage ? 0.22 : 0.16}>
          {bars}
        </g>
        <g fill="var(--brass)" clipPath={`url(#${id}-played)`}>
          {bars}
        </g>
        {markers?.map((m, i) => (
          <rect key={i} x={m.at * 100 - 0.12} y="0" width={m.strong ? 0.35 : 0.22} height="100" fill={m.color ?? "var(--ink)"} opacity={m.strong ? 1 : 0.7} />
        ))}
      </svg>
      <div
        className="pointer-events-none absolute top-0 bottom-0 w-px bg-brass-2 shadow-[0_0_6px_var(--brass-glow)]"
        style={{ left: `${progress * 100}%` }}
      />
    </div>
  );
}
