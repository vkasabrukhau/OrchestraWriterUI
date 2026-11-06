"use client";

import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { useRouter } from "next/navigation";
import { AlertTriangle, ArrowLeft, ArrowRight, AudioLines, FolderOpen, Music2, RefreshCw, Sparkles, Upload } from "lucide-react";
import type { AudioUploadResult, Job, OpenProjectResult, ParseScoreResult, TranscribeEnsemble, TranscribeScoreResult } from "@/shared/jobs";
import { api } from "@/lib/api";
import { useProject } from "@/lib/store/project";
import { usePlayback } from "@/lib/store/playback";
import { cx, formatBytes, formatTime } from "@/lib/utils/format";
import { Aurora } from "@/components/brand/Aurora";
import { PageHeader, Dot } from "@/components/shell/PageHeader";
import { Button } from "@/components/ui/Button";
import { Chip } from "@/components/ui/Chip";
import { Waveform } from "@/components/music/Waveform";
import { JobLine, ProgressLine } from "@/components/export/shared";
import { Dropzone, hasExtension } from "./Dropzone";
import { forgetJob, isRunning, useProjectJob } from "./projectJobs";

export const SCORE_EXT = [".musicxml", ".xml", ".mxl"];
export const AUDIO_EXT = [".mp3"];
export const PROJECT_EXT = [".ovproj"];

export const SCORE_TYPE_ERROR = "That isn't a MusicXML file. Choose a .musicxml, .xml or .mxl export from your notation software.";
export const AUDIO_TYPE_ERROR = "That isn't an MP3. Other audio formats come in a later phase.";
export const PROJECT_TYPE_ERROR = "That isn't a project file. Choose a .ovproj file saved from Export.";

type Phase = "empty" | "processing" | "done" | "failed";

interface ScoreFacts {
  title: string;
  composer: string;
  movement: string;
  parts: number;
  measures: number;
  durationSec: number;
  warnings: string[];
}

/* ------------------------------------------------------------------ */
/* One upload slot: a picked file, a remembered job, a type error      */
/* ------------------------------------------------------------------ */

function useUpload<T>({
  jobKey,
  start,
  allowed,
  typeMessage,
  onSucceeded,
}: {
  jobKey: string;
  start: (file: File) => Promise<Job<T>>;
  allowed: string[];
  typeMessage: string;
  onSucceeded: (job: Job<T>) => void | Promise<void>;
}) {
  const [file, setFile] = useState<File | null>(null);
  const [typeError, setTypeError] = useState<string | null>(null);
  const [startError, setStartError] = useState<string | null>(null);
  const { job, start: startJob, clear } = useProjectJob<T>(jobKey, { onSucceeded });

  const submit = async (f: File) => {
    setFile(f);
    setStartError(null);
    if (!hasExtension(f.name, allowed)) {
      clear();
      setTypeError(typeMessage);
      return;
    }
    setTypeError(null);
    try {
      await startJob(() => start(f));
    } catch (err) {
      setStartError(err instanceof Error ? err.message : "The upload could not start.");
    }
  };
  const retry = file && !typeError ? () => void submit(file) : undefined;

  return { file, job, typeError, startError, submit, retry };
}

/* ------------------------------------------------------------------ */
/* Page                                                                 */
/* ------------------------------------------------------------------ */

