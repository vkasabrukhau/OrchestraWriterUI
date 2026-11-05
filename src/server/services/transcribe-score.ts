// The transcribe job (EXPERIMENTAL, branch sulaiman/audio-to-score): turn a
// project's recording into a score with the local MuScriptor service
// (ml/server.py), then import that score exactly like an uploaded one.
//
//   recording from S3 -> POST {transcriber}/score -> poll until done
//   -> MusicXML to the project's score folder -> registerScore (parse-score job)
//
// Progress lives on the app.jobs row (kind "transcribe"), which clients poll.
// The parse-score job that follows is the normal import path, so Sync,
// Customize, Preview and Export work on the result unchanged.
import type { JobDto } from "@/shared/api";
import type { TranscribeScoreResult } from "@/shared/jobs";
import { env } from "../config/env";
import { query } from "../db/client";
import { NotFoundError, ValidationError } from "../errors";
import { newProjectObjectKey } from "../storage/keys";
import { MAX_UPLOAD_BYTES } from "../storage/limits";
import { getObjectBytes, putObjectBytes } from "../storage/objects";
import { logActivity } from "./activity";
import { createJob, finishJob, jobToDto, updateJobProgress } from "./jobs";
import { registerScore } from "./projects";

const POLL_MS = 2000;
/** Give up on a transcription that has not finished after this long. */
const MAX_WAIT_MS = 3 * 60 * 60 * 1000;

type ServiceJob = {
  status: "running" | "succeeded" | "failed";
  progress: number;
  message: string;
  error: string | null;
  result: { musicxml: string; parts: string[]; bpm: number | null; model: string; seconds: number } | null;
};

/** Start transcribing the project's recording. Answers at once with the job. */
export async function startTranscribeScore(userId: number, projectId: number): Promise<JobDto> {
  const [row] = await query<{ s3_key: string | null; name: string | null }>(
    `SELECT a.s3_key, a.name
       FROM app.projects p LEFT JOIN app.audio_files a ON a.id = p.audio_file_id
      WHERE p.id = $1 AND p.user_id = $2`,
    [projectId, userId],
  );
  if (!row) throw new NotFoundError("Project");
  if (!row.s3_key) throw new ValidationError("Upload a recording before transcribing it");
  if (!env.transcriber.url) throw new ValidationError("The transcription service is not configured (TRANSCRIBER_URL)");

  const job = await createJob(userId, { projectId, kind: "transcribe", message: "Starting transcription" });
  void runTranscribeScore({ userId, projectId, jobId: job.id, audioKey: row.s3_key, audioName: row.name ?? "recording.mp3" });
  return jobToDto(job);
}

async function runTranscribeScore(input: { userId: number; projectId: number; jobId: number; audioKey: string; audioName: string }) {
  const { userId, projectId, jobId } = input;
  const base = env.transcriber.url!.replace(/\/$/, "");
  try {
    await updateJobProgress(jobId, 0.02, "Reading the recording");
    const audio = await getObjectBytes(input.audioKey, { maxBytes: MAX_UPLOAD_BYTES.audio });
    const stem = input.audioName.replace(/\.[a-z0-9]+$/i, "") || "Recording";

    let started: Response;
    try {
      started = await fetch(`${base}/score?${new URLSearchParams({ filename: input.audioName, title: stem })}`, {
        method: "POST",
        headers: { "content-type": "application/octet-stream" },
        body: Buffer.from(audio),
      });
    } catch {
      throw new Error(`The transcription service is not running at ${base}. Start it with: npm run ml:serve`);
    }
    if (!started.ok) throw new Error(`Transcription service: ${await errorText(started)}`);
    const { id } = (await started.json()) as { id: string };

    const deadline = Date.now() + MAX_WAIT_MS;
    let job: ServiceJob;
    for (;;) {
      await new Promise((r) => setTimeout(r, POLL_MS));
      const res = await fetch(`${base}/score/${encodeURIComponent(id)}`);
      if (!res.ok) throw new Error(`Transcription service: ${await errorText(res)}`);
      job = (await res.json()) as ServiceJob;
      if (job.status !== "running") break;
      if (Date.now() > deadline) throw new Error("The transcription took too long");
      // The service reports 0–1; keep the last few percent for importing the score.
      await updateJobProgress(jobId, 0.05 + job.progress * 0.85, job.message);
    }
    if (job.status === "failed" || !job.result) throw new Error(job.error ?? "The transcription failed");

    await updateJobProgress(jobId, 0.92, "Importing the transcribed score");
    const filename = `${stem} (transcribed).musicxml`;
    const key = newProjectObjectKey(userId, projectId, "score", filename);
    await putObjectBytes(key, job.result.musicxml, "application/vnd.recordare.musicxml+xml");
    const { job: parse } = await registerScore(userId, projectId, { key, filename });

    const result: TranscribeScoreResult = {
      parts: job.result.parts,
      bpm: job.result.bpm,
      model: job.result.model,
      seconds: job.result.seconds,
      parseJobId: parse.id,
    };
    await finishJob(jobId, { status: "succeeded", result, message: "Done" });
    await logActivity(userId, projectId, "import",
      `Transcribed score from recording · ${result.parts.length} parts (${result.model})`);
  } catch (err) {
    console.error(`transcribe job ${jobId} (project ${projectId}) failed`, err);
    const message = err instanceof Error ? err.message : String(err);
    await finishJob(jobId, { status: "failed", error: message, message: "Transcription failed" })
      .catch((e) => console.error(`could not record failure of job ${jobId}`, e));
  }
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
