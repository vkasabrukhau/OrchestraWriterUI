"use client";

import { useEffect, useRef, useState, type CSSProperties, type RefObject } from "react";
import { Maximize2 } from "lucide-react";
import type { DisplaySettings } from "@/shared/project-file";
import type { InfoMap } from "@/shared/info-map";
import { useProject } from "@/lib/store/project";
import { usePlayback } from "@/lib/store/playback";
import { useEditor, useEditorRequest, usePartActivity, type EditorPanel } from "@/lib/store/editor";
import { PANEL_LIMITS, fitPanels, useEditorLayout } from "@/lib/store/editor-layout";
import { useProjectTiming } from "@/lib/store/useProjectTiming";
import { formatShortcut } from "@/lib/editor/commands";
import { cx } from "@/lib/utils/format";
import { Stage } from "@/components/visualizer/Stage";
import { useWaveform } from "@/components/visualizer/useWaveform";
import { EditorTransport } from "@/components/music/Transport";
import { PartLanes } from "@/components/music/PartLanes";
import { NeedsScore } from "@/components/music/NeedsScore";
import { barNumber } from "@/components/music/bars";
import { PanelHeader, ToolButton } from "@/components/editor/parts";
import { Splitter } from "@/components/ui/Splitter";
import { InstrumentsPanel } from "./InstrumentsPanel";
import { Inspector } from "./Inspector";

export { PALETTES } from "./palettes";

export function CustomizePage({ projectId }: { projectId: string }) {
  const summary = useProject((s) => s.summary);
  const infoMap = useProject((s) => s.infoMap);
  const display = useProject((s) => s.display);
  if (!summary || !infoMap || !display) {
    return (
      <div className="mx-auto w-full max-w-[1440px] px-5 py-8 md:px-8">
        <NeedsScore projectId={projectId} title="Customize the display" />
      </div>
    );
  }
  return <CustomizeEditor infoMap={infoMap} display={display} hasRecording={summary.hasRecording} />;
}

/**
 * The Customize editor (ADR 0022): instruments left, the stage with its
 * transport in the middle, properties right, part lanes along the bottom,
 * inside the editor window that `WorkflowFrame` draws (ADR 0023). Side by
 * side (lg and up) the borders of the three panels drag to resize them, and
 * the 16:9 stage refits the space left over.
 */
function CustomizeEditor({ infoMap, display, hasRecording }: { infoMap: InfoMap; display: DisplaySettings; hasRecording: boolean }) {
  const panels = useEditor((s) => s.panels);
  const togglePanel = useEditor((s) => s.togglePanel);
  const selectedId = useEditor((s) => s.selectedId);
  const select = useEditor((s) => s.select);
  const stored = useEditorLayout((s) => s.sizes);
  const { resize, reset } = useEditorLayout.getState();
  const gridRef = useRef<HTMLDivElement>(null);
  const box = useSize(gridRef);
  const { size, max } = fitPanels(stored, box, panels);

  useEffect(() => useEditorLayout.getState().load(), []);

  // the selection must point at a part that exists (the score can be replaced)
  useEffect(() => {
    if (selectedId && !infoMap.instruments.some((i) => i.id === selectedId)) select(null);
  }, [infoMap, selectedId, select]);

  const cols = [panels.instruments && "var(--panel-instruments)", "minmax(0,1fr)", panels.properties && "var(--panel-properties)"].filter(Boolean).join(" ");
  const style = {
    gridTemplateColumns: cols,
    "--panel-instruments": `${size.instruments}px`,
    "--panel-properties": `${size.properties}px`,
    "--panel-lanes": `${size.lanes}px`,
  } as CSSProperties;

  /** a border for `panel`: while dragging only the CSS variable changes, so nothing re-renders */
  const splitter = (panel: EditorPanel, label: string, className: string, orientation: "vertical" | "horizontal" = "vertical", invert = false) => (
    <Splitter
      orientation={orientation}
      value={size[panel]}
      min={PANEL_LIMITS[panel][0]}
      max={max[panel]}
      onLive={(px) => gridRef.current?.style.setProperty(`--panel-${panel}`, `${px}px`)}
      onCommit={(px) => {
        gridRef.current?.style.setProperty(`--panel-${panel}`, `${px}px`);
        resize(panel, px);
      }}
      onReset={() => reset(panel)}
      label={label}
      controls={`panel-${panel}`}
      invert={invert}
      className={cx("max-lg:hidden", className)}
    />
  );

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <h1 className="sr-only">Customize the display</h1>
      <div ref={gridRef} className="flex min-h-0 flex-1 flex-col divide-y divide-line lg:grid lg:grid-rows-[minmax(0,1fr)] lg:divide-x lg:divide-y-0" style={style}>
        {panels.instruments && (
          <div id="panel-instruments" className="relative order-2 flex max-h-[70vh] min-h-0 flex-col lg:order-none lg:max-h-none">
            <InstrumentsPanel infoMap={infoMap} display={display} />
            {splitter("instruments", "Resize instruments panel", "right-0 translate-x-1/2")}
          </div>
        )}
        <div className="order-1 flex min-h-0 min-w-0 flex-col lg:order-none">
          <StageArea infoMap={infoMap} display={display} hasRecording={hasRecording} />
          {panels.lanes && (
            <div id="panel-lanes" className="relative flex h-[300px] shrink-0 flex-col border-t border-line lg:h-[var(--panel-lanes)]">
              {splitter("lanes", "Resize part lanes", "top-0 -translate-y-1/2", "horizontal", true)}
              <PartLanes
                infoMap={infoMap}
                display={display}
                selectedId={selectedId}
                onSelect={(id) => select(selectedId === id ? null : id)}
                onCollapse={() => togglePanel("lanes")}
                className="min-h-0 flex-1"
              />
            </div>
          )}
        </div>
        {panels.properties && (
          <div id="panel-properties" className="relative order-3 flex min-h-0 flex-col lg:order-none">
            {splitter("properties", "Resize properties panel", "left-0 -translate-x-1/2", "vertical", true)}
            <Inspector infoMap={infoMap} display={display} />
          </div>
        )}
      </div>
    </div>
  );
}

