"use client";

import { useMemo, useState, type RefObject } from "react";
import type { InfoMap } from "@/shared/info-map";
import { barAt, landmarks } from "@/lib/score/navigation";
import { runs } from "@/lib/score/systems";
import { barNumber } from "./bars";

/**
 * The whole piece in one strip, proportional to score time (playback order):
 * rehearsal marks, tempo changes, the bars on screen (outlined), the passage
 * being repeated, Sync markers, the start point and the playhead (moved by
 * EngravedScore). Clicking shows that place without moving playback;
 * Shift-click makes it the start point; a double click plays from there. Built from the info map only, so it scales to
 * hundreds of bars: no per-bar elements.
 */
export function ScoreRuler({
  infoMap,
  written,
  inView,
  markers,
  cue,
  range,
  headRef,
  showHead,
  onBrowse,
  onCue,
  onPlay,
}: {
  infoMap: InfoMap;
  /** written index per playback bar */
  written: number[];
  /** written bars on the systems in view */
  inView: { firstWritten: number; lastWritten: number } | null;
  markers?: Array<{ measure: number; position: number }>;
  cue: { measure: number; position: number } | null;
  /** score seconds */
  range: { start: number; end: number } | null;
  headRef: RefObject<HTMLDivElement | null>;
  showHead: boolean;
  /** show playback bar n (1-based) */
  onBrowse: (n: number) => void;
  /** make the downbeat of playback bar n the start point */
  onCue: (n: number) => void;
  /** play from playback bar n */
  onPlay: (n: number) => void;
}) {
  const ms = infoMap.measures;
  const total = infoMap.duration || ms.reduce((s, m) => s + m.duration, 0) || 1;
  const pct = (t: number) => `${Math.max(0, Math.min(100, (t / total) * 100))}%`;
  const marks = useMemo(() => landmarks(infoMap), [infoMap]);
  const [hover, setHover] = useState<{ x: number; n: number } | null>(null);

  // playback bars whose written bar is on screen (a repeat shows the passage twice)
  const boxes = useMemo(() => {
    if (!inView) return [];
    const on: number[] = [];
    written.forEach((w, k) => {
      if (w >= inView.firstWritten && w <= inView.lastWritten) on.push(k);
    });
    return runs(on).map(([a, b]) => ({ start: ms[a].startTime, end: ms[b].startTime + ms[b].duration }));
  }, [inView, written, ms]);

  const barFromEvent = (e: React.MouseEvent<HTMLDivElement>) => {
    const rect = e.currentTarget.getBoundingClientRect();
    const x = Math.max(0, Math.min(rect.width, e.clientX - rect.left));
    return { x, n: barAt(ms, (x / Math.max(1, rect.width)) * total) };
  };
  const hoverMark = hover ? marks.filter((l) => l.measure === hover.n && l.kind === "rehearsal")[0] : undefined;

  return (
    <div className="px-1 pb-2">
      <div
        className="relative h-7 cursor-pointer select-none rounded-md border border-line bg-paper-2"
        role="slider"
        aria-label="Score overview: click to show a place, Shift-click to start there, double-click to play"
        aria-valuemin={1}
        aria-valuemax={ms.length}
        aria-valuenow={inView ? (written.findIndex((w) => w === inView.firstWritten) + 1 || 1) : 1}
        aria-valuetext={inView ? `Showing bars ${inView.firstWritten + 1} to ${inView.lastWritten + 1}` : undefined}
        tabIndex={0}
        onMouseMove={(e) => setHover(barFromEvent(e))}
        onMouseLeave={() => setHover(null)}
        onClick={(e) => {
          const { n } = barFromEvent(e);
          if (e.shiftKey) onCue(n);
          else onBrowse(n);
        }}
        onDoubleClick={(e) => onPlay(barFromEvent(e).n)}
        onKeyDown={(e) => {
          if (!inView) return;
          const cur = written.findIndex((w) => w === inView.firstWritten) + 1 || 1;
          if (e.key === "ArrowRight" || e.key === "ArrowLeft") {
            e.preventDefault();
            e.stopPropagation();
            onBrowse(Math.max(1, Math.min(ms.length, cur + (e.key === "ArrowRight" ? 8 : -8))));
          } else if (e.key === "Enter") onCue(cur);
        }}
      >
        {range && <div className="absolute inset-y-0 bg-[var(--score-range)]" style={{ left: pct(range.start), width: `calc(${pct(range.end)} - ${pct(range.start)})` }} aria-hidden />}
        {boxes.map((b, i) => (
          <div key={i} className="absolute inset-y-0.5 rounded-[3px] border border-ink-3/70 bg-ink/[0.04]" style={{ left: pct(b.start), width: `max(3px, calc(${pct(b.end)} - ${pct(b.start)}))` }} aria-hidden />
        ))}
        {marks.map((l, i) => {
          const m = ms[l.measure - 1];
          if (!m) return null;
          return l.kind === "rehearsal" ? (
            <span key={i} className="absolute top-0 flex h-full items-center" style={{ left: pct(m.startTime) }} aria-hidden>
              <span className="h-full w-px bg-ink-3/60" />
              <span className="ml-0.5 rounded-[2px] border border-ink-3/60 bg-paper px-[3px] text-[9.5px] font-semibold leading-[13px] text-ink-2">{l.text}</span>
            </span>
          ) : (
            <span key={i} className="absolute bottom-0 h-2 w-px bg-brass-3/70" style={{ left: pct(m.startTime) }} title={l.text} aria-hidden />
          );
        })}
        {markers?.map((mk, i) => {
          const m = ms[mk.measure - 1];
          if (!m) return null;
          return <span key={`mk${i}`} className="absolute -top-px h-2.5 w-[2px] rounded-b-sm bg-brass" style={{ left: pct(m.startTime + mk.position * m.duration) }} aria-hidden />;
        })}
        {cue && ms[cue.measure - 1] && (
          <span
            className="absolute -top-px h-0 w-0 -translate-x-1/2 border-x-[4px] border-t-[6px] border-x-transparent border-t-ink"
            style={{ left: pct(ms[cue.measure - 1].startTime + cue.position * ms[cue.measure - 1].duration) }}
            aria-hidden
          />
        )}
        {showHead && <div ref={headRef} className="score-playhead pointer-events-none absolute -top-0.5 -bottom-0.5 w-[2px] rounded-full" style={{ left: 0 }} aria-hidden />}
        {hover && (
          <div className="pointer-events-none absolute -top-6 z-10 -translate-x-1/2 whitespace-nowrap rounded bg-ink px-1.5 py-0.5 text-[11px] text-paper" style={{ left: hover.x }}>
            Bar {barNumber(infoMap, hover.n)}
            {hoverMark ? ` · ${hoverMark.text}` : ""}
          </div>
        )}
      </div>
    </div>
  );
}
