"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { InfoMap } from "@/shared/info-map";
import type { DisplaySettings } from "@/shared/project-file";
import type { Dynamic } from "@/shared/dynamics";
import { usePlayback } from "@/lib/store/playback";
import { Canvas2DGlowRenderer, FrameEngine, buildScene, computeLabels, placeLabels, type GlowRenderer, type StageLabel } from "@/lib/visualizer";
import { cx } from "@/lib/utils/format";
import { Dyn } from "@/components/music/Dyn";
import { LadderDots } from "@/components/music/DynamicLegend";

export type { StageLabel } from "@/lib/visualizer";

export interface StageProps {
  infoMap: InfoMap;
  display: DisplaySettings;
  /** seconds; default reads the playback store */
  clock?: () => number;
  className?: string;
  /** customize mode: drag glows, click to select */
  interactive?: boolean;
  selectedId?: string | null;
  onSelect?: (id: string | null) => void;
  onMove?: (id: string, pos: { x: number; y: number }) => void;
  /** a drag started / ended (Customize groups the moves into one undo step) */
  onMoveStart?: (id: string) => void;
  onMoveEnd?: (id: string) => void;
  /** select only; dragging is off (the editor's "Lock layout") */
  locked?: boolean;
  /** accessible name; with `interactive` the stage is focusable so the editor can scope arrow-key nudging to it */
  ariaLabel?: string;
  /** show a constant mid level for every visible part (Customize when paused) */
  previewAll?: boolean;
  showLegend?: boolean;
  showSeating?: boolean;
  onMeasure?: (measure: number) => void;
  /** throttled (~10 Hz) per-part frame data for side panels */
  onFrame?: (parts: Array<{ id: string; playing: boolean; dynamic: Dynamic; level: number }>) => void;
  /** force label mode */
  labelMode?: DisplaySettings["labelMode"] | "none";
}

const LABEL_HZ = 10;

