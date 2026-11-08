// /api/projects: the signed-in user's projects, their score/recording
// registration, sync and display settings, presigned URLs and exports.
// Every service call passes userId; a project that is not the caller's is a 404.
import { Hono } from "hono";
import type { ProjectStage } from "@/shared/domain";
import { TRANSCRIBE_ENSEMBLES, TRANSCRIPTION_BEAT_SCALES, TRANSCRIPTION_METERS } from "@/shared/jobs";
import type { DisplaySettings } from "@/shared/project-file";
import { SECTIONS } from "@/shared/sections";
import type { SyncState } from "@/shared/sync";
import { ValidationError } from "../errors";
import * as exportsService from "../services/exports";
import * as projects from "../services/projects";
import { startRebarTranscription, startTranscribeScore } from "../services/transcribe-score";
import { requireUser, type AuthEnv } from "./session";
import {
  bool,
  idList,
  idParam,
  isPlainObject,
  jsonBody,
  nullableStr,
  num,
  oneOf,
  optionalJsonBody,
  optOneOf,
  optStr,
  str,
} from "./validate";
import { MAX_AUDIO_SECONDS } from "../storage/limits";

export const projectsRoutes = new Hono<AuthEnv>();

projectsRoutes.use("*", requireUser);

const STAGES: readonly ProjectStage[] = ["import", "sync", "customize", "preview", "export"];
const MAX_MEASURES = 20_000;
const MAX_PEAKS = 4_096;

const projectId = (c: Parameters<typeof idParam>[0]) => idParam(c, "id", "Project");

projectsRoutes.get("/", async (c) => {
  return c.json({ projects: await projects.listProjects(c.get("userId")) });
});

projectsRoutes.post("/", async (c) => {
  // An empty body is fine: every field is optional.
  const body = await optionalJsonBody(c);
  const title = optStr(body.title, "title", { max: 200 });
  const project = await projects.createProject(c.get("userId"), { title: title || undefined });
  return c.json({ project }, 201);
});

projectsRoutes.get("/:id", async (c) => {
  return c.json({ project: await projects.getProject(c.get("userId"), projectId(c)) });
});

projectsRoutes.patch("/:id", async (c) => {
  const id = projectId(c);
  const body = await jsonBody(c);
  const project = await projects.patchProject(c.get("userId"), id, {
    title: optStr(body.title, "title", { min: 1, max: 200 }),
    subtitle: nullableStr(body.subtitle, "subtitle", { max: 200 }),
    composer: optStr(body.composer, "composer", { max: 200 }),
    movement: optStr(body.movement, "movement", { max: 200 }),
    stage: optOneOf(body.stage, "stage", STAGES),
    programIds: body.programIds === undefined ? undefined : idList(body.programIds, "programIds"),
  });
  return c.json({ project });
});

projectsRoutes.delete("/:id", async (c) => {
  await projects.deleteProject(c.get("userId"), projectId(c));
  return c.body(null, 204);
});

projectsRoutes.post("/:id/score", async (c) => {
  const id = projectId(c);
  const body = await jsonBody(c);
  const result = await projects.registerScore(c.get("userId"), id, {
    key: str(body.key, "key", { min: 1, max: 1024, trim: false }),
    filename: str(body.filename, "filename", { min: 1, max: 255 }),
  });
  return c.json(result, 202);
});

/** Experimental: transcribe the project's recording into its score (local MuScriptor service). */
projectsRoutes.post("/:id/transcribe-score", async (c) => {
  const id = projectId(c);
  const body = await optionalJsonBody(c);
  const ensemble = optOneOf(body.ensemble, "ensemble", TRANSCRIBE_ENSEMBLES) ?? "orchestra";
  // resume: only answer a transcription that is already running (404 when none is)
  const resume = body.resume === undefined ? false : bool(body.resume, "resume");
  const job = await startTranscribeScore(c.get("userId"), id, ensemble, { resume });
  return c.json({ job }, 202);
});

/** Experimental: rewrite a transcribed score with corrected bars (time signature, bar lines moved, half/double tempo). */
projectsRoutes.post("/:id/transcription/bars", async (c) => {
  const id = projectId(c);
  const body = await optionalJsonBody(c);
  const beatsPerBar = body.beatsPerBar === undefined || body.beatsPerBar === null ? null : oneOf(body.beatsPerBar, "beatsPerBar", TRANSCRIPTION_METERS);
  const shiftBeats = body.shiftBeats === undefined ? 0 : num(body.shiftBeats, "shiftBeats", { min: -16, max: 16 });
  if (!Number.isInteger(shiftBeats)) throw new ValidationError("shiftBeats must be a whole number of beats");
  const beatScale = optOneOf(body.beatScale, "beatScale", TRANSCRIPTION_BEAT_SCALES) ?? 1;
  const job = await startRebarTranscription(c.get("userId"), id, { beatsPerBar, shiftBeats, beatScale });
  return c.json({ job }, 202);
});

function parsePeaks(value: unknown): number[] | undefined {
  if (value === undefined || value === null) return undefined;
  if (!Array.isArray(value) || value.length > MAX_PEAKS) {
    throw new ValidationError(`peaks must be an array of at most ${MAX_PEAKS} numbers`);
  }
  return value.map((v, i) => Math.round(num(v, `peaks[${i}]`, { min: 0, max: 1 }) * 1000) / 1000);
}

