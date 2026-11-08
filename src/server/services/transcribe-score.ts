// The transcribe job (EXPERIMENTAL): turn a project's recording into a score
// with the local MuScriptor service (ml/server.py), then import that score
// exactly like an uploaded one.
//
//   recording from S3 -> POST {transcriber}/score -> poll until done
//   -> MusicXML to the project's score folder -> registerScore (parse-score job)
//   -> measure starts saved as the sync
//
// Progress lives on the app.jobs row (kind "transcribe"), which clients poll.
// The parse-score job that follows is the normal import path, so Sync,
// Customize, Preview and Export work on the result unchanged. The service also
// reports where each measure starts in the recording (the beat grid the notes
// were written against); once the score is parsed those times are saved as
// the project's sync, so the Sync step opens already aligned.
//
// The transcription itself (the model's notes and the beat grid) is kept in S3
// next to the score, so the bars can be corrected (time signature, bar lines
// moved by whole beats, half/double tempo) without running the model again:
// POST {transcriber}/rebar rewrites the score in seconds and it is imported the
// same way, as another job of kind "transcribe".
import type { JobDto } from "@/shared/api";
import type { TranscribeEnsemble, TranscribeScoreResult, TranscriptionBars, TranscriptionInfo } from "@/shared/jobs";
import type { SyncState } from "@/shared/sync";
import { env } from "../config/env";
import { query } from "../db/client";
import { ConflictError, NotFoundError, ValidationError } from "../errors";
import { deleteObject, newProjectObjectKey } from "../storage/keys";
import { MAX_UPLOAD_BYTES } from "../storage/limits";
import { getObjectBytes, putObjectBytes } from "../storage/objects";
import { logActivity } from "./activity";
import { createJob, findActiveJob, finishJob, getJob, jobToDto, updateJobProgress } from "./jobs";
import { registerScore, saveSync } from "./projects";

const POLL_MS = 2000;
/** Give up on a transcription that has not finished after this long. */
const MAX_WAIT_MS = 3 * 60 * 60 * 1000;
/** Rewriting the bars of a long piece is music21 work: seconds, rarely a minute. */
const REBAR_TIMEOUT_MS = 5 * 60 * 1000;
/** How long to wait for the parse-score job before giving up on seeding the sync. */
const PARSE_WAIT_MS = 2 * 60 * 1000;
const TRANSCRIPTION_MAX_BYTES = 50 * 1024 * 1024;
/** SyncState.method for measure starts that come from the transcription's own beat grid. */
export const TRANSCRIPTION_SYNC_METHOD = "transcription-beats";

/** app.projects.transcription: the wire info plus where the transcription lives. */
export type StoredTranscription = TranscriptionInfo & {
  /** S3 key of the transcription JSON (notes + beat grid) from the service */
  key: string;
  /** score title the service writes */
  title: string;
};

/** A score written by the service (/score result or /rebar answer). */
type Rendered = {
  musicxml: string;
  parts: string[];
  bpm: number;
  beatsPerBar: number;
  /** recording seconds at which each measure starts */
  measureStarts: number[];
  warnings: string[];
  detected: TranscriptionInfo["detected"];
  bars: TranscriptionBars;
};

type ServiceJob = {
  status: "running" | "succeeded" | "failed";
  progress: number;
  message: string;
  error: string | null;
  result: (Rendered & { model: string; seconds: number; transcription?: unknown }) | null;
};

/**
 * Start transcribing the project's recording. Answers at once with the job.
 * A transcription already running on the project is answered instead of
 * starting a second one; with `resume` nothing new is started (404 when no
 * transcription is running), which is how a page that lost track of the job
 * (a reload) picks it back up.
 */
export async function startTranscribeScore(
  userId: number,
  projectId: number,
  ensemble: TranscribeEnsemble = "orchestra",
  options: { resume?: boolean } = {},
): Promise<JobDto> {
  const [row] = await query<{ s3_key: string | null; name: string | null }>(
    `SELECT a.s3_key, a.name
       FROM app.projects p LEFT JOIN app.audio_files a ON a.id = p.audio_file_id
      WHERE p.id = $1 AND p.user_id = $2`,
    [projectId, userId],
  );
  if (!row) throw new NotFoundError("Project");

  const running = await findActiveJob(userId, projectId, "transcribe");
  if (running) return jobToDto(running);
  if (options.resume) throw new NotFoundError("Transcription");

  if (!row.s3_key) throw new ValidationError("Upload a recording before transcribing it");
  if (!env.transcriber.url) throw new ValidationError("The transcription service is not configured (TRANSCRIBER_URL)");
  const job = await createJob(userId, { projectId, kind: "transcribe", message: "Starting transcription" });
  void runTranscribeScore({ userId, projectId, jobId: job.id, audioKey: row.s3_key, audioName: row.name ?? "recording.mp3", ensemble });
  return jobToDto(job);
}

/**
 * Rewrite a transcribed score with corrected bars (no model run). Answers at
 * once with the job; the new score replaces the old one and the sync is
 * re-saved from the new measure starts.
 */
