"use client";

import { useCallback, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { ArrowRight, Maximize2, Music2, SlidersHorizontal, Users, Waves } from "lucide-react";
import { DYNAMIC_INDEX, type Dynamic } from "@/shared/dynamics";
import { SECTION_ORDER } from "@/shared/sections";
import type { DisplaySettings } from "@/shared/project-file";
import type { InfoMap } from "@/shared/info-map";
import type { ProjectSummary } from "@/shared/domain";
import { useProject } from "@/lib/store/project";
import { usePlayback } from "@/lib/store/playback";
import { useProjectTiming } from "@/lib/store/useProjectTiming";
import { partColor } from "@/lib/visualizer";
import { cx } from "@/lib/utils/format";
import { Stage } from "@/components/visualizer/Stage";
import { useWaveform } from "@/components/visualizer/useWaveform";
import { Transport } from "@/components/music/Transport";
import { ScoreView } from "@/components/music/ScoreView";
import { Dyn } from "@/components/music/Dyn";
import { DynamicLegend } from "@/components/music/DynamicLegend";
import { NeedsScore } from "@/components/music/NeedsScore";
import { barBeatText, barNumber } from "@/components/music/bars";
import { Button } from "@/components/ui/Button";
import { Toggle } from "@/components/ui/Toggle";
import { Chip } from "@/components/ui/Chip";
import { Panel } from "@/components/ui/Collapsible";
import { Tooltip } from "@/components/ui/Tooltip";
import { PageHeader, Dot } from "@/components/shell/PageHeader";
import { PendingMarkersNotice } from "@/components/sync/PendingMarkersNotice";

type PartFrame = { id: string; playing: boolean; dynamic: Dynamic; level: number };

export function PreviewPage({ projectId }: { projectId: string }) {
  const summary = useProject((s) => s.summary);
  const infoMap = useProject((s) => s.infoMap);
  const display = useProject((s) => s.display);
  if (!summary || !infoMap || !display) return <NeedsScore projectId={projectId} title="Preview" />;
  return <PreviewView projectId={projectId} summary={summary} infoMap={infoMap} display={display} />;
}

function PreviewView({ projectId, summary, infoMap, display }: { projectId: string; summary: ProjectSummary; infoMap: InfoMap; display: DisplaySettings }) {
  const router = useRouter();
  const storePeaks = useProject((s) => s.peaks);
  const setStage = useProject((s) => s.setStage);
  const setShowLabels = useProject((s) => s.setShowLabels);
  const setReducedMotion = useProject((s) => s.setReducedMotion);
  const { clock, measureAt, seekMeasure, toScore, hasRecording, aligned } = useProjectTiming();
  const peaks = useWaveform({ peaks: storePeaks, infoMap });

  const [measure, setMeasure] = useState(() => measureAt(usePlayback.getState().time));
  const [frame, setFrame] = useState<PartFrame[]>([]);
  const [panels, setPanels] = useState({ stage: true, score: true, orchestra: false });
  const toggle = (k: keyof typeof panels) => setPanels((p) => ({ ...p, [k]: !p[k] }));
  const stageRef = useRef<HTMLDivElement>(null);

  const onFrame = useCallback((parts: PartFrame[]) => setFrame(parts), []);
  const onMeasure = useCallback((m: number) => setMeasure(m), []);

  const visible = useMemo(() => new Set(display.visibleParts), [display.visibleParts]);
  const total = infoMap.measures.length;
  const confidence =
    summary.averageConfidence ?? (aligned.length > 0 ? aligned.reduce((s, a) => s + a.confidence, 0) / aligned.length : null);

  // "What's playing": strings part by part, other sections grouped (as in the mockup).
  const rows = useMemo(() => {
    const byId = new Map(frame.map((f) => [f.id, f]));
    const out: Array<{ key: string; label: string; color: string; dynamic: Dynamic | null; playing: boolean; level: number }> = [];
    for (const section of SECTION_ORDER) {
      const members = infoMap.instruments.filter((i) => visible.has(i.id) && (display.sections[i.id] ?? i.section) === section);
      if (members.length === 0) continue;
      if (section === "Strings") {
        for (const m of members) {
          const f = byId.get(m.id);
          out.push({ key: m.id, label: m.name, color: partColor(infoMap, display, m.id), dynamic: f?.playing ? f.dynamic : null, playing: !!f?.playing, level: f?.level ?? 0 });
        }
      } else {
        let dyn: Dynamic | null = null;
        let level = 0;
        for (const m of members) {
          const f = byId.get(m.id);
          if (f?.playing && (dyn === null || DYNAMIC_INDEX[f.dynamic] > DYNAMIC_INDEX[dyn])) dyn = f.dynamic;
          level = Math.max(level, f?.level ?? 0);
        }
        out.push({ key: section, label: section, color: display.sectionColors[section], dynamic: dyn, playing: dyn !== null, level });
      }
    }
    return out;
  }, [frame, infoMap, display, visible]);

  const goExport = () => {
    setStage("export");
    router.push(`/projects/${projectId}/export`);
  };
  const fullscreen = () => {
    const el = stageRef.current;
    if (!el) return;
    if (document.fullscreenElement) void document.exitFullscreen?.();
    else void el.requestFullscreen?.();
  };

  return (
    <div className="space-y-6">
      <PageHeader
        title={
          <>
            {summary.title} {summary.subtitle && <em>{summary.subtitle}</em>}
          </>
        }
        meta={
          <>
            {summary.movement && (
              <>
                <span>{summary.movement}</span>
                <Dot />
              </>
            )}
            <span className="tnum">
              bar {barNumber(infoMap, measure)} of {total}
            </span>
            <Dot />
            <span className="tnum">
              {display.visibleParts.length} of {infoMap.instruments.length} parts shown
            </span>
            {hasRecording && confidence !== null && (
              <>
                <Dot />
                <span className="tnum">{Math.round(confidence)}% sync confidence</span>
              </>
            )}
          </>
        }
        actions={
          <>
            {hasRecording && (
              <Button href={`/projects/${projectId}/sync`} variant="outline" size="sm" leading={<Waves size={14} />}>
                Edit sync
              </Button>
            )}
            <Button href={`/projects/${projectId}/customize`} variant="outline" size="sm" leading={<SlidersHorizontal size={14} />}>
              Edit display
            </Button>
            <Button variant="primary" size="sm" onClick={goExport} trailing={<ArrowRight size={14} />}>
              Continue to Export
            </Button>
          </>
        }
      />
      <PendingMarkersNotice projectId={projectId} />

      <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_300px] xl:grid-cols-[minmax(0,1fr)_320px]">
        <div className="min-w-0 space-y-4">
          <Panel
            title="Visualizer"
            icon={<Waves size={14} />}
            open={panels.stage}
            onToggle={() => toggle("stage")}
            bare
            trailing={
              <div className="flex items-center gap-2">
                <Chip tone="neutral" className="whitespace-nowrap">
                  {hasRecording ? "Uploaded recording" : "Generated from score"}
                </Chip>
                <Tooltip label="Fullscreen">
                  <Button variant="ghost" size="icon-sm" aria-label="Fullscreen" onClick={fullscreen} disabled={!panels.stage}>
                    <Maximize2 size={14} />
                  </Button>
                </Tooltip>
              </div>
            }
          >
            <div ref={stageRef} className="relative [&:fullscreen]:flex [&:fullscreen]:items-center [&:fullscreen]:bg-stage">
              <Stage infoMap={infoMap} display={display} clock={clock} onFrame={onFrame} onMeasure={onMeasure} />
            </div>
          </Panel>
          {!panels.stage && (
            // keeps the frame clock (bar counter, What's playing) running while the panel is collapsed
            <div className="hidden" aria-hidden>
              <Stage infoMap={infoMap} display={display} clock={clock} onFrame={onFrame} onMeasure={onMeasure} labelMode="none" showSeating={false} />
            </div>
          )}

          <Transport peaks={peaks} positionLabel={(t) => barBeatText(infoMap, toScore(t))} />

          <Panel title="Score" icon={<Music2 size={14} />} open={panels.score} onToggle={() => toggle("score")}>
            <ScoreView
              key={projectId}
              projectId={projectId}
              infoMap={infoMap}
              currentMeasure={measure}
              onSeekMeasure={seekMeasure}
              reducedMotion={display.reducedMotion}
              visibleParts={visible}
            />
          </Panel>

          <Panel title="Orchestra viewer" icon={<Users size={14} />} open={panels.orchestra} onToggle={() => toggle("orchestra")}>
            <OrchestraViewer frame={frame} infoMap={infoMap} display={display} />
          </Panel>
        </div>

        <aside className="card self-start p-5 lg:sticky lg:top-24" aria-labelledby="playing-title">
          <h2 id="playing-title" className="display mb-3 text-[1.5rem]">
            What&apos;s playing
          </h2>
          <ul className="divide-y divide-line">
            {rows.map((r) => (
              <li
                key={r.key}
                className={cx("flex items-center justify-between gap-3 py-2.5", !display.reducedMotion && "transition-opacity duration-200")}
                style={{ opacity: r.playing ? 1 : 0.45 }}
              >
                <span className="flex min-w-0 items-center gap-2.5">
                  <span
                    className="h-4 w-4 shrink-0 rounded-full"
                    style={{
                      background: r.color,
                      boxShadow: r.playing ? `0 0 ${6 + r.level * 10}px ${r.color}` : "none",
                      opacity: 0.45 + r.level * 0.55,
                    }}
                    aria-hidden
                  />
                  <span className="truncate text-sm text-ink">{r.label}</span>
                </span>
                {r.dynamic ? <Dyn value={r.dynamic} className="text-ink" /> : <span className="text-[12px] text-ink-4">silent</span>}
              </li>
            ))}
          </ul>
          <DynamicLegend className="mt-5 border-t border-line pt-5" />
          <div className="mt-6 space-y-3 border-t border-line pt-5">
            <Toggle label="Show part labels" checked={display.showLabels} onChange={setShowLabels} />
            <Toggle label="Reduced motion" checked={display.reducedMotion} onChange={setReducedMotion} />
          </div>
        </aside>
      </div>
    </div>
  );
}

