"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { ChevronDown, Crosshair, ZoomIn, ZoomOut } from "lucide-react";
import type { InfoMap, Instrument } from "@/shared/info-map";
import type { DisplaySettings } from "@/shared/project-file";
import { BRAVURA_DYNAMICS, BRIGHTNESS_LADDER, DYNAMIC_LABELS, type Dynamic } from "@/shared/dynamics";
import { SECTION_ORDER } from "@/shared/sections";
import { cachedSegments, type ActivitySegment } from "@/lib/score/segments";
import { partColor } from "@/lib/visualizer";
import { usePlayback } from "@/lib/store/playback";
import { scoreToRecordingTime, useProjectTiming } from "@/lib/store/useProjectTiming";
import { cx } from "@/lib/utils/format";
import { barNumber } from "./bars";

/**
 * One lane per part over the score's timeline: bars where the part plays,
 * tinted with its display color, brighter for louder written dynamics, with
 * the dynamic marked where it changes. Built from the info map only; it never
 * reads the recording (design principle 1). Click a lane to seek, click a name
 * to select the part.
 */

export const LANE_H = 30;
export const NAME_W = 148;
const RULER_H = 22;
const ZOOMS = [12, 20, 32, 48, 72, 110];

export interface LaneRow {
  inst: Instrument;
  segments: ActivitySegment[];
  /** segments where the written dynamic differs from the previous one (glyph positions) */
  changes: ActivitySegment[];
}

/** Rows in section order, matching the instruments panel. */
export function laneRows(infoMap: InfoMap, display: DisplaySettings): LaneRow[] {
  const rows: LaneRow[] = [];
  for (const section of SECTION_ORDER) {
    for (const inst of infoMap.instruments) {
      if ((display.sections[inst.id] ?? inst.section) !== section) continue;
      const segments = cachedSegments(inst);
      const changes: ActivitySegment[] = [];
      let prev: Dynamic | null = null;
      for (const s of segments) {
        if (s.dynamic !== prev) changes.push(s);
        prev = s.dynamic;
      }
      rows.push({ inst, segments, changes });
    }
  }
  return rows;
}

/** Lane fill opacity: the same pp → fff ladder the stage uses for brightness. */
export function laneOpacity(d: Dynamic): number {
  return 0.25 + 0.75 * BRIGHTNESS_LADDER[d];
}

/** Pixels per second that give the average bar roughly `barPx` pixels. */
function defaultZoom(infoMap: InfoMap): number {
  const n = Math.max(1, infoMap.measures.length);
  const avgBar = infoMap.duration / n || 2;
  const target = 84 / avgBar;
  return ZOOMS.reduce((best, z) => (Math.abs(z - target) < Math.abs(best - target) ? z : best), ZOOMS[0]);
}