export async function startRebarTranscription(userId: number, projectId: number, bars: TranscriptionBars): Promise<JobDto> {
  const [row] = await query<{ transcription: StoredTranscription | null }>(
    "SELECT transcription FROM app.projects WHERE id = $1 AND user_id = $2",
    [projectId, userId],
  );
  if (!row) throw new NotFoundError("Project");
  if (!row.transcription) throw new ValidationError("This score was not transcribed from the recording");
  if (!env.transcriber.url) throw new ValidationError("The transcription service is not configured (TRANSCRIBER_URL)");
  if (await findActiveJob(userId, projectId, "transcribe")) {
    throw new ConflictError("A transcription is already running on this project");
  }
  const job = await createJob(userId, { projectId, kind: "transcribe", message: "Rewriting the bars" });
  void runRebar({ userId, projectId, jobId: job.id, stored: row.transcription, bars });
  return jobToDto(job);
}

async function runTranscribeScore(input: {
  userId: number;
  projectId: number;
  jobId: number;
  audioKey: string;
  audioName: string;
  ensemble: TranscribeEnsemble;
}) {
  const { userId, projectId, jobId } = input;
  const base = serviceUrl();
  try {
    await updateJobProgress(jobId, 0.02, "Reading the recording");
    const audio = await getObjectBytes(input.audioKey, { maxBytes: MAX_UPLOAD_BYTES.audio });
    const title = input.audioName.replace(/\.[a-z0-9]+$/i, "") || "Recording";

    const started = await callService(`${base}/score?${new URLSearchParams({ filename: input.audioName, title, ensemble: input.ensemble })}`, {
      method: "POST",
      headers: { "content-type": "application/octet-stream" },
      body: Buffer.from(audio),
    });
    const { id } = (await started.json()) as { id: string };

    const deadline = Date.now() + MAX_WAIT_MS;
    let job: ServiceJob;
    for (;;) {
      await new Promise((r) => setTimeout(r, POLL_MS));
      job = (await (await callService(`${base}/score/${encodeURIComponent(id)}`)).json()) as ServiceJob;
      if (job.status !== "running") break;
      if (Date.now() > deadline) throw new Error("The transcription took too long");
      // The service reports 0–1; keep the last few percent for importing the score.
      await updateJobProgress(jobId, 0.05 + job.progress * 0.85, job.message);
    }
    if (job.status === "failed" || !job.result) throw new Error(job.error ?? "The transcription failed");

    // Keep the transcription so the bars can be corrected later without the model.
    let transcriptionKey: string | null = null;
    if (job.result.transcription) {
      transcriptionKey = newProjectObjectKey(userId, projectId, "score", "transcription.json");
      await putObjectBytes(transcriptionKey, JSON.stringify(job.result.transcription), "application/json");
    }
    const result = await importRendered({
      userId,
      projectId,
      jobId,
      rendered: job.result,
      transcription: transcriptionKey ? { key: transcriptionKey, title, model: job.result.model } : null,
      seconds: job.result.seconds,
    });
    await logActivity(userId, projectId, "import", `Transcribed score from recording · ${result.parts.length} parts (${result.model})`);
  } catch (err) {
    await fail(jobId, projectId, err, "Transcription failed");
  }
}

async function runRebar(input: { userId: number; projectId: number; jobId: number; stored: StoredTranscription; bars: TranscriptionBars }) {
  const { userId, projectId, jobId, stored } = input;
  const t = Date.now();
  try {
    await updateJobProgress(jobId, 0.1, "Rewriting the bars");
    const transcription = JSON.parse(Buffer.from(await getObjectBytes(stored.key, { maxBytes: TRANSCRIPTION_MAX_BYTES })).toString("utf8")) as unknown;
    const res = await callService(`${serviceUrl()}/rebar`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ transcription, bars: input.bars }),
      signal: AbortSignal.timeout(REBAR_TIMEOUT_MS),
    });
    const rendered = (await res.json()) as Rendered;
    await importRendered({
      userId,
      projectId,
      jobId,
      rendered,
      transcription: { key: stored.key, title: stored.title, model: stored.model },
      seconds: Math.round((Date.now() - t) / 100) / 10,
    });
    await logActivity(userId, projectId, "import", `Rewrote the bars of the transcribed score · ${describeBars(rendered)}`);
  } catch (err) {
    await fail(jobId, projectId, err, "Rewriting the bars failed");
  }
}

/**
 * The shared tail: store the MusicXML, import it (parse-score), record the
 * transcription's bar settings and caveats on the project, seed the sync.
 */