export function Stage({
  infoMap,
  display,
  clock,
  className,
  interactive,
  selectedId,
  onSelect,
  onMove,
  onMoveStart,
  onMoveEnd,
  locked,
  ariaLabel,
  previewAll,
  showLegend,
  showSeating = true,
  onMeasure,
  onFrame,
  labelMode,
}: StageProps) {
  const wrapRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const rendererRef = useRef<GlowRenderer | null>(null);
  const engineRef = useRef<FrameEngine | null>(null);
  const displayRef = useRef(display);
  const [labels, setLabels] = useState<StageLabel[]>([]);
  const [size, setSize] = useState({ w: 0, h: 0 });
  const mode = labelMode ?? (display.showLabels ? display.labelMode : "none");
  const propsRef = useRef({ clock, interactive, selectedId, previewAll, showSeating, onMeasure, onFrame, mode });
  useEffect(() => {
    displayRef.current = display;
    propsRef.current = { clock, interactive, selectedId, previewAll, showSeating, onMeasure, onFrame, mode };
  });

  useEffect(() => {
    engineRef.current = new FrameEngine(infoMap);
  }, [infoMap]);

  // mount renderer + resize
  useEffect(() => {
    const canvas = canvasRef.current;
    const wrap = wrapRef.current;
    if (!canvas || !wrap) return;
    const renderer = new Canvas2DGlowRenderer();
    renderer.mount(canvas);
    rendererRef.current = renderer;
    const fit = () => {
      const r = wrap.getBoundingClientRect();
      renderer.resize(r.width, r.height, window.devicePixelRatio || 1);
      setSize({ w: r.width, h: r.height });
    };
    const ro = new ResizeObserver(fit);
    ro.observe(wrap);
    // the renderer reads the stage tokens on resize; re-read them when ThemeSync switches Direction A/B
    const themeObserver = new MutationObserver(fit);
    themeObserver.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });
    return () => {
      ro.disconnect();
      themeObserver.disconnect();
      renderer.destroy();
      rendererRef.current = null;
    };
  }, []);

  // render loop
  useEffect(() => {
    let raf = 0;
    let last = performance.now();
    let labelAt = 0;
    let lastMeasure = -1;
    const loop = (now: number) => {
      raf = requestAnimationFrame(loop);
      const renderer = rendererRef.current;
      const engine = engineRef.current;
      if (!renderer || !engine) return;
      const p = propsRef.current;
      const d = displayRef.current;
      const t = p.clock ? p.clock() : usePlayback.getState().time;
      const dt = now - last;
      last = now;
      const frame = engine.compute(t, dt, d.reducedMotion);
      if (p.onMeasure && frame.measure !== lastMeasure) {
        lastMeasure = frame.measure;
        p.onMeasure(frame.measure);
      }
      const scene = buildScene(infoMap, d, frame, {
        showSeating: p.showSeating,
        selectedId: p.selectedId,
        forceLevel: p.previewAll ? 0.55 : undefined,
      });
      renderer.render(scene);
      if (now - labelAt > 1000 / LABEL_HZ) {
        labelAt = now;
        if (p.mode !== "none") setLabels(computeLabels(infoMap, d, frame.parts, p.mode, p.previewAll));
        p.onFrame?.(frame.parts);
      }
    };
    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
  }, [infoMap]);

  // dragging
  const dragRef = useRef<{ id: string; ox: number; oy: number } | null>(null);
  const hit = useCallback(
    (nx: number, ny: number) => {
      const d = displayRef.current;
      let best: string | null = null;
      let bestD = 0.09;
      for (const inst of infoMap.instruments) {
        if (!d.visibleParts.includes(inst.id)) continue;
        const pos = d.positions[inst.id];
        if (!pos) continue;
        const dist = Math.hypot((pos.x - nx) * 1.6, pos.y - ny);
        if (dist < bestD) {
          bestD = dist;
          best = inst.id;
        }
      }
      return best;
    },
    [infoMap],
  );

  const toNorm = (e: React.PointerEvent) => {
    const r = wrapRef.current!.getBoundingClientRect();
    return { x: (e.clientX - r.left) / r.width, y: (e.clientY - r.top) / r.height };
  };

  const layout = useMemo(() => placeLabels(labels, size.w, size.h), [labels, size]);

  const endDrag = () => {
    const drag = dragRef.current;
    dragRef.current = null;
    if (drag) onMoveEnd?.(drag.id);
  };

  return (
    <div
      ref={wrapRef}
      className={cx("stage-frame aspect-video w-full", interactive && (locked ? "cursor-default" : "cursor-grab"), className)}
      tabIndex={interactive ? 0 : undefined}
      role={interactive ? "application" : undefined}
      aria-label={interactive ? ariaLabel : undefined}
      data-editor-stage={interactive ? "" : undefined}
      onPointerDown={
        interactive
          ? (e) => {
              const { x, y } = toNorm(e);
              const id = hit(x, y);
              onSelect?.(id);
              if (id && !locked) {
                const pos = displayRef.current.positions[id];
                dragRef.current = { id, ox: pos.x - x, oy: pos.y - y };
                onMoveStart?.(id);
                (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
              }
            }
          : undefined
      }
      onPointerMove={
        interactive
          ? (e) => {
              const drag = dragRef.current;
              if (!drag) return;
              const { x, y } = toNorm(e);
              onMove?.(drag.id, { x: clamp(x + drag.ox, 0.03, 0.97), y: clamp(y + drag.oy, 0.05, 0.9) });
            }
          : undefined
      }
      onPointerUp={interactive ? endDrag : undefined}
      onPointerCancel={interactive ? endDrag : undefined}
    >
      <canvas ref={canvasRef} className="absolute inset-0 h-full w-full" style={{ width: "100%", height: "100%" }} aria-hidden />

      {/* leader lines */}
      {mode !== "none" && size.w > 0 && (
        <svg className="pointer-events-none absolute inset-0 h-full w-full" width={size.w} height={size.h} aria-hidden>
          {layout.map((l) => (
            <polyline
              key={l.key}
              points={l.line.map((p) => `${p[0]},${p[1]}`).join(" ")}
              fill="none"
              stroke={l.color}
              strokeOpacity={0.25 + l.level * 0.5}
              strokeWidth="1"
            />
          ))}
        </svg>
      )}

      {/* labels */}
      {mode !== "none" &&
        layout.map((l) => (
          <div
            key={l.key}
            className={cx(
              "pointer-events-none absolute flex flex-col leading-none",
              !display.reducedMotion && "transition-opacity duration-300",
              l.side === "right" ? "items-end text-right" : l.side === "top" ? "items-center text-center" : "items-start",
            )}
            style={{
              left: l.side === "top" ? l.lx : l.side === "left" ? l.lx : undefined,
              right: l.side === "right" ? size.w - l.lx : undefined,
              top: l.ly,
              transform: l.side === "top" ? "translate(-50%, 0)" : "translateY(-50%)",
              opacity: 0.4 + l.level * 0.6,
            }}
          >
            <span className="text-[10px] font-semibold uppercase tracking-[0.18em] text-stage-text-2">{l.text}</span>
            {l.dynamic ? (
              <Dyn value={l.dynamic} size="md" className="mt-1" style={{ color: l.color }} />
            ) : (
              // nothing in the group is playing: no glyph, same block height so the name doesn't jump
              <span aria-hidden className="mt-1 h-[19px]" />
            )}
          </div>
        ))}

      {/* conductor caption */}
      <span className="pointer-events-none absolute bottom-[2.5%] left-1/2 -translate-x-1/2 text-[9px] font-semibold uppercase tracking-[0.2em] text-stage-text-3">
        Conductor
      </span>

      {showLegend && <LadderDots className="absolute left-4 top-4" />}
    </div>
  );
}

function clamp(v: number, a: number, b: number) {
  return Math.max(a, Math.min(b, v));
}
