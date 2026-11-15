"use client";

import { useRef, useState, type KeyboardEvent, type PointerEvent } from "react";
import { cx } from "@/lib/utils/format";

const KEY_STEP = 16;
const KEY_STEP_LARGE = 64;

/**
 * A draggable border between two docked panels. It sits over the panel's
 * hairline (the caller positions it, e.g. `right-0 translate-x-1/2`) and
 * resizes one panel, in px:
 * - drag it; `onLive` runs on every move (cheap updates, e.g. a CSS
 *   variable) and `onCommit` once on release;
 * - or focus it and use the arrow keys (Shift for bigger steps), Home/End
 *   for the limits; each press commits;
 * - double-click, or Enter, resets the panel (`onReset`).
 * `orientation` is the line's: "vertical" resizes a width, "horizontal" a
 * height. `invert` grows the panel when dragging left or up.
 */
export function Splitter({
  orientation,
  value,
  min,
  max,
  onLive,
  onCommit,
  onReset,
  label,
  controls,
  invert = false,
  className,
}: {
  orientation: "vertical" | "horizontal";
  value: number;
  min: number;
  max: number;
  onLive: (px: number) => void;
  onCommit: (px: number) => void;
  onReset?: () => void;
  label: string;
  /** id of the panel it resizes */
  controls?: string;
  invert?: boolean;
  className?: string;
}) {
  const vertical = orientation === "vertical";
  const sign = invert ? -1 : 1;
  const drag = useRef<{ start: number; base: number; last: number } | null>(null);
  const [active, setActive] = useState(false);
  const clamp = (v: number) => Math.round(Math.max(min, Math.min(max, v)));
  const at = (e: PointerEvent) => (vertical ? e.clientX : e.clientY);
  const cursorClass = vertical ? "resizing-col" : "resizing-row";

  const end = () => {
    const d = drag.current;
    if (!d) return;
    drag.current = null;
    setActive(false);
    document.documentElement.classList.remove(cursorClass);
    onCommit(d.last);
  };

  const onKeyDown = (e: KeyboardEvent) => {
    const step = e.shiftKey ? KEY_STEP_LARGE : KEY_STEP;
    const grow = vertical ? (invert ? "ArrowLeft" : "ArrowRight") : invert ? "ArrowUp" : "ArrowDown";
    const shrink = vertical ? (invert ? "ArrowRight" : "ArrowLeft") : invert ? "ArrowDown" : "ArrowUp";
    let next: number | null = null;
    if (e.key === grow) next = clamp(value + step);
    else if (e.key === shrink) next = clamp(value - step);
    else if (e.key === "Home") next = min;
    else if (e.key === "End") next = max;
    else if (e.key === "Enter" && onReset) {
      // Enter is also "play from the start point" in the playback shortcuts
      e.preventDefault();
      e.stopPropagation();
      onReset();
      return;
    }
    if (next === null) return;
    // keep the keys from also reaching the playback shortcuts (seek, go to start)
    e.preventDefault();
    e.stopPropagation();
    onCommit(next);
  };

  return (
    <div
      role="separator"
      aria-orientation={orientation}
      aria-label={label}
      aria-controls={controls}
      aria-valuenow={Math.round(value)}
      aria-valuemin={Math.round(min)}
      aria-valuemax={Math.round(max)}
      tabIndex={0}
      title={`${label}: drag, or double-click to reset`}
      data-splitter={controls}
      className={cx(
        "group absolute z-20 touch-none select-none outline-none",
        vertical ? "inset-y-0 w-[7px] cursor-col-resize" : "inset-x-0 h-[7px] cursor-row-resize",
        className,
      )}
      onPointerDown={(e) => {
        if (e.button !== 0) return;
        e.preventDefault();
        e.currentTarget.setPointerCapture(e.pointerId);
        drag.current = { start: at(e), base: value, last: value };
        setActive(true);
        document.documentElement.classList.add(cursorClass);
      }}
      onPointerMove={(e) => {
        const d = drag.current;
        if (!d) return;
        const next = clamp(d.base + sign * (at(e) - d.start));
        if (next === d.last) return;
        d.last = next;
        onLive(next);
      }}
      onPointerUp={end}
      onPointerCancel={end}
      onLostPointerCapture={end}
      onDoubleClick={onReset}
      onKeyDown={onKeyDown}
    >
      <span
        aria-hidden
        className={cx(
          "pointer-events-none absolute transition-colors group-hover:bg-brass/40 group-focus-visible:bg-brass",
          vertical ? "inset-y-0 left-[2px] w-[3px]" : "inset-x-0 top-[2px] h-[3px]",
          active && "bg-brass group-hover:bg-brass",
        )}
      />
    </div>
  );
}