async function importRendered(input: {
  userId: number;
  projectId: number;
  jobId: number;
  rendered: Rendered;
  /** null when the service sent no transcription (bars can't be corrected then) */
  transcription: { key: string; title: string; model: string } | null;
  seconds: number;
}): Promise<TranscribeScoreResult> {
  const { userId, projectId, jobId, rendered } = input;
  if (typeof rendered.musicxml !== "string" || !Array.isArray(rendered.parts)) {
    throw new Error("The transcription service sent no score");
  }
  await updateJobProgress(jobId, 0.92, "Importing the transcribed score");
  const title = input.transcription?.title ?? "Recording";
  const filename = `${title} (transcribed).musicxml`;
  const key = newProjectObjectKey(userId, projectId, "score", filename);
  await putObjectBytes(key, rendered.musicxml, "application/vnd.recordare.musicxml+xml");
  const { job: parse } = await registerScore(userId, projectId, { key, filename }, { keepTranscription: true });

  const model = input.transcription?.model ?? "muscriptor";
  const stored: StoredTranscription | null = input.transcription && {
    key: input.transcription.key,
    title,
    model,
    detected: rendered.detected,
    bars: rendered.bars,
    bpm: rendered.bpm,
    beatsPerBar: rendered.beatsPerBar,
    warnings: Array.isArray(rendered.warnings) ? rendered.warnings : [],
  };
  const [previous] = await query<{ key: string | null }>(
    "SELECT transcription ->> 'key' AS key FROM app.projects WHERE id = $1 AND user_id = $2",
    [projectId, userId],
  );
  await query("UPDATE app.projects SET transcription = $3::jsonb, updated_at = now() WHERE id = $1 AND user_id = $2", [
    projectId,
    userId,
    stored ? JSON.stringify(stored) : null,
  ]);
  if (previous?.key && previous.key !== stored?.key) await deleteObject(previous.key).catch(() => {});

  const synced = await seedSync(userId, projectId, Number(parse.id), rendered.measureStarts);
  const result: TranscribeScoreResult = {
    parts: rendered.parts,
    bpm: rendered.bpm ?? null,
    model,
    seconds: input.seconds,
    parseJobId: parse.id,
    synced,
  };
  await finishJob(jobId, { status: "succeeded", result, message: "Done" });
  return result;
}

/**
 * Once the transcribed score is parsed, save the measure starts the service
 * reported as the project's sync. Skipped (the Sync step then auto-aligns as
 * usual) when the parse failed or the measure counts disagree.
 */
async function seedSync(userId: number, projectId: number, parseJobId: number, starts: number[] | undefined): Promise<boolean> {
  if (!starts || starts.length === 0) return false;
  const deadline = Date.now() + PARSE_WAIT_MS;
  let parse = await getJob(userId, parseJobId);
  while (parse.status === "queued" || parse.status === "running") {
    if (Date.now() > deadline) return false;
    await new Promise((r) => setTimeout(r, 250));
    parse = await getJob(userId, parseJobId);
  }
  if (parse.status !== "succeeded") return false;

  const [project] = await query<{ measures: number }>(
    "SELECT measures FROM app.projects WHERE id = $1 AND user_id = $2 AND parse_job_id = $3",
    [projectId, userId, parseJobId],
  );
  if (!project || project.measures !== starts.length) {
    console.warn(`transcribe: project ${projectId} has ${project?.measures ?? "no"} measures, the service timed ${starts.length}; leaving sync to the aligner`);
    return false;
  }
  const sync: SyncState = {
    method: TRANSCRIPTION_SYNC_METHOD,
    auto: starts.map((startSec, i) => ({ n: i + 1, startSec, confidence: 100 })),
    manual: [],
    averageConfidence: 100,
  };
  await saveSync(userId, projectId, sync);
  return true;
}

function describeBars(rendered: Rendered): string {
  const parts = [`${rendered.beatsPerBar}/4`];
  if (rendered.bars.shiftBeats) parts.push(`bar lines ${rendered.bars.shiftBeats} beat${rendered.bars.shiftBeats === 1 ? "" : "s"} later`);
  if (rendered.bars.beatScale !== 1) parts.push(rendered.bars.beatScale === 2 ? "double tempo" : "half tempo");
  return parts.join(", ");
}

function serviceUrl(): string {
  return env.transcriber.url!.replace(/\/$/, "");
}

/** fetch the service; a refused connection says how to start it, an error answer carries its detail. */
async function callService(url: string, init?: RequestInit): Promise<Response> {
  let res: Response;
  try {
    res = await fetch(url, init);
  } catch (err) {
    if (err instanceof Error && err.name === "TimeoutError") throw new Error("The transcription service took too long to answer");
    throw new Error(`The transcription service is not running at ${serviceUrl()}. Start it with: npm run ml:serve`);
  }
  if (!res.ok) throw new Error(`Transcription service: ${await errorText(res)}`);
  return res;
}

async function fail(jobId: number, projectId: number, err: unknown, message: string): Promise<void> {
  console.error(`transcribe job ${jobId} (project ${projectId}) failed`, err);
  const error = err instanceof Error ? err.message : String(err);
  await finishJob(jobId, { status: "failed", error, message }).catch((e) => console.error(`could not record failure of job ${jobId}`, e));
}

async function errorText(res: Response): Promise<string> {
  const text = await res.text().catch(() => "");
  try {
    const body = JSON.parse(text) as { detail?: unknown };
    if (typeof body.detail === "string") return body.detail;
  } catch {
    // not JSON
  }
  return text.slice(0, 500) || `HTTP ${res.status}`;
}