projectsRoutes.post("/:id/audio", async (c) => {
  const id = projectId(c);
  const body = await jsonBody(c);
  const project = await projects.registerAudio(c.get("userId"), id, {
    key: str(body.key, "key", { min: 1, max: 1024, trim: false }),
    filename: str(body.filename, "filename", { min: 1, max: 255 }),
    durationSec: num(body.durationSec, "durationSec", { min: 0.001, max: MAX_AUDIO_SECONDS }),
    peaks: parsePeaks(body.peaks),
  });
  return c.json({ project });
});

projectsRoutes.delete("/:id/audio", async (c) => {
  return c.json({ project: await projects.removeAudio(c.get("userId"), projectId(c)) });
});

projectsRoutes.get("/:id/urls", async (c) => {
  return c.json(await projects.getProjectUrls(c.get("userId"), projectId(c)));
});

/**
 * Loose shape check of SyncState: the arrays and numbers the rest of the app
 * relies on must be there and be numbers. The JSON is the user's own project
 * data, stored as given.
 */
function parseSync(body: Record<string, unknown>): SyncState {
  str(body.method, "method", { min: 1, max: 100 });
  num(body.averageConfidence, "averageConfidence", { min: 0, max: 100 });
  if (!Array.isArray(body.auto) || body.auto.length > MAX_MEASURES) {
    throw new ValidationError(`auto must be an array of at most ${MAX_MEASURES} measures`);
  }
  if (!Array.isArray(body.manual) || body.manual.length > MAX_MEASURES) {
    throw new ValidationError(`manual must be an array of at most ${MAX_MEASURES} markers`);
  }
  body.auto.forEach((m: unknown, i) => {
    if (!isPlainObject(m)) throw new ValidationError(`auto[${i}] must be an object`);
    num(m.n, `auto[${i}].n`, { min: 1 });
    num(m.startSec, `auto[${i}].startSec`, { min: 0 });
    num(m.confidence, `auto[${i}].confidence`, { min: 0, max: 100 });
  });
  body.manual.forEach((m: unknown, i) => {
    if (!isPlainObject(m)) throw new ValidationError(`manual[${i}] must be an object`);
    str(m.id, `manual[${i}].id`, { min: 1, max: 100 });
    num(m.measure, `manual[${i}].measure`, { min: 1 });
    num(m.startSec, `manual[${i}].startSec`, { min: 0 });
  });
  return body as unknown as SyncState;
}

projectsRoutes.put("/:id/sync", async (c) => {
  const id = projectId(c);
  const sync = parseSync(await jsonBody(c));
  return c.json({ project: await projects.saveSync(c.get("userId"), id, sync) });
});

/** Loose shape check of DisplaySettings (see parseSync). */
function parseDisplay(body: Record<string, unknown>): DisplaySettings {
  if (!Array.isArray(body.visibleParts) || !body.visibleParts.every((p) => typeof p === "string")) {
    throw new ValidationError("visibleParts must be an array of part ids");
  }
  for (const field of ["positions", "colors", "sectionColors", "sections"] as const) {
    if (!isPlainObject(body[field])) throw new ValidationError(`${field} must be an object`);
  }
  bool(body.showLabels, "showLabels");
  bool(body.reducedMotion, "reducedMotion");
  oneOf(body.labelMode, "labelMode", ["sections", "parts"] as const);
  num(body.glowScale, "glowScale", { min: 0.6, max: 1.4 });
  for (const section of Object.values(body.sections as Record<string, unknown>)) {
    oneOf(section, "sections[*]", SECTIONS);
  }
  // Colors are injected into inline styles and canvas fills: hex only.
  for (const field of ["colors", "sectionColors"] as const) {
    for (const [key, value] of Object.entries(body[field] as Record<string, unknown>)) {
      if (typeof value !== "string" || !/^#[0-9a-f]{6}$/i.test(value)) {
        throw new ValidationError(`${field}.${key} must be a hex color like #e2b04c`);
      }
    }
  }
  return body as unknown as DisplaySettings;
}

projectsRoutes.put("/:id/display", async (c) => {
  const id = projectId(c);
  const display = parseDisplay(await jsonBody(c));
  return c.json({ project: await projects.saveDisplay(c.get("userId"), id, display) });
});

projectsRoutes.get("/:id/exports", async (c) => {
  return c.json({ exports: await exportsService.listExports(c.get("userId"), projectId(c)) });
});

projectsRoutes.post("/:id/exports", async (c) => {
  const id = projectId(c);
  const body = await jsonBody(c);
  const kind = oneOf(body.kind, "kind", ["mp4", "project"] as const);
  // `bytes` from the client is accepted for compatibility but the server reads the real size from S3.
  if (body.bytes !== undefined) num(body.bytes, "bytes", { min: 0 });
  const created = await exportsService.registerExport(c.get("userId"), id, {
    kind,
    filename: str(body.filename, "filename", { min: 1, max: 255 }),
    key: str(body.key, "key", { min: 1, max: 1024, trim: false }),
    resolution: optOneOf(body.resolution, "resolution", ["720p", "1080p", "4k"] as const),
    frameRate: optOneOf(body.frameRate, "frameRate", [30, 60] as const),
  });
  return c.json({ export: created }, 201);
});
