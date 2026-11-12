"use client";

import { useEffect, useMemo } from "react";
import type { InfoMap } from "@/shared/info-map";
import type { AlignJobInput, AlignResult, Job } from "@/shared/jobs";
import { useProject } from "@/lib/store/project";
import { usePlayback } from "@/lib/store/playback";
import { useSyncUi, type Spot } from "@/lib/store/sync-ui";
import { useSyncLayout, type SyncPaneId } from "@/lib/store/sync-layout";
import { useProjectTiming } from "@/lib/store/useProjectTiming";
import { PanelRightClose, PanelRightOpen } from "lucide-react";
import { Panes } from "@/components/ui/Panes";
import { SyncHelp } from "./SyncHelp";
import { spotText } from "@/components/music/bars";
import { ConfidencePane } from "../confidence/ConfidencePane";
import { ScorePane } from "../score/ScorePane";
import { JointPlaybackPane } from "../joint/JointPlaybackPane";
import { MeasuresSection } from "../sidebar/MeasuresSection";
import { MarkersSection } from "../sidebar/MarkersSection";
import { SyncSection } from "../sidebar/SyncSection";
import { MarkerPopover } from "../markers/MarkerPopover";
import { NoteMenu } from "../markers/NoteMenu";
import { RecomputeSuggestion } from "../markers/RecomputeSuggestion";
import { clearUndo, undo } from "../markers/useMarkerCommands";
import { SyncActionsContext, type SyncActions } from "./SyncActions";

/**
 * The Sync page as one window (owner's revamp): confidence map, score and
 * joint playback stacked in resizable, minimizable sections, with a
 * Lightroom-style sidebar (Measures, Markers, Sync) on the right.
 */
export function SyncWorkspace({
  projectId,
  infoMap,
  toolbar,
  actions: toolbarActions,
  job,
  lastResult,
  running,
  startError,
  onRun,
}: {
  projectId: string;
  infoMap: InfoMap;
  toolbar: React.ReactNode;
  /** right side of the toolbar (Continue) */
  actions?: React.ReactNode;
  job: Job<AlignResult> | null;
  lastResult: AlignResult | null;
  running: boolean;
  startError: string | null;
  onRun: (inputs: AlignJobInput[]) => void;
}) {
  const layout = useSyncLayout();
  const duration = usePlayback((s) => s.duration);
  const { measureAt, toTransport } = useProjectTiming();
  const current = usePlayback((s) => measureAt(s.time));
  const announcement = useSyncUi((s) => s.announcement);

  useEffect(() => {
    useSyncUi.getState().reset(projectId);
    useSyncLayout.getState().load();
  }, [projectId]);
  useEffect(() => {
    useProject.getState().setRecordingSec(duration);
  }, [duration]);

  const actions = useMemo<SyncActions>(() => {
    const cue = (spot: Spot) => {
      const m = infoMap.measures[spot.measure - 1];
      if (!m) return null;
      const at = toTransport(m.startTime + spot.position * m.duration);
      usePlayback.getState().setCue({ at, measure: spot.measure, position: spot.position, label: spotText(infoMap, spot.measure, spot.position) });
      return at;
    };
    return {
      running,
      durationSec: duration,
      select: (spot) => {
        useSyncUi.getState().select(spot);
        cue(spot);
      },
      jumpTo: (spot) => {
        useSyncUi.getState().select(spot);
        const at = cue(spot);
        if (at !== null) usePlayback.getState().seek(at);
      },
      recompute: (ranges) => {
        clearUndo();
        onRun(ranges === null ? [{}] : ranges.map((range) => ({ range })));
      },
    };
  }, [infoMap, toTransport, running, duration, onRun]);

  // workspace keys: Cmd/Ctrl+Z undoes the last marker change, Cmd/Ctrl+\ shows or hides the sidebar
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const el = e.target as HTMLElement | null;
      if (el && (el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.isContentEditable)) return;
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "z" && !e.shiftKey) {
        if (undo()) e.preventDefault();
      } else if ((e.metaKey || e.ctrlKey) && e.key === "\\") {
        e.preventDefault();
        useSyncLayout.getState().update({ sidebarOpen: !useSyncLayout.getState().sidebarOpen });
      } else if ((e.key === "r" || e.key === "R") && !e.metaKey && !e.ctrlKey && useSyncLayout.getState().singleKeys) {
        // R focuses the Recompute button; it never starts a run by itself
        document.querySelector<HTMLElement>("[data-recompute-button]")?.focus();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const toggle = (id: SyncPaneId) => {
    const c = layout.collapsed;
    layout.update({ collapsed: c.includes(id) ? c.filter((x) => x !== id) : [...c, id] });
  };

  return (
    <SyncActionsContext.Provider value={actions}>
      <div className="flex h-[calc(100vh-5rem)] min-h-[520px] w-full min-w-0 overflow-hidden rounded-[10px] border border-line bg-paper">
        <div className="flex min-h-0 min-w-0 flex-1">
          <div className="min-w-0 flex-1 overflow-hidden">
            <Panes<SyncPaneId>
              sizes={layout.sizes}
              collapsed={layout.collapsed}
              onResize={(sizes) => layout.update({ sizes })}
              onToggle={toggle}
              panes={[
                { id: "confidence", title: "Confidence map", min: 48, children: <ConfidencePane infoMap={infoMap} current={current} /> },
                { id: "score", title: "Score", min: 160, children: <ScorePane projectId={projectId} infoMap={infoMap} current={current} /> },
                { id: "joint", title: "Joint playback", min: 180, children: <JointPlaybackPane projectId={projectId} infoMap={infoMap} /> },
              ]}
            />
          </div>
          {layout.sidebarOpen ? (
            <aside id="sync-sidebar" aria-label="Sync sidebar" className="scroll-thin w-[320px] shrink-0 overflow-y-auto border-l border-line">
              <div className="sticky top-0 z-10 space-y-1.5 border-b border-line bg-paper px-3 py-2">
                <div className="flex items-center gap-1.5">
                  {toolbarActions}
                  <span className="ml-auto" />
                  <SyncHelp />
                  <button type="button" className="rounded p-1 text-ink-3 hover:bg-paper-3 hover:text-ink" onClick={() => layout.update({ sidebarOpen: false })} aria-label="Hide sidebar (⌘\)" title="Hide sidebar (⌘\)" aria-expanded aria-controls="sync-sidebar">
                    <PanelRightClose size={15} />
                  </button>
                </div>
                {toolbar}
                <RecomputeSuggestion />
              </div>
              <MeasuresSection infoMap={infoMap} current={current} />
              <MarkersSection infoMap={infoMap} />
              <SyncSection infoMap={infoMap} job={job} lastResult={lastResult} startError={startError} />
            </aside>
          ) : (
            <div className="flex w-9 shrink-0 flex-col items-center gap-1 border-l border-line py-1.5">
              <button type="button" className="rounded p-1 text-ink-3 hover:bg-paper-3 hover:text-ink" onClick={() => layout.update({ sidebarOpen: true })} aria-label="Show sidebar (⌘\)" title="Show sidebar (⌘\)" aria-expanded={false}>
                <PanelRightOpen size={15} />
              </button>
              <SyncHelp />
            </div>
          )}
        </div>
      </div>
      <MarkerPopover infoMap={infoMap} />
      <NoteMenu infoMap={infoMap} />
      <p className="sr-only" aria-live="polite" key={announcement.seq}>
        {announcement.text}
      </p>
    </SyncActionsContext.Provider>
  );
}
