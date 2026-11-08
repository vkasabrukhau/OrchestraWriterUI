// Projects: rows in app.projects plus their objects in S3.
// Every query filters by user_id; a project that is missing or someone else's is a NotFoundError (404).
import type {
  ProjectDto,
  ProjectUrls,
  RegisterScoreResponse,
} from "@/shared/api";
import type { ProjectStage, ProjectStatus, ProjectSummary } from "@/shared/domain";
import type { TranscriptionInfo } from "@/shared/jobs";
import type { DisplaySettings } from "@/shared/project-file";
import type { SyncState } from "@/shared/sync";
import { query, withTransaction } from "../db/client";
import { ConflictError, ForbiddenKeyError, NotFoundError, TooLargeError, ValidationError } from "../errors";
import {
  deleteObject,
  deletePrefix,
  headObject,
  isProjectObjectKey,
  presignDownload,
  projectPrefix,
  URL_TTL_SECONDS,
} from "../storage/keys";
import type { ProjectRow } from "../types/db";
import { logActivity, logThrottled } from "./activity";
import { createJob, getJob } from "./jobs";
import { runParseScore } from "./parse-score";
import type { StoredTranscription } from "./transcribe-score";

export const DEFAULT_TITLE = "Untitled project";
export const SCORE_MAX_BYTES = 50 * 1024 * 1024;
export const AUDIO_MAX_BYTES = 500 * 1024 * 1024;

type SummaryRow = Omit<ProjectRow, "audio_peaks" | "sync" | "display"> & {
  recording_name: string | null;
  audio_key: string | null;
  has_sync: boolean;
  average_confidence: number | null;
  parse_message: string | null;
  export_count: number;
  program_ids: number[];
  transcribing: boolean;
};

type FullRow = SummaryRow & Pick<ProjectRow, "audio_peaks" | "sync" | "display">;

const SUMMARY_COLUMNS = `
  p.id, p.user_id, p.title, p.subtitle, p.composer, p.movement, p.score_filename, p.score_key, p.score_bytes,
  p.info_map_key, p.audio_file_id, p.parts, p.measures, p.duration_seconds, p.tempo, p.time_signature,
  p.warnings, p.thumbnail, p.stage, p.parse_status, p.parse_error, p.parse_job_id, p.created_at, p.updated_at,
  p.transcription,
  a.name AS recording_name, a.s3_key AS audio_key,
  (p.sync IS NOT NULL) AS has_sync,
  CASE WHEN jsonb_typeof(p.sync -> 'averageConfidence') = 'number'
       THEN (p.sync ->> 'averageConfidence')::real END AS average_confidence,
  j.message AS parse_message,
  (SELECT count(*)::int FROM app.exports e WHERE e.project_id = p.id) AS export_count,
  COALESCE((SELECT array_agg(pp.program_id ORDER BY pp.program_id)
              FROM app.program_projects pp WHERE pp.project_id = p.id), '{}') AS program_ids,
  EXISTS (SELECT 1 FROM app.jobs t
           WHERE t.project_id = p.id AND t.kind = 'transcribe' AND t.status IN ('queued', 'running')) AS transcribing`;

const FROM = `
  FROM app.projects p
  LEFT JOIN app.audio_files a ON a.id = p.audio_file_id
  LEFT JOIN app.jobs j ON j.id = p.parse_job_id`;

/** Status is derived, never stored (see docs/plan/backend-integration.md). */
function deriveStatus(row: SummaryRow): { status: ProjectStatus; statusDetail?: string } {
  if (row.parse_status === "running") return { status: "importing", statusDetail: row.parse_message || "Reading score" };
  if (row.parse_status === "failed") return { status: "failed", statusDetail: row.parse_error ?? "Import failed" };
  if (row.parse_status === "none") {
    return { status: "importing", statusDetail: row.transcribing ? "Transcribing the recording" : "Waiting for a score" };
  }
  if (row.audio_file_id !== null && !row.has_sync) return { status: "needs-sync" };
  if (row.export_count > 0) return { status: "exported" };
  return { status: "ready" };
}