function OrchestraViewer({ frame, infoMap, display }: { frame: PartFrame[]; infoMap: InfoMap; display: DisplaySettings }) {
  const byId = new Map(frame.map((f) => [f.id, f]));
  return (
    <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
      {SECTION_ORDER.map((section) => {
        const members = infoMap.instruments.filter((i) => (display.sections[i.id] ?? i.section) === section);
        if (members.length === 0) return null;
        return (
          <div key={section}>
            <h3 className="mb-2 flex items-center gap-2 text-[12px] font-medium text-ink-2">
              <span className="h-2 w-2 rounded-full" style={{ background: display.sectionColors[section] }} aria-hidden />
              {section}
            </h3>
            <ul className="space-y-1">
              {members.map((m) => {
                const f = byId.get(m.id);
                const hidden = !display.visibleParts.includes(m.id);
                return (
                  <li
                    key={m.id}
                    className={cx("flex items-center justify-between rounded-md px-2 py-1 text-[13px]", f?.playing ? "bg-paper-3 text-ink" : "text-ink-3", hidden && "line-through opacity-50")}
                  >
                    <span>{m.name}</span>
                    {f?.playing && <Dyn value={f.dynamic} size="sm" />}
                  </li>
                );
              })}
            </ul>
          </div>
        );
      })}
    </div>
  );
}