export function ImportPage({ projectId }: { projectId: string }) {
  const router = useRouter();
  const summary = useProject((s) => s.summary);
  const infoMap = useProject((s) => s.infoMap);
  const refresh = useProject((s) => s.refresh);
  const setStage = useProject((s) => s.setStage);

  const onScoreDone = useCallback(() => refresh(), [refresh]);
  const onAudioDone = useCallback(() => {
    // a new recording invalidates the old alignment; Sync starts a fresh one
    forgetJob(`${projectId}:align`);
    return refresh();
  }, [projectId, refresh]);

  const score = useUpload<ParseScoreResult>({
    jobKey: `${projectId}:score`,
    start: (f) => api.uploadScore(projectId, f),
    allowed: SCORE_EXT,
    typeMessage: SCORE_TYPE_ERROR,
    onSucceeded: onScoreDone,
  });
  const audio = useUpload<AudioUploadResult>({
    jobKey: `${projectId}:audio`,
    start: (f) => api.uploadAudio(projectId, f),
    allowed: AUDIO_EXT,
    typeMessage: AUDIO_TYPE_ERROR,
    onSucceeded: onAudioDone,
  });

  // Experimental: no score, but a recording → transcribe one (local MuScriptor service).
  const transcribe = useProjectJob<TranscribeScoreResult>(`${projectId}:transcribe`, { onSucceeded: onScoreDone });
  const [transcribeError, setTranscribeError] = useState<string | null>(null);
  const startTranscribe = async (ensemble: TranscribeEnsemble) => {
    setTranscribeError(null);
    try {
      await transcribe.start(() => api.transcribeScore(projectId, ensemble));
    } catch (err) {
      setTranscribeError(err instanceof Error ? err.message : "The transcription could not start.");
    }
  };
  const transcribing = isRunning(transcribe.job);

  const hasScore = Boolean(summary?.scoreName);
  // A parse that started on an earlier visit (no local job): the server reports it.
  const serverParsing = !score.job && hasScore && summary?.status === "importing";
  const serverFailed = !score.job && hasScore && summary?.status === "failed";

  useEffect(() => {
    if (!serverParsing) return;
    const t = setInterval(() => void refresh(), 2000);
    return () => clearInterval(t);
  }, [serverParsing, refresh]);

  const scorePhase: Phase = transcribing
    ? "processing"
    : score.typeError || score.startError
    ? "failed"
    : score.job
      ? score.job.status === "succeeded"
        ? "done"
        : score.job.status === "failed"
          ? "failed"
          : "processing"
      : serverParsing
        ? "processing"
        : serverFailed
          ? "failed"
          : hasScore && infoMap
            ? "done"
            : "empty";

  const audioPhase: Phase = audio.typeError || audio.startError
    ? "failed"
    : audio.job
      ? audio.job.status === "succeeded"
        ? "done"
        : audio.job.status === "failed"
          ? "failed"
          : "processing"
      : summary?.hasRecording
        ? "done"
        : "empty";

  const facts: ScoreFacts | null =
    score.job?.status === "succeeded" && score.job.result
      ? score.job.result
      : summary && scorePhase === "done"
        ? {
            title: summary.title,
            composer: summary.composer,
            movement: summary.movement,
            parts: summary.parts,
            measures: summary.measures,
            durationSec: summary.durationSec,
            warnings: infoMap?.warnings ?? [],
          }
        : null;

  const hasRecording = audioPhase === "done" && Boolean(summary?.hasRecording || audio.job?.status === "succeeded");
  const canContinue = scorePhase === "done" && audioPhase !== "processing" && Boolean(infoMap);
  const next = hasRecording ? "sync" : "customize";

  const goNext = () => {
    if (!canContinue) return;
    setStage(next);
    router.push(`/projects/${projectId}/${next}`);
  };

  return (
    <div className="space-y-6">
      <PageHeader
        title="Add the score and recording"
        meta={
          facts ? (
            <>
              <span>{facts.title}</span>
              {facts.composer && (
                <>
                  <Dot />
                  <span>{facts.composer}</span>
                </>
              )}
            </>
          ) : undefined
        }
      />

      <div className="grid gap-6 md:grid-cols-2">
        <ScoreCard
          upload={score}
          phase={scorePhase}
          name={score.file?.name ?? summary?.scoreName ?? ""}
          facts={facts}
          serverMessage={serverParsing ? (summary?.statusDetail ?? "Parsing score") : null}
          serverError={serverFailed ? (summary?.statusDetail ?? "The score could not be read.") : null}
          transcribe={{
            available: Boolean(summary?.hasRecording) && audioPhase === "done",
            job: transcribe.job,
            error: transcribeError ?? (transcribe.job?.status === "failed" ? (transcribe.job.error ?? "The transcription failed.") : null),
            start: (ensemble) => void startTranscribe(ensemble),
          }}
        />
        <RecordingCard upload={audio} phase={audioPhase} name={audio.file?.name ?? summary?.recordingName ?? ""} />
      </div>

      <OpenProjectCard projectId={projectId} placeholderIsEmpty={!hasScore && !summary?.hasRecording} />

      <div className="flex flex-wrap items-center justify-between gap-3 border-t border-line pt-6">
        <Button variant="ghost" href="/library" leading={<ArrowLeft size={14} />}>
          Back to library
        </Button>
        <Button variant="primary" onClick={goNext} disabled={!canContinue} trailing={<ArrowRight size={14} />}>
          Continue to {hasRecording ? "Sync" : "Customize"}
        </Button>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Score                                                                */
/* ------------------------------------------------------------------ */

function ScoreCard({
  upload,
  phase,
  name,
  facts,
  serverMessage,
  serverError,
  transcribe,
}: {
  upload: ReturnType<typeof useUpload<ParseScoreResult>>;
  phase: Phase;
  name: string;
  facts: ScoreFacts | null;
  serverMessage: string | null;
  serverError: string | null;
  transcribe: TranscribeControls;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  const pick = () => inputRef.current?.click();
  const job = upload.job;
  const busy = phase === "processing";

  return (
    <section className="card flex flex-col p-5" aria-labelledby="score-card-title">
      <CardHeader
        id="score-card-title"
        title="Score"
        hint="MusicXML · required"
        action={
          phase === "done" ? (
            <Button variant="outline" size="sm" leading={<RefreshCw size={13} />} onClick={pick}>
              Replace
            </Button>
          ) : null
        }
      />

      {phase === "empty" && (
        <Dropzone label="Drop a MusicXML score or browse" onFile={(f) => void upload.submit(f)} onOpen={pick} className="grain flex-1">
          <Aurora subtle />
          <EmptyHero icon={<Music2 size={16} />} title="Drop your score here" hint=".musicxml, .xml or .mxl" />
        </Dropzone>
      )}

      {phase === "empty" && <TranscribeOffer transcribe={transcribe} />}

      {busy && isRunning(transcribe.job) && (
        <ProcessingBox name="Transcribing the recording (experimental)">
          <JobLine job={transcribe.job!} />
          <p className="mt-2 text-xs text-ink-3">Runs on this computer and can take several minutes. You can leave this page.</p>
        </ProcessingBox>
      )}

      {busy && !isRunning(transcribe.job) && (
        <ProcessingBox name={name} size={upload.file?.size}>
          {job ? <JobLine job={job} /> : <ProgressLine message={serverMessage ?? "Parsing score"} indeterminate />}
        </ProcessingBox>
      )}

      {phase === "failed" && (
        <FailureBox
          name={name}
          error={upload.typeError ?? upload.startError ?? job?.error ?? serverError ?? "The score could not be read."}
          onChoose={pick}
          onRetry={job?.status === "failed" ? upload.retry : undefined}
        />
      )}

      {phase === "done" && facts && <ScoreFactsView name={name} facts={facts} />}

      <p className="mt-4 text-xs text-ink-3">Up to 64 parts. Repeats are expanded; D.C. and D.S. jumps are reported, not followed.</p>
      <input
        ref={inputRef}
        type="file"
        accept=".musicxml,.xml,.mxl"
        className="hidden"
        data-testid="score-input"
        disabled={busy}
        onChange={(e) => pickFrom(e.target, upload.submit)}
      />
    </section>
  );
}

function ScoreFactsView({ name, facts }: { name: string; facts: ScoreFacts }) {
  const rows: Array<[string, ReactNode]> = [
    ["Title", facts.title || "Untitled"],
    ["Composer", facts.composer || "—"],
    ["Movement", facts.movement || "—"],
    ["Parts", <span className="tnum" key="p">{facts.parts}</span>],
    ["Measures", <span className="tnum" key="m">{facts.measures}</span>],
    ["Duration", <span className="tnum" key="d">{formatTime(facts.durationSec)}</span>],
  ];
  return (
    <div className="fade-up rounded-[var(--radius-lg)] border border-line bg-paper p-4">
      <div className="mb-3 flex items-center gap-2 text-[13px]">
        <Music2 size={14} className="shrink-0 text-brass-3" aria-hidden />
        <span className="truncate font-medium text-ink">{name}</span>
        <Chip tone="ok" className="ml-auto shrink-0">
          Parsed
        </Chip>
      </div>
      <dl className="grid grid-cols-2 gap-x-6 gap-y-2.5 sm:grid-cols-3">
        {rows.map(([k, v]) => (
          <div key={k} className="min-w-0">
            <dt className="text-[11px] text-ink-3">{k}</dt>
            <dd className="mt-0.5 truncate text-sm text-ink">{v}</dd>
          </div>
        ))}
      </dl>
      {facts.warnings.length > 0 && (
        <ul className="mt-3 flex flex-wrap gap-1.5 border-t border-line pt-3" aria-label="Import warnings">
          {facts.warnings.map((w) => (
            <li key={w}>
              <Chip tone="warn" className="h-auto! min-h-6 py-1 text-left leading-snug">
                <AlertTriangle size={12} className="shrink-0" aria-hidden />
                {w}
              </Chip>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

interface TranscribeControls {
  available: boolean;
  job: Job<TranscribeScoreResult> | null;
  error: string | null;
  start: (ensemble: TranscribeEnsemble) => void;
}

const ENSEMBLE_OPTIONS: { value: TranscribeEnsemble; label: string }[] = [
  { value: "orchestra", label: "Orchestra" },
  { value: "strings", label: "Strings + keyboard" },
  { value: "any", label: "Any instrument" },
];

/** Experimental: make the score from the recording instead of uploading one. */
function TranscribeOffer({ transcribe }: { transcribe: TranscribeControls }) {
  const [ensemble, setEnsemble] = useState<TranscribeEnsemble>("orchestra");
  return (
    <div className="mt-3 rounded-[var(--radius-lg)] border border-dashed border-line p-3 text-[13px]">
      <div className="flex flex-wrap items-center gap-3">
        <p className="min-w-0 flex-1 text-ink-2">
          No score? Transcribe one from the recording.{" "}
          <span className="text-ink-3">
            {transcribe.available
              ? "Experimental: notes and instruments are guessed by MuScriptor, and there are no written dynamics."
              : "Upload an MP3 under Recording first."}
          </span>
        </p>
        <label className="sr-only" htmlFor="transcribe-ensemble">
          Instruments to listen for
        </label>
        <select
          id="transcribe-ensemble"
          value={ensemble}
          onChange={(e) => setEnsemble(e.target.value as TranscribeEnsemble)}
          disabled={!transcribe.available}
          title="Only these instruments are written into the score"
          className="h-8 rounded-[var(--radius-md)] border border-line bg-paper px-2 text-[13px] text-ink disabled:opacity-50"
        >
          {ENSEMBLE_OPTIONS.map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </select>
        <Button
          variant="outline"
          size="sm"
          leading={<Sparkles size={13} />}
          onClick={() => transcribe.start(ensemble)}
          disabled={!transcribe.available}
        >
          {transcribe.error ? "Try again" : "Transcribe"}
        </Button>
      </div>
      {transcribe.error && (
        <p className="mt-2 text-danger" role="alert">
          {transcribe.error}
        </p>
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Recording                                                            */
/* ------------------------------------------------------------------ */

function RecordingCard({ upload, phase, name }: { upload: ReturnType<typeof useUpload<AudioUploadResult>>; phase: Phase; name: string }) {
  const inputRef = useRef<HTMLInputElement>(null);
  const pick = () => inputRef.current?.click();
  const job = upload.job;
  const busy = phase === "processing";
  const peaks = useProject((s) => (s.summary?.hasRecording ? s.peaks : null));
  const engineDuration = usePlayback((s) => (s.engine && s.ready ? s.duration : null));
  const durationSec = job?.status === "succeeded" && job.result ? job.result.durationSec : engineDuration;
  const shownPeaks = job?.status === "succeeded" && job.result ? job.result.peaks : peaks;

  return (
    <section className="card flex flex-col p-5" aria-labelledby="recording-card-title">
      <CardHeader
        id="recording-card-title"
        title="Recording"
        hint="MP3 · optional"
        action={
          phase === "done" ? (
            <Button variant="outline" size="sm" leading={<RefreshCw size={13} />} onClick={pick}>
              Replace
            </Button>
          ) : null
        }
      />

      {phase === "empty" && (
        <Dropzone label="Drop an MP3 recording or browse" onFile={(f) => void upload.submit(f)} onOpen={pick} className="grain flex-1">
          <Aurora subtle />
          <EmptyHero icon={<AudioLines size={16} />} title="Drop a recording here" hint=".mp3" />
        </Dropzone>
      )}

      {busy && job && (
        <ProcessingBox name={name} size={upload.file?.size}>
          <JobLine job={job} />
        </ProcessingBox>
      )}

      {phase === "failed" && (
        <FailureBox
          name={name}
          error={upload.typeError ?? upload.startError ?? job?.error ?? "The recording could not be decoded."}
          onChoose={pick}
          onRetry={job?.status === "failed" ? upload.retry : undefined}
        />
      )}

      {phase === "done" && (
        <div className="fade-up rounded-[var(--radius-lg)] border border-line bg-paper p-4">
          <div className="flex items-center gap-2 text-[13px]">
            <AudioLines size={14} className="shrink-0 text-brass-3" aria-hidden />
            <span className="truncate font-medium text-ink">{name || "Recording"}</span>
            {durationSec !== null && durationSec > 0 && <span className="tnum shrink-0 text-ink-3">{formatTime(durationSec)}</span>}
            <Chip tone="ok" className="ml-auto shrink-0">
              Uploaded
            </Chip>
          </div>
          {shownPeaks && shownPeaks.length > 0 && <Waveform peaks={shownPeaks} progress={0} interactive={false} height={32} className="mt-3" />}
        </div>
      )}

      <p className="mt-4 text-xs text-ink-3">No recording? Playback is generated from the score and the Sync step is skipped.</p>
      <input
        ref={inputRef}
        type="file"
        accept=".mp3,audio/mpeg"
        className="hidden"
        data-testid="audio-input"
        disabled={busy}
        onChange={(e) => pickFrom(e.target, upload.submit)}
      />
    </section>
  );
}

/* ------------------------------------------------------------------ */
/* Open a saved project                                                 */
/* ------------------------------------------------------------------ */

function OpenProjectCard({ projectId, placeholderIsEmpty }: { projectId: string; placeholderIsEmpty: boolean }) {
  const router = useRouter();
  const inputRef = useRef<HTMLInputElement>(null);
  const [file, setFile] = useState<File | null>(null);
  const [typeError, setTypeError] = useState<string | null>(null);
  const onOpened = useCallback(
    (job: Job<OpenProjectResult>) => {
      const result = job.result;
      if (!result) return;
      // The project this page was created for is still empty: drop it so the library has no blank entry.
      if (placeholderIsEmpty && result.projectId !== projectId) void api.deleteProject(projectId).catch(() => {});
      router.push(`/projects/${result.projectId}/${result.hasRecording ? "sync" : "customize"}`);
    },
    [placeholderIsEmpty, projectId, router],
  );
  const { job, start, clear } = useProjectJob<OpenProjectResult>(`${projectId}:open`, { onSucceeded: onOpened, forgetOnSuccess: true });
  const busy = isRunning(job);

  const open = async (f: File) => {
    setFile(f);
    if (!hasExtension(f.name, PROJECT_EXT)) {
      clear();
      setTypeError(PROJECT_TYPE_ERROR);
      return;
    }
    setTypeError(null);
    await start(() => api.openProjectFile(f));
  };

  return (
    <section className="card-flat p-5" aria-labelledby="open-project-title">
      <div className="flex flex-wrap items-center gap-4">
        <span className="grid h-10 w-10 shrink-0 place-items-center rounded-full bg-paper-3 text-ink-2" aria-hidden>
          <FolderOpen size={16} />
        </span>
        <div className="min-w-0 flex-1">
          <h2 id="open-project-title" className="font-serif text-lg text-ink">
            Open a saved project (.ovproj)
          </h2>
          <p className="text-[13px] text-ink-3">Brings back the score, recording, markers and display settings as a new project.</p>
        </div>
        <Button variant="outline" size="sm" leading={<Upload size={13} />} onClick={() => inputRef.current?.click()} disabled={busy}>
          {file ? "Choose another" : "Choose file"}
        </Button>
      </div>
      {file && (typeError || job) && (
        <div className="mt-4 border-t border-line pt-4 text-[13px]">
          <div className="mb-2 flex items-center gap-2">
            <span className="truncate text-ink">{file.name}</span>
            <span className="tnum text-ink-3">{formatBytes(file.size)}</span>
          </div>
          {typeError && <p className="text-danger">{typeError}</p>}
          {job && busy && <JobLine job={job} />}
          {job?.status === "succeeded" && <p className="text-ink-3">Opening the project…</p>}
          {job?.status === "failed" && (
            <div className="flex flex-wrap items-center gap-3">
              <p className="flex-1 text-danger">{job.error ?? "The project file could not be opened."}</p>
              <Button variant="primary" size="sm" leading={<RefreshCw size={13} />} onClick={() => void open(file)}>
                Retry
              </Button>
            </div>
          )}
        </div>
      )}
      <input ref={inputRef} type="file" accept=".ovproj" className="hidden" data-testid="project-input" onChange={(e) => pickFrom(e.target, open)} />
    </section>
  );
}

/* ------------------------------------------------------------------ */
/* Small pieces                                                         */
/* ------------------------------------------------------------------ */

function CardHeader({ id, title, hint, action }: { id: string; title: string; hint: string; action: ReactNode }) {
  return (
    <div className="mb-4 flex min-h-8 items-center justify-between gap-3">
      <div className="flex items-baseline gap-2.5">
        <h2 id={id} className="font-serif text-xl text-ink">
          {title}
        </h2>
        <span className="text-[13px] text-ink-3">{hint}</span>
      </div>
      {action}
    </div>
  );
}

function EmptyHero({ icon, title, hint }: { icon: ReactNode; title: string; hint: string }) {
  return (
    <div className="relative z-10 flex min-h-[200px] flex-col items-center justify-center px-6 py-10 text-center">
      <span className="mb-4 grid h-11 w-11 place-items-center rounded-full bg-paper-2 text-brass shadow-sm" aria-hidden>
        {icon}
      </span>
      <p className="font-serif text-xl text-ink">{title}</p>
      <p className="mt-1 text-[13px] text-ink-3">
        or <span className="text-brass underline underline-offset-2">browse</span> · {hint}
      </p>
    </div>
  );
}

function ProcessingBox({ name, size, children }: { name: string; size?: number; children: ReactNode }) {
  return (
    <div className="rounded-[var(--radius-lg)] border border-line bg-paper p-4" aria-live="polite">
      <div className="mb-3 flex items-center gap-2 text-[13px]">
        <span className="truncate font-medium text-ink">{name}</span>
        {size !== undefined && <span className="tnum shrink-0 text-ink-3">{formatBytes(size)}</span>}
      </div>
      {children}
    </div>
  );
}

function FailureBox({ name, error, onChoose, onRetry }: { name: string; error: string; onChoose: () => void; onRetry?: () => void }) {
  return (
    <div className={cx("rounded-[var(--radius-lg)] border border-danger/30 bg-[color-mix(in_srgb,var(--danger)_6%,transparent)] p-4")} role="alert">
      <div className="flex items-start gap-3">
        <AlertTriangle size={16} className="mt-0.5 shrink-0 text-danger" aria-hidden />
        <div className="min-w-0">
          {name && <p className="truncate text-[13px] font-medium text-ink">{name}</p>}
          <p className="text-[13px] leading-relaxed text-ink-2">{error}</p>
        </div>
      </div>
      <div className="mt-4 flex flex-wrap gap-2">
        <Button variant="outline" size="sm" onClick={onChoose}>
          Choose another file
        </Button>
        {onRetry && (
          <Button variant="primary" size="sm" leading={<RefreshCw size={13} />} onClick={onRetry}>
            Retry
          </Button>
        )}
      </div>
    </div>
  );
}

function pickFrom(input: HTMLInputElement, cb: (file: File) => unknown) {
  const file = input.files?.[0];
  if (file) cb(file);
  input.value = "";
}