export function toSummary(row: SummaryRow): ProjectSummary {
  const { status, statusDetail } = deriveStatus(row);
  const summary: ProjectSummary = {
    id: String(row.id),
    title: row.title,
    composer: row.composer,
    movement: row.movement,
    parts: row.parts,
    measures: row.measures,
    durationSec: row.duration_seconds,
    hasRecording: row.audio_file_id !== null,
    scoreName: row.score_filename ?? "",
    stage: row.stage as ProjectStage,
    status,
    updatedAt: row.updated_at.toISOString(),
    createdAt: row.created_at.toISOString(),
    programIds: row.program_ids.map(String),
    thumbnail: Array.isArray(row.thumbnail) ? (row.thumbnail as ProjectSummary["thumbnail"]) : [],
    exports: row.export_count,
  };
  if (row.subtitle) summary.subtitle = row.subtitle;
  if (row.recording_name) summary.recordingName = row.recording_name;
  if (statusDetail) summary.statusDetail = statusDetail;
  if (row.average_confidence !== null) summary.averageConfidence = row.average_confidence;
  if (row.transcribing) summary.transcribing = true;
  if (row.transcription) summary.transcription = transcriptionInfo(row.transcription as StoredTranscription);
  return summary;
}

/** The wire form of a stored transcription: everything but the S3 key and title. */
function transcriptionInfo(stored: StoredTranscription): TranscriptionInfo {
  const { model, detected, bars, bpm, beatsPerBar, warnings } = stored;
  return { model, detected, bars, bpm, beatsPerBar, warnings };
}

function toDto(row: FullRow): ProjectDto {
  return {
    ...toSummary(row),
    scoreKey: row.score_key,
    audioFileId: row.audio_file_id === null ? null : String(row.audio_file_id),
    audioKey: row.audio_key,
    infoMapKey: row.info_map_key,
    audioPeaks: Array.isArray(row.audio_peaks) ? row.audio_peaks : null,
    parseJobId: row.parse_job_id === null ? null : String(row.parse_job_id),
    sync: (row.sync ?? null) as SyncState | null,
    display: (row.display ?? null) as DisplaySettings | null,
  };
}

export async function listProjects(userId: number): Promise<ProjectSummary[]> {
  const rows = await query<SummaryRow>(
    `SELECT ${SUMMARY_COLUMNS} ${FROM} WHERE p.user_id = $1 ORDER BY p.updated_at DESC, p.id DESC`,
    [userId],
  );
  return rows.map(toSummary);
}

/** Summaries for a set of ids, in the order given; ids the user does not own are skipped. */
export async function listProjectsByIds(userId: number, ids: number[]): Promise<ProjectSummary[]> {
  if (ids.length === 0) return [];
  const rows = await query<SummaryRow>(
    `SELECT ${SUMMARY_COLUMNS} ${FROM} WHERE p.user_id = $1 AND p.id = ANY($2::int[])`,
    [userId, ids],
  );
  const byId = new Map(rows.map((r) => [r.id, r]));
  return ids.flatMap((id) => {
    const row = byId.get(id);
    return row ? [toSummary(row)] : [];
  });
}

export async function getProject(userId: number, projectId: number): Promise<ProjectDto> {
  const [row] = await query<FullRow>(
    `SELECT ${SUMMARY_COLUMNS}, p.audio_peaks, p.sync, p.display ${FROM} WHERE p.id = $1 AND p.user_id = $2`,
    [projectId, userId],
  );
  if (!row) throw new NotFoundError("Project");
  return toDto(row);
}

/** Throws NotFoundError unless the project exists and belongs to userId. */
async function ownedProject(userId: number, projectId: number): Promise<ProjectRow> {
  const [row] = await query<ProjectRow>("SELECT * FROM app.projects WHERE id = $1 AND user_id = $2", [projectId, userId]);
  if (!row) throw new NotFoundError("Project");
  return row;
}

export async function assertProjectOwned(userId: number, projectId: number): Promise<void> {
  await ownedProject(userId, projectId);
}

export async function createProject(userId: number, input: { title?: string }): Promise<ProjectDto> {
  const [row] = await query<{ id: number }>(
    "INSERT INTO app.projects (user_id, title) VALUES ($1, $2) RETURNING id",
    [userId, input.title || DEFAULT_TITLE],
  );
  return getProject(userId, row!.id);
}