export function PartLanes({
  infoMap,
  display,
  selectedId,
  onSelect,
  onCollapse,
  className,
}: {
  infoMap: InfoMap;
  display: DisplaySettings;
  selectedId: string | null;
  onSelect: (id: string) => void;
  onCollapse?: () => void;
  className?: string;
}) {
  const { clock, measureAt, aligned } = useProjectTiming();
  const bar = usePlayback((s) => measureAt(s.time));
  const [pxPerSec, setPxPerSec] = useState(() => defaultZoom(infoMap));
  const [follow, setFollow] = useState(true);
  const scrollRef = useRef<HTMLDivElement>(null);
  const headRef = useRef<HTMLDivElement>(null);

  const rows = useMemo(() => laneRows(infoMap, display), [infoMap, display]);
  const visible = useMemo(() => new Set(display.visibleParts), [display.visibleParts]);
  const width = Math.ceil(infoMap.duration * pxPerSec) + 24;
  const height = rows.length * LANE_H;

  // playhead: moved every frame without re-rendering; follows while playing
  const followRef = useRef(follow);
  useEffect(() => {
    followRef.current = follow;
  }, [follow]);
  useEffect(() => {
    let raf = 0;
    const loop = () => {
      raf = requestAnimationFrame(loop);
      const x = clock() * pxPerSec;
      const head = headRef.current;
      if (head) head.style.transform = `translateX(${x}px)`;
      const sc = scrollRef.current;
      if (sc && followRef.current && usePlayback.getState().playing) {
        const viewW = sc.clientWidth - NAME_W;
        const rel = x - sc.scrollLeft;
        if (rel < 0 || rel > viewW * 0.85) sc.scrollLeft = Math.max(0, x - viewW * 0.15);
      }
    };
    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
  }, [clock, pxPerSec]);

  const seekAt = (clientX: number, target: HTMLElement) => {
    const r = target.getBoundingClientRect();
    const scoreT = Math.max(0, Math.min(infoMap.duration, (clientX - r.left) / pxPerSec));
    usePlayback.getState().seek(aligned.length > 0 ? scoreToRecordingTime(infoMap, aligned, scoreT) : scoreT);
  };

  const zoom = (dir: 1 | -1) => {
    const i = ZOOMS.indexOf(pxPerSec);
    const next = ZOOMS[Math.max(0, Math.min(ZOOMS.length - 1, (i < 0 ? 2 : i) + dir))];
    const sc = scrollRef.current;
    // keep the playhead where it is on screen
    if (sc) {
      const t = clock();
      const onScreen = t * pxPerSec - sc.scrollLeft;
      requestAnimationFrame(() => {
        sc.scrollLeft = Math.max(0, t * next - onScreen);
      });
    }
    setPxPerSec(next);
  };

  const current = infoMap.measures[bar - 1];

  // the lanes themselves only change with the layout, colors, selection or zoom,
  // not with the bar or the clock
  const laneArt = useMemo(
    () => (
      <>
        {infoMap.measures.map((m) => (
          <line key={m.number} x1={m.startTime * pxPerSec + 0.5} x2={m.startTime * pxPerSec + 0.5} y1={0} y2={height} stroke="var(--line)" />
        ))}
        {rows.map(({ inst, segments, changes }, i) => {
          const y = i * LANE_H;
          const color = partColor(infoMap, display, inst.id);
          const on = visible.has(inst.id);
          return (
            <g key={inst.id} opacity={on ? 1 : 0.3}>
              {selectedId === inst.id && <rect x={0} y={y} width={width} height={LANE_H} fill="var(--brass-soft)" />}
              <line x1={0} x2={width} y1={y + LANE_H - 0.5} y2={y + LANE_H - 0.5} stroke="var(--line)" strokeOpacity={0.6} />
              {segments.map((s, j) => (
                <rect
                  key={j}
                  x={s.start * pxPerSec}
                  y={y + 7}
                  width={Math.max(1, (s.end - s.start) * pxPerSec)}
                  height={LANE_H - 14}
                  rx={2}
                  fill={color}
                  fillOpacity={laneOpacity(s.dynamic)}
                />
              ))}
              {pxPerSec >= 20 &&
                changes.map((s, j) => (
                  <text key={`d${j}`} x={s.start * pxPerSec + 3} y={y + LANE_H / 2 + 4} fontSize={13} className="font-music" fill="var(--stage)" pointerEvents="none">
                    <title>{DYNAMIC_LABELS[s.dynamic]}</title>
                    {BRAVURA_DYNAMICS[s.dynamic]}
                  </text>
                ))}
            </g>
          );
        })}
      </>
    ),
    [infoMap, display, rows, visible, selectedId, pxPerSec, width, height],
  );

  return (
    <section className={cx("flex min-h-0 flex-col bg-paper", className)} aria-labelledby="lanes-title">
      <div className="flex h-9 shrink-0 items-center gap-3 border-b border-line px-4">
        <h2 id="lanes-title" className="text-[12px] font-semibold text-ink">
          Part lanes
        </h2>
        <span className="tnum hidden text-[11px] text-ink-3 sm:inline">
          Bar {barNumber(infoMap, bar)} of {infoMap.measures.length} · from the score
        </span>
        <div className="ml-auto flex items-center gap-0.5">
          <LaneButton label="Zoom out" onClick={() => zoom(-1)} disabled={pxPerSec === ZOOMS[0]}>
            <ZoomOut size={14} aria-hidden />
          </LaneButton>
          <LaneButton label="Zoom in" onClick={() => zoom(1)} disabled={pxPerSec === ZOOMS[ZOOMS.length - 1]}>
            <ZoomIn size={14} aria-hidden />
          </LaneButton>
          <LaneButton label="Follow playback" pressed={follow} onClick={() => setFollow((f) => !f)}>
            <Crosshair size={14} aria-hidden />
          </LaneButton>
          {onCollapse && (
            <LaneButton label="Hide part lanes" onClick={onCollapse}>
              <ChevronDown size={14} aria-hidden />
            </LaneButton>
          )}
        </div>
      </div>

      <div ref={scrollRef} className="scroll-thin relative min-h-0 flex-1 overflow-auto" data-testid="part-lanes">
        <div className="relative" style={{ width: NAME_W + width, height: RULER_H + height }}>
          {/* ruler */}
          <div className="sticky top-0 z-20 flex border-b border-line bg-paper-3" style={{ height: RULER_H }}>
            <div className="sticky left-0 z-30 flex shrink-0 items-center border-r border-line bg-paper-3 px-3 text-[10.5px] text-ink-3" style={{ width: NAME_W }}>
              Part
            </div>
            <svg
              width={width}
              height={RULER_H}
              className="shrink-0 cursor-pointer"
              onClick={(e) => seekAt(e.clientX, e.currentTarget as unknown as HTMLElement)}
              role="presentation"
            >
              {current && <rect x={current.startTime * pxPerSec} y={0} width={current.duration * pxPerSec} height={RULER_H} fill="var(--brass-soft)" />}
              {infoMap.measures.map((m) => {
                const x = m.startTime * pxPerSec;
                const every = pxPerSec * (m.duration || 1) < 28 ? 4 : 1;
                const labelled = (m.number - 1) % every === 0;
                return (
                  <g key={m.number}>
                    <line x1={x + 0.5} x2={x + 0.5} y1={labelled ? 6 : 14} y2={RULER_H} stroke="var(--line-strong)" />
                    {labelled && (
                      <text x={x + 4} y={14} fontSize={10} fill={m.number === bar ? "var(--brass-3)" : "var(--ink-3)"} fontWeight={m.number === bar ? 600 : 400}>
                        {barNumber(infoMap, m.number)}
                      </text>
                    )}
                  </g>
                );
              })}
            </svg>
          </div>

          <div className="flex">
            {/* names */}
            <ul className="sticky left-0 z-10 shrink-0 border-r border-line bg-paper" style={{ width: NAME_W }} aria-label="Parts">
              {rows.map(({ inst }) => {
                const on = visible.has(inst.id);
                const sel = selectedId === inst.id;
                return (
                  <li key={inst.id} style={{ height: LANE_H }} className="border-b border-line/60">
                    <button
                      type="button"
                      onClick={() => onSelect(inst.id)}
                      aria-pressed={sel}
                      className={cx("flex h-full w-full items-center gap-2 px-3 text-left text-[11.5px]", sel ? "bg-brass-soft font-semibold text-brass-3" : "text-ink-2 hover:bg-paper-3", !on && "opacity-50")}
                    >
                      <span className="h-2 w-2 shrink-0 rounded-full" style={{ background: partColor(infoMap, display, inst.id) }} aria-hidden />
                      <span className="truncate">{inst.name}</span>
                      {!on && <span className="ml-auto text-[10px] font-normal text-ink-3">Hidden</span>}
                    </button>
                  </li>
                );
              })}
            </ul>

            {/* lanes */}
            <div className="relative shrink-0" style={{ width, height }}>
              <svg width={width} height={height} className="absolute inset-0 cursor-pointer" onClick={(e) => seekAt(e.clientX, e.currentTarget as unknown as HTMLElement)} role="presentation">
                {current && <rect x={current.startTime * pxPerSec} y={0} width={current.duration * pxPerSec} height={height} fill="var(--brass-soft)" opacity={0.6} />}
                {laneArt}
              </svg>
            </div>
          </div>

          {/* playhead over ruler and lanes */}
          <div className="pointer-events-none absolute top-0 z-[5]" style={{ left: NAME_W, height: RULER_H + height }} aria-hidden>
            <div ref={headRef} className="absolute top-0 h-full w-px bg-brass will-change-transform">
              <span className="absolute -left-[4px] top-0 h-2 w-[9px] rounded-b-[2px] bg-brass" />
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}

function LaneButton({ label, onClick, disabled, pressed, children }: { label: string; onClick: () => void; disabled?: boolean; pressed?: boolean; children: React.ReactNode }) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      aria-pressed={pressed}
      onClick={onClick}
      disabled={disabled}
      className={cx(
        "grid h-6 w-6 place-items-center rounded-[var(--radius-sm)] text-ink-3 hover:bg-paper-3 hover:text-ink disabled:pointer-events-none disabled:opacity-40",
        pressed && "bg-brass-soft text-brass-3",
      )}
    >
      {children}
    </button>
  );
}
