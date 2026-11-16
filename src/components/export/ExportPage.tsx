"use client";

import { useCallback, useEffect, useState } from "react";
import { ArrowLeft, Check } from "lucide-react";
import { api, errorMessage } from "@/lib/api";
import { useProject } from "@/lib/store/project";
import { usePlayback } from "@/lib/store/playback";
import { PageHeader, Dot } from "@/components/shell/PageHeader";
import { Button } from "@/components/ui/Button";
import { NeedsScore } from "@/components/music/NeedsScore";
import { ProjectFileCard } from "./ProjectFileCard";
import { VideoCard } from "./VideoCard";
import { ExportHistory, type HistoryState } from "./ExportHistory";
import { slugify } from "./shared";
import { PendingMarkersNotice } from "@/components/sync/PendingMarkersNotice";

export function ExportPage({ projectId }: { projectId: string }) {
  const summary = useProject((s) => s.summary);
  const infoMap = useProject((s) => s.infoMap);
  const hasRecording = summary?.hasRecording ?? false;
  // the recording's own length once the shared engine has loaded it
  const recordingSec = usePlayback((s) => (hasRecording && s.engine && s.ready && s.duration > 0 ? s.duration : null));

  const [history, setHistory] = useState<HistoryState>({ status: "loading", rows: [] });
  const fetchHistory = useCallback(async () => {
    try {
      const rows = await api.listExports(projectId);
      setHistory({ status: "ready", rows });
    } catch (err) {
      setHistory((h) => ({ status: "error", rows: h.rows, error: errorMessage(err, "Export history could not be loaded") }));
    }
  }, [projectId]);
  useEffect(() => {
    void fetchHistory();
  }, [fetchHistory]);
  const reloadHistory = useCallback(() => {
    setHistory((h) => ({ ...h, status: h.rows.length > 0 ? "ready" : "loading" }));
    void fetchHistory();
  }, [fetchHistory]);

  if (!summary || !infoMap) return <NeedsScore projectId={projectId} title="Export" />;

  const slug = slugify(summary.title);
  const generatedSec = infoMap.duration;
  const uploadedSec = recordingSec ?? summary.durationSec;

  return (
    <div className="space-y-6">
      <PageHeader
        title="Export"
        meta={
          <>
            <span>
              {summary.title}
              {summary.subtitle && <em className="font-serif"> {summary.subtitle}</em>}
            </span>
            {summary.movement && (
              <>
                <Dot />
                <span>{summary.movement}</span>
              </>
            )}
            <Dot />
            <span className="tnum">{summary.parts} parts</span>
          </>
        }
      />
      <PendingMarkersNotice projectId={projectId} />

      <div className="grid gap-6 lg:grid-cols-2">
        <ProjectFileCard projectId={projectId} defaultName={slug} onExported={reloadHistory} />
        <VideoCard
          projectId={projectId}
          defaultName={slug}
          hasRecording={hasRecording}
          durations={{ uploaded: uploadedSec, generated: generatedSec }}
          onExported={reloadHistory}
        />
      </div>

      <ExportHistory state={history} onRetry={reloadHistory} />

      <div className="flex flex-wrap items-center justify-between gap-3 border-t border-line pt-6">
        <Button variant="ghost" href={`/projects/${projectId}/preview`} leading={<ArrowLeft size={14} />}>
          Back to Preview
        </Button>
        <Button variant="outline" href="/library" leading={<Check size={14} />}>
          Done
        </Button>
      </div>
    </div>
  );
}