export type ProjectChanges = {
  title?: string;
  subtitle?: string | null;
  composer?: string;
  movement?: string;
  stage?: ProjectStage;
  programIds?: number[];
};

export async function patchProject(userId: number, projectId: number, changes: ProjectChanges): Promise<ProjectDto> {
  await withTransaction(async (db) => {
    const found = await db.query("SELECT id FROM app.projects WHERE id = $1 AND user_id = $2 FOR UPDATE", [projectId, userId]);
    if (found.rowCount === 0) throw new NotFoundError("Project");

    const sets: string[] = [];
    const params: unknown[] = [projectId, userId];
    const set = (column: string, value: unknown) => {
      params.push(value);
      sets.push(`${column} = $${params.length}`);
    };
    if (changes.title !== undefined) set("title", changes.title);
    if (changes.subtitle !== undefined) set("subtitle", changes.subtitle);
    if (changes.composer !== undefined) set("composer", changes.composer);
    if (changes.movement !== undefined) set("movement", changes.movement);
    if (changes.stage !== undefined) set("stage", changes.stage);
    sets.push("updated_at = now()");
    await db.query(`UPDATE app.projects SET ${sets.join(", ")} WHERE id = $1 AND user_id = $2`, params);

    if (changes.programIds !== undefined) {
      const wanted = [...new Set(changes.programIds)];
      const owned = await db.query<{ id: number }>(
        "SELECT id FROM app.programs WHERE user_id = $1 AND id = ANY($2::int[])",
        [userId, wanted],
      );
      if (owned.rowCount !== wanted.length) throw new NotFoundError("Program");
      await db.query(
        `DELETE FROM app.program_projects pp USING app.programs pr
          WHERE pp.project_id = $1 AND pr.id = pp.program_id AND pr.user_id = $2
            AND NOT (pp.program_id = ANY($3::int[]))`,
        [projectId, userId, wanted],
      );
      // New memberships go to the end of each program's running order.
      await db.query(
        `INSERT INTO app.program_projects (program_id, project_id, position)
         SELECT pr.id, $1,
                COALESCE((SELECT max(position) + 1 FROM app.program_projects x WHERE x.program_id = pr.id), 0)
           FROM app.programs pr
          WHERE pr.user_id = $2 AND pr.id = ANY($3::int[])
         ON CONFLICT (program_id, project_id) DO NOTHING`,
        [projectId, userId, wanted],
      );
    }
  });
  return getProject(userId, projectId);
}

/** Rows first (cascades jobs, exports, activity, running-order entries), then every object under the project prefix. */
export async function deleteProject(userId: number, projectId: number): Promise<void> {
  await withTransaction(async (db) => {
    const res = await db.query<{ audio_file_id: number | null }>(
      "DELETE FROM app.projects WHERE id = $1 AND user_id = $2 RETURNING audio_file_id",
      [projectId, userId],
    );
    const row = res.rows[0];
    if (!row) throw new NotFoundError("Project");
    if (row.audio_file_id !== null) {
      await db.query("DELETE FROM app.audio_files WHERE id = $1 AND user_id = $2", [row.audio_file_id, userId]);
    }
  });
  try {
    await deletePrefix(projectPrefix(userId, projectId));
  } catch (err) {
    // The rows are gone; orphaned objects are a cleanup job, not a user-facing error.
    console.error(`project ${projectId} deleted; failed to remove its S3 objects`, err);
  }
}

async function bestEffortDelete(keys: Array<string | null | undefined>): Promise<void> {
  for (const key of keys) {
    if (!key) continue;
    try {
      await deleteObject(key);
    } catch (err) {
      console.error(`Failed to delete S3 object ${key}`, err);
    }
  }
}

async function uploadedSize(key: string, maxBytes: number, what: string): Promise<number> {
  const head = await headObject(key);
  if (!head) throw new ValidationError(`No uploaded ${what} at that key; PUT the file to the upload URL first`);
  if (head.bytes > maxBytes) {
    await bestEffortDelete([key]);
    throw new TooLargeError(`The ${what} is larger than ${Math.round(maxBytes / (1024 * 1024))} MB`);
  }
  return head.bytes;
}

/**
 * Record an uploaded score and start the parse-score job. Replacing a score
 * deletes the old score object and information map, and clears sync and
 * display (they describe the old parts and measures).
 */
