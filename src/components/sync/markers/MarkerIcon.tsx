"use client";

import { forwardRef } from "react";
import { cx } from "@/lib/utils/format";
import type { MarkerState } from "./markerName";

/**
 * A marker pin: filled brass when applied, a dashed outline when pending, and
 * crossed out when its deletion is pending (ADR 0018). Pressing it opens the
 * marker's details.
 */
export const MarkerIcon = forwardRef<HTMLButtonElement, { state: MarkerState; name: string; id: string; size?: number; className?: string; style?: React.CSSProperties; tabIndex?: number; onPress: (el: HTMLButtonElement) => void }>(
  function MarkerIcon({ state, name, id, size = 12, className, style, tabIndex, onPress }, ref) {
    return (
      <button
        ref={ref}
        type="button"
        aria-label={name}
        data-marker-id={id}
        data-state={state}
        tabIndex={tabIndex}
        className={cx("inline-flex items-center justify-center rounded-sm focus-visible:outline-2 focus-visible:outline-brass", className)}
        style={style}
        onClick={(e) => {
          e.stopPropagation();
          onPress(e.currentTarget);
        }}
      >
        <MarkerGlyph state={state} size={size} />
      </button>
    );
  },
);

export function MarkerGlyph({ state, size = 12 }: { state: MarkerState; size?: number }) {
  return (
    <svg width={size} height={size * 1.25} viewBox="0 0 12 15" aria-hidden>
      <path
        d="M6 14.2 C6 14.2 1 8.6 1 5.6 A5 5 0 0 1 11 5.6 C11 8.6 6 14.2 6 14.2 Z"
        fill={state === "applied" ? "var(--score-marker)" : "var(--paper)"}
        stroke={state === "deleted" ? "var(--ink-3)" : state === "pending" ? "var(--marker-pending)" : "var(--score-marker)"}
        strokeWidth={1.5}
        strokeDasharray={state === "pending" ? "2 1.5" : undefined}
      />
      {state === "deleted" && <path d="M3 3 L9 9 M9 3 L3 9" stroke="var(--ink-3)" strokeWidth={1.4} />}
    </svg>
  );
}