/** The element's size, kept current with a ResizeObserver (0 × 0 before the first measure). */
function useSize(ref: RefObject<HTMLElement | null>) {
  const [box, setBox] = useState({ width: 0, height: 0 });
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const measure = () => setBox((b) => (b.width === el.clientWidth && b.height === el.clientHeight ? b : { width: el.clientWidth, height: el.clientHeight }));
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    measure();
    return () => ro.disconnect();
  }, [ref]);
  return box;
}

function StageArea({
  infoMap,
  display,
  hasRecording,
}: {
  infoMap: InfoMap;
  display: DisplaySettings;
  hasRecording: boolean;
}) {
  const onFrame = usePartActivity((s) => s.set);
  const { setPosition, beginGesture, endGesture } = useProject.getState();
  const storePeaks = useProject((s) => s.peaks);
  const playing = usePlayback((s) => s.playing);
  const { clock, measureAt } = useProjectTiming();
  // re-render on bar changes only, not every frame
  const bar = usePlayback((s) => measureAt(s.time));
  const peaks = useWaveform({ peaks: storePeaks, infoMap });
  const selectedId = useEditor((s) => s.selectedId);
  const select = useEditor((s) => s.select);
  const locked = useEditor((s) => s.locked);
  const showSeating = useEditor((s) => s.showSeating);
  const showLegend = useEditor((s) => s.showLegend);
  const requestFullscreen = useEditor((s) => s.requestFullscreen);
  const frameRef = useRef<HTMLDivElement>(null);

  useEditorRequest("fullscreen", () => {
    const el = frameRef.current;
    if (!el) return;
    if (document.fullscreenElement) void document.exitFullscreen().catch(() => {});
    else void el.requestFullscreen?.().catch(() => {});
  });

  const shown = display.visibleParts.length;

  return (
    <section className="flex min-h-0 flex-1 flex-col" aria-labelledby="stage-title">
      <PanelHeader
        id="stage-title"
        title="Stage"
        meta={
          <>
            Orchestra layout · {shown} of {infoMap.instruments.length} parts shown
          </>
        }
        actions={
          <>
            <span className="tnum mr-2 hidden text-[11px] text-ink-3 sm:inline">16:9</span>
            <ToolButton label="Full screen" shortcut={formatShortcut({ key: "f" })} onClick={requestFullscreen} size="sm">
              <Maximize2 size={13} aria-hidden />
            </ToolButton>
          </>
        }
      />
      <div ref={frameRef} className="relative flex flex-1 flex-col bg-paper-3 lg:min-h-[240px] [&:fullscreen]:bg-stage">
        {/* stacked (below lg) the column has no fixed height, so the stage takes the full width;
            side by side and in full screen it fits the 16:9 stage inside the space left over */}
        <div className="grid min-h-0 flex-1 place-items-center p-4 lg:p-5 lg:[container-type:size] [:fullscreen>&]:[container-type:size]">
          <div className="relative w-full lg:w-[min(100cqw,calc(100cqh*16/9))] [:fullscreen_&]:w-[min(100cqw,calc(100cqh*16/9))]">
            <Stage
              infoMap={infoMap}
              display={display}
              clock={clock}
              interactive
              locked={locked}
              selectedId={selectedId}
              onSelect={select}
              onMove={setPosition}
              onMoveStart={beginGesture}
              onMoveEnd={endGesture}
              previewAll={!playing}
              showLegend={showLegend}
              showSeating={showSeating}
              onFrame={onFrame}
              ariaLabel="Orchestra stage. Click a glow to select it, drag to move it; with the stage focused, arrow keys nudge the selected part."
              className="shadow-md focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brass"
            />
          </div>
        </div>
        <p className="shrink-0 px-5 pb-2.5 text-[11px] text-ink-3" aria-live="polite">
          {playing
            ? "Playing: glows follow the written dynamics."
            : locked
              ? "Paused · layout locked: click a glow to select it."
              : "Paused: every visible part is lit at a middle level so you can place it. Drag a glow to move it."}
        </p>
      </div>
      <EditorTransport
        peaks={peaks}
        className="shrink-0 border-t border-line"
        measureLabel={`Bar ${barNumber(infoMap, bar)} / ${infoMap.measures.length}`}
        sourceLabel={hasRecording ? "Uploaded recording" : "Generated from score"}
      />
    </section>
  );
}