export async function registerScore(
  userId: number,
  projectId: number,
  input: { key: string; filename: string },
  /** keepTranscription: the transcribe job registering a score it wrote (it updates the transcription itself) */
  options: { keepTranscription?: boolean } = {},
): Promise<RegisterScoreResponse> {
  await ownedProject(userId, projectId);
  if (!isProjectObjectKey(input.key, userId, projectId, "score")) throw new ForbiddenKeyError();
  const bytes = await uploadedSize(input.key, SCORE_MAX_BYTES, "score");

  const { job, oldKeys } = await withTransaction(async (db) => {
    const res = await db.query<Pick<ProjectRow, "score_key" | "info_map_key"> & { transcription_key: string | null }>(
      `SELECT score_key, info_map_key, transcription ->> 'key' AS transcription_key
         FROM app.projects WHERE id = $1 AND user_id = $2 FOR UPDATE`,
      [projectId, userId],
    );
    const current = res.rows[0];
    if (!current) throw new NotFoundError("Project");
    const replacing = current.score_key !== null && current.score_key !== input.key;

    const jobId = (await createJob(userId, { projectId, kind: "parse-score", message: "Reading score" }, db)).id;
    try {
      await db.query(
        `UPDATE app.projects
            SET score_key = $3, score_filename = $4, score_bytes = $5, info_map_key = NULL,
                parse_status = 'running', parse_error = NULL, parse_job_id = $6,
                sync = CASE WHEN $7 THEN NULL ELSE sync END,
                display = CASE WHEN $7 THEN NULL ELSE display END,
                transcription = CASE WHEN $8 THEN transcription ELSE NULL END,
                updated_at = now()
          WHERE id = $1 AND user_id = $2`,
        [projectId, userId, input.key, input.filename, bytes, jobId, replacing, Boolean(options.keepTranscription)],
      );
    } catch (err) {
      if ((err as { code?: string }).code === "23505") throw new ConflictError("That score is already registered");
      throw err;
    }
    return {
      job: jobId,
      oldKeys: [replacing ? current.score_key : null, current.info_map_key, options.keepTranscription ? null : current.transcription_key],
    };
  });

  await bestEffortDelete(oldKeys);
  // Fire and forget: the job row records progress and the outcome; clients poll GET /api/jobs/:id.
  void runParseScore({ userId, projectId, jobId: job, scoreKey: input.key, filename: input.filename });

  const [project, jobDto] = await Promise.all([getProject(userId, projectId), getJob(userId, job)]);
  return { project, job: jobDto };
}

/** Record an uploaded recording. Clears sync (it described the old recording) and moves the project to Sync. */
export async function registerAudio(
  userId: number,
  projectId: number,
  input: { key: string; filename: string; durationSec: number; peaks?: number[] },
): Promise<ProjectDto> {
  await ownedProject(userId, projectId);
  if (!isProjectObjectKey(input.key, userId, projectId, "audio")) throw new ForbiddenKeyError();
  const bytes = await uploadedSize(input.key, AUDIO_MAX_BYTES, "recording");

  const oldKeys = await withTransaction(async (db) => {
    const res = await db.query<{ audio_file_id: number | null; s3_key: string | null; transcription_key: string | null }>(
      `SELECT p.audio_file_id, a.s3_key, p.transcription ->> 'key' AS transcription_key
         FROM app.projects p LEFT JOIN app.audio_files a ON a.id = p.audio_file_id
        WHERE p.id = $1 AND p.user_id = $2
        FOR UPDATE OF p`,
      [projectId, userId],
    );
    const current = res.rows[0];
    if (!current) throw new NotFoundError("Project");

    let audioId: number;
    try {
      const inserted = await db.query<{ id: number }>(
        `INSERT INTO app.audio_files (user_id, name, s3_key, audio_length_seconds, bytes)
         VALUES ($1, $2, $3, $4, $5) RETURNING id`,
        [userId, input.filename.slice(0, 100), input.key, Math.max(1, Math.round(input.durationSec)), bytes],
      );
      audioId = inserted.rows[0]!.id;
    } catch (err) {
      if ((err as { code?: string }).code === "23505") throw new ConflictError("That recording is already registered");
      throw err;
    }
    await db.query(
      `UPDATE app.projects
          SET audio_file_id = $3, audio_peaks = $4::jsonb, sync = NULL, transcription = NULL, stage = 'sync', updated_at = now()
        WHERE id = $1 AND user_id = $2`,
      [projectId, userId, audioId, input.peaks ? JSON.stringify(input.peaks) : null],
    );
    if (current.audio_file_id !== null && current.audio_file_id !== audioId) {
      await db.query("DELETE FROM app.audio_files WHERE id = $1 AND user_id = $2", [current.audio_file_id, userId]);
      return [current.s3_key, current.transcription_key];
    }
    return [current.transcription_key];
  });

  await bestEffortDelete(oldKeys);
  await logActivity(userId, projectId, "import", `Added recording · ${input.filename}`);
  return getProject(userId, projectId);
}

