"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { AlertTriangle, ArrowRight, RefreshCw } from "lucide-react";
import type { AlignJobInput, AlignResult, Job } from "@/shared/jobs";
import { api } from "@/lib/api";
import { useProject } from "@/lib/store/project";
import { NeedsScore } from "@/components/music/NeedsScore";
import { Button } from "@/components/ui/Button";
import { PageHeader } from "@/components/shell/PageHeader";
import { JobLine } from "@/components/export/shared";
import { isRunning, isStarting, useProjectJob } from "@/components/import/projectJobs";
import { SyncWorkspace } from "./workspace/SyncWorkspace";
import { ContinueGuard } from "./workspace/ContinueGuard";

export function SyncPage({ projectId }: { projectId: string }) {
  const router = useRouter();
  const summary = useProject((s) => s.summary);
  const infoMap = useProject((s) => s.infoMap);
  const sync = useProject((s) => s.sync);
  const refresh = useProject((s) => s.refresh);
  const setStage = useProject((s) => s.setStage);
  const hasRecording = summary?.hasRecording ?? false;

  const alignKey = `${projectId}:align`;
  const queueRef = useRef<(() => void) | null>(null);
  /** the last run's result stays on screen after its job is forgotten */
  const [lastResult, setLastResult] = useState<AlignResult | null>(null);
  const onAligned = useCallback(
    (job: Job<AlignResult>) => {
      if (job.result) setLastResult(job.result);
      void refresh().then(() => queueRef.current?.());
    },
    [refresh],
  );
  const align = useProjectJob<AlignResult>(alignKey, { onSucceeded: onAligned, forgetOnSuccess: true });
  const [startError, setStartError] = useState<string | null>(null);
  const aligning = isRunning(align.job);

  const startAlign = align.start;
  const beginAlignment = useCallback(
    () =>
      startAlign(async () => {
        // the aligner keeps the server's manual markers: write pending edits first
        await useProject.getState().saveNow();
        return api.startAlignment(projectId);
      }).catch((err: unknown) => {
        setStartError(err instanceof Error ? err.message : "Auto-alignment could not start.");
      }),
    [startAlign, projectId],
  );
  const runAlignment = () => {
    setStartError(null);
    void beginAlignment();
  };
  // runs one job per local range, in sequence (each applies the pending markers inside it)
  const queue = useRef<AlignJobInput[]>([]);
  const runNext = useCallback(() => {
    const next = queue.current.shift();
    if (!next) return;
    void startAlign(async () => {
      await useProject.getState().saveNow();
      return api.startAlignment(projectId, next);
    }).catch((err: unknown) => {
      queue.current = [];
      setStartError(err instanceof Error ? err.message : "The sync could not start.");
    });
  }, [startAlign, projectId]);
  const runInputs = useCallback(
    (inputs: AlignJobInput[]) => {
      setStartError(null);
      queue.current = [...inputs];
      runNext();
    },
    [runNext],
  );
  useEffect(() => {
    queueRef.current = runNext;
  }, [runNext]);

  // First visit with a recording and no alignment yet: align automatically, once.
  const needsAlignment = hasRecording && Boolean(infoMap) && sync === null;
  const alignJobId = align.jobId;
  useEffect(() => {
    if (!needsAlignment || alignJobId || startError || isStarting(alignKey)) return;
    void beginAlignment();
  }, [needsAlignment, alignJobId, startError, alignKey, beginAlignment]);

  // "Alignment updated" stays up briefly after a re-run.
  const alignStatus = align.job?.status;
  const clearAlign = align.clear;
  useEffect(() => {
    if (alignStatus !== "succeeded" || sync === null) return;
    const t = setTimeout(clearAlign, 3000);
    return () => clearTimeout(t);
  }, [alignStatus, sync, clearAlign]);

  const goCustomize = () => {
    setStage("customize");
    router.push(`/projects/${projectId}/customize`);
  };

  if (!summary || !infoMap) return <NeedsScore projectId={projectId} title="Sync the recording" />;

  if (!hasRecording) {
    return (
      <div className="card mx-auto max-w-lg p-8 text-center">
        <h1 className="display mb-2 text-[2rem]">No recording to sync</h1>
        <p className="mb-6 text-sm text-ink-3">Playback is generated from the score, so every bar is already in time.</p>
        <Button onClick={goCustomize} trailing={<ArrowRight size={14} />}>
          Continue to Customize
        </Button>
      </div>
    );
  }

  if (!sync) {
    const failed = align.job?.status === "failed" || startError;
    return (
      <div className="space-y-6">
        <PageHeader title="Sync the recording" meta={<span>{summary.recordingName ?? "Recording"}</span>} />
        <section className="card mx-auto max-w-2xl p-6" aria-labelledby="align-title">
          <h2 id="align-title" className="font-serif text-xl text-ink">
            {failed ? "Auto-alignment failed" : "Aligning the recording to the score"}
          </h2>
          {failed ? (
            <>
              <p className="mt-2 flex items-start gap-2 text-sm text-ink-2" role="alert">
                <AlertTriangle size={15} className="mt-0.5 shrink-0 text-danger" aria-hidden />
                {startError ?? align.job?.error ?? "The alignment did not finish."}
              </p>
              <div className="mt-5 flex flex-wrap gap-2">
                <Button size="sm" leading={<RefreshCw size={13} />} onClick={runAlignment}>
                  Retry
                </Button>
                <Button size="sm" variant="ghost" onClick={goCustomize}>
                  Continue without alignment
                </Button>
              </div>
            </>
          ) : (
            <>
              <p className="mt-2 text-sm text-ink-3">Every bar gets a start time in the recording and a confidence. This runs in your browser and takes a few seconds.</p>
              <div className="mt-5">{align.job ? <JobLine job={align.job} /> : <p className="text-[13px] text-ink-3">Starting…</p>}</div>
            </>
          )}
        </section>
      </div>
    );
  }

  return (
    <SyncWorkspace
      projectId={projectId}
      infoMap={infoMap}
      job={align.job}
      lastResult={lastResult}
      running={aligning}
      startError={startError}
      onRun={runInputs}
      toolbar={
        <p className="flex flex-wrap items-center gap-x-1 text-[11px] text-ink-3">
          <span className="truncate" title={summary.recordingName ?? undefined}>
            {summary.recordingName ?? "Recording"}
          </span>
          ·<span className="tnum">{infoMap.measures.length} bars</span>·<span className="tnum">{Math.round(sync.averageConfidence)}% average confidence</span>·
          <span className="tnum">
            {sync.manual.length} manual {sync.manual.length === 1 ? "marker" : "markers"}
          </span>
        </p>
      }
      actions={<ContinueGuard onContinue={goCustomize} onRecompute={runInputs} running={aligning} />}
    />
  );
}
