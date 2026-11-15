// TEMPORARY, REMOVE BEFORE AN OFFICIAL LAUNCH: team-testing aid only. The
// Hallé recording is a commercial release and the score's license is unclear.
// Removal checklist: README.md ("Temporary, remove before an official launch").
//
// The sample project: Tchaikovsky's Symphony No. 6, first movement, with the
// Hallé recording and a finished sync, put in each user's library once so
// teammates have a ready baseline for manual testing.
//
// Files live in fixtures/sample/ (shipped in the Docker image):
//   tchaikovsky-6-mvt1.mxl        the score
//   halle-tchaikovsky-6-mvt1.mp3  the recording
//   recording.json                its duration and overview peaks (as the client computes them at upload)
//   sync.json                     a known-good sync (integrated aligner, no markers)
//
// The project goes through the normal paths (score parse, audio registration,
// sync save), so it behaves like an uploaded one. A row in app.sample_projects
// records that the user got it: deleting the project does not bring it back.
import { readFile } from "node:fs/promises";
import path from "node:path";
import { parseSyncState } from "@/shared/sync";
import { query } from "../db/client";
import { newProjectObjectKey } from "../storage/keys";
import { putObjectBytes } from "../storage/objects";
import type { RegisterScoreResponse } from "@/shared/api";
import { assertProjectOwned, createProject, deleteProject, patchProject, registerAudio, registerScore, saveSync } from "./projects";

export const SAMPLE_TITLE = "Sample · Tchaikovsky 6 (Hallé)";
const SAMPLE_DIR = path.join(process.cwd(), "fixtures", "sample");
const SCORE_FILE = "tchaikovsky-6-mvt1.mxl";
const AUDIO_FILE = "halle-tchaikovsky-6-mvt1.mp3";
const SCORE_NAME = "symphony-no-6-opus-74-1st-movement-tchaikovsky.mxl";
const AUDIO_NAME = "The Hallé - Tchaikovsky Symphony No.6, 1st movement.mp3";

/** in-process guard so parallel library loads create one sample */
const inFlight = new Map<number, Promise<void>>();

/** Give the user the sample project if they never had it. Never throws: the library must load regardless. */
export async function ensureSampleProject(userId: number): Promise<void> {
  const running = inFlight.get(userId);
  if (running) return running;
  const run = createSampleOnce(userId)
    .catch((err) => console.error(`sample project for user ${userId} failed`, err))
    .finally(() => inFlight.delete(userId));
  inFlight.set(userId, run);
  return run;
}

/**
 * Put the sample score and recording into a project the user owns, as if
 * they had uploaded them (the Import page's "Use the sample files"): the
 * score is registered and parsed (the returned job tracks it), the recording
 * registered with its precomputed peaks. Replaces what the project had.
 */
export async function addSampleFiles(userId: number, projectId: number, options: { awaitParse?: boolean } = {}): Promise<RegisterScoreResponse> {
  await assertProjectOwned(userId, projectId);
  const [score, audio, recording] = await Promise.all([
    readFile(path.join(SAMPLE_DIR, SCORE_FILE)),
    readFile(path.join(SAMPLE_DIR, AUDIO_FILE)),
    readFile(path.join(SAMPLE_DIR, "recording.json"), "utf8"),
  ]);
  const { durationSec, peaks } = JSON.parse(recording) as { durationSec: number; peaks: number[] };

  const audioKey = newProjectObjectKey(userId, projectId, "audio", AUDIO_NAME);
  await putObjectBytes(audioKey, new Uint8Array(audio), "audio/mpeg");
  await registerAudio(userId, projectId, { key: audioKey, filename: AUDIO_NAME, durationSec, peaks });

  const scoreKey = newProjectObjectKey(userId, projectId, "score", SCORE_NAME);
  await putObjectBytes(scoreKey, new Uint8Array(score), "application/vnd.recordare.musicxml");
  return registerScore(userId, projectId, { key: scoreKey, filename: SCORE_NAME }, options);
}

async function createSampleOnce(userId: number): Promise<void> {
  // claim first: a user gets the sample once, even across processes
  const claimed = await query<{ user_id: number }>(
    "INSERT INTO app.sample_projects (user_id) VALUES ($1) ON CONFLICT (user_id) DO NOTHING RETURNING user_id",
    [userId],
  );
  if (claimed.length === 0) return;

  let projectId: number | null = null;
  try {
    const syncJson = await readFile(path.join(SAMPLE_DIR, "sync.json"), "utf8");
    const { sync } = parseSyncState(JSON.parse(syncJson), "strict");

    const project = await createProject(userId, { title: SAMPLE_TITLE });
    projectId = Number(project.id);
    await query("UPDATE app.sample_projects SET project_id = $2 WHERE user_id = $1", [userId, projectId]);

    await addSampleFiles(userId, projectId, { awaitParse: true });
    const [parsed] = await query<{ parse_status: string; parse_error: string | null }>(
      "SELECT parse_status, parse_error FROM app.projects WHERE id = $1 AND user_id = $2",
      [projectId, userId],
    );
    if (parsed?.parse_status !== "succeeded") throw new Error(`the sample score did not parse: ${parsed?.parse_error ?? parsed?.parse_status}`);

    await saveSync(userId, projectId, sync);
    await patchProject(userId, projectId, { title: SAMPLE_TITLE, stage: "customize" });
  } catch (err) {
    // undo so the next library load tries again
    if (projectId !== null) await deleteProject(userId, projectId).catch(() => {});
    await query("DELETE FROM app.sample_projects WHERE user_id = $1", [userId]).catch(() => {});
    throw err;
  }
}
