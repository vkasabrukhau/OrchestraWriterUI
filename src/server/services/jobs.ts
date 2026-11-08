// Server-side visualizer jobs (app.jobs). Today only parse-score runs here;
// browser jobs (align, export) never touch this table. Polled via GET /api/jobs/:id.
import type { JobDto } from "@/shared/api";
import type { JobKind, JobStatus } from "@/shared/jobs";
import type { PoolClient } from "pg";
import { query } from "../db/client";
import { NotFoundError } from "../errors";
import type { JobRow } from "../types/db";

const COLUMNS = "id, user_id, project_id, kind, status, progress, message, result, error, created_at, updated_at";

export function jobToDto(row: JobRow): JobDto {
  const dto: JobDto = {
    id: String(row.id),
    kind: row.kind as JobKind,
    status: row.status,
    progress: Math.max(0, Math.min(1, row.progress)),
    message: row.message,
    startedAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  };
  if (row.result !== null && row.result !== undefined) dto.result = row.result;
  if (row.error) dto.error = row.error;
  return dto;
}

/** Insert a job row; pass `db` to create it inside an open transaction. */
export async function createJob(
  userId: number,
  input: { projectId: number | null; kind: JobKind; message: string; status?: JobStatus },
  db?: PoolClient,
): Promise<JobRow> {
  const sql = `INSERT INTO app.jobs (user_id, project_id, kind, status, message)
               VALUES ($1, $2, $3, $4, $5)
               RETURNING ${COLUMNS}`;
  const params = [userId, input.projectId, input.kind, input.status ?? "running", input.message];
  const rows = db ? (await db.query<JobRow>(sql, params)).rows : await query<JobRow>(sql, params);
  return rows[0]!;
}

/** Progress update from a running job. Never moves a finished job. */
export async function updateJobProgress(jobId: number, progress: number, message: string): Promise<void> {
  await query(
    `UPDATE app.jobs SET progress = $2, message = $3, updated_at = now()
      WHERE id = $1 AND status IN ('queued', 'running')`,
    [jobId, Math.max(0, Math.min(1, progress)), message],
  );
}

export async function finishJob(
  jobId: number,
  outcome: { status: "succeeded"; result: unknown; message?: string } | { status: "failed"; error: string; message?: string },
): Promise<void> {
  if (outcome.status === "succeeded") {
    await query(
      `UPDATE app.jobs SET status = 'succeeded', progress = 1, message = $2, result = $3::jsonb, error = NULL, updated_at = now()
        WHERE id = $1`,
      [jobId, outcome.message ?? "Done", JSON.stringify(outcome.result)],
    );
  } else {
    await query(
      `UPDATE app.jobs SET status = 'failed', message = $2, error = $3, updated_at = now()
        WHERE id = $1`,
      [jobId, outcome.message ?? "Failed", outcome.error.slice(0, 2000)],
    );
  }
}

/** The newest queued or running job of this kind on the project, if any. */
export async function findActiveJob(userId: number, projectId: number, kind: JobKind): Promise<JobRow | null> {
  const [row] = await query<JobRow>(
    `SELECT ${COLUMNS} FROM app.jobs
      WHERE user_id = $1 AND project_id = $2 AND kind = $3 AND status IN ('queued', 'running')
      ORDER BY id DESC LIMIT 1`,
    [userId, projectId, kind],
  );
  return row ?? null;
}

/** One job, only if it belongs to userId (404 otherwise). */
export async function getJob(userId: number, jobId: number): Promise<JobDto> {
  const [row] = await query<JobRow>(`SELECT ${COLUMNS} FROM app.jobs WHERE id = $1 AND user_id = $2`, [jobId, userId]);
  if (!row) throw new NotFoundError("Job");
  return jobToDto(row);
}