export async function removeAudio(userId: number, projectId: number): Promise<ProjectDto> {
  const oldKeys = await withTransaction(async (db) => {
    const res = await db.query<{ audio_file_id: number | null; s3_key: string | null; transcription_key: string | null }>(
      `SELECT p.audio_file_id, a.s3_key, p.transcription ->> 'key' AS transcription_key
         FROM app.projects p LEFT JOIN app.audio_files a ON a.id = p.audio_file_id
        WHERE p.id = $1 AND p.user_id = $2
        FOR UPDATE OF p`,
      [projectId, userId],
    );
    const current = res.rows[0];
    if (!current) throw new NotFoundError("Project");
    await db.query(
      `UPDATE app.projects
          SET audio_file_id = NULL, audio_peaks = NULL, sync = NULL, transcription = NULL,
              stage = CASE WHEN stage = 'sync' THEN 'customize' ELSE stage END,
              updated_at = now()
        WHERE id = $1 AND user_id = $2`,
      [projectId, userId],
    );
    if (current.audio_file_id === null) return [current.transcription_key];
    await db.query("DELETE FROM app.audio_files WHERE id = $1 AND user_id = $2", [current.audio_file_id, userId]);
    return [current.s3_key, current.transcription_key];
  });
  await bestEffortDelete(oldKeys);
  return getProject(userId, projectId);
}

/** Presigned GETs (15 min) for the score, the recording and the information map. */
export async function getProjectUrls(userId: number, projectId: number): Promise<ProjectUrls> {
  const [row] = await query<{ score_key: string | null; info_map_key: string | null; audio_key: string | null }>(
    `SELECT p.score_key, p.info_map_key, a.s3_key AS audio_key
       FROM app.projects p LEFT JOIN app.audio_files a ON a.id = p.audio_file_id
      WHERE p.id = $1 AND p.user_id = $2`,
    [projectId, userId],
  );
  if (!row) throw new NotFoundError("Project");
  const [score, audio, infoMap] = await Promise.all([
    row.score_key ? presignDownload(row.score_key) : null,
    row.audio_key ? presignDownload(row.audio_key) : null,
    row.info_map_key ? presignDownload(row.info_map_key) : null,
  ]);
  return { score, audio, infoMap, expiresInSeconds: URL_TTL_SECONDS };
}

export async function saveSync(userId: number, projectId: number, sync: SyncState): Promise<ProjectDto> {
  const updated = await query(
    "UPDATE app.projects SET sync = $3::jsonb, updated_at = now() WHERE id = $1 AND user_id = $2 RETURNING id",
    [projectId, userId, JSON.stringify(sync)],
  );
  if (updated.length === 0) throw new NotFoundError("Project");
  await logThrottled(userId, projectId, "sync", `Saved sync · ${Math.round(sync.averageConfidence)}% average confidence`);
  return getProject(userId, projectId);
}

export async function saveDisplay(userId: number, projectId: number, display: DisplaySettings): Promise<ProjectDto> {
  const updated = await query(
    "UPDATE app.projects SET display = $3::jsonb, updated_at = now() WHERE id = $1 AND user_id = $2 RETURNING id",
    [projectId, userId, JSON.stringify(display)],
  );
  if (updated.length === 0) throw new NotFoundError("Project");
  await logThrottled(userId, projectId, "edit", "Edited the display");
  return getProject(userId, projectId);
}
