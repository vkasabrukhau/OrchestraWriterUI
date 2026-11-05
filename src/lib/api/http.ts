/**
 * ApiClient over the Hono API (docs/plan/backend-integration.md, contracts in
 * src/shared/api.ts). Uploads go straight to S3 through presigned PUT URLs;
 * alignment and exports run in the browser and persist their results through
 * the API. Every long operation is a local job in src/lib/jobs/registry.ts so
 * pages consume it through useJob(jobId) exactly like a server job.
 */
import type { ActivityItem, ProjectSummary } from "@/shared/domain";
import type { InfoMap } from "@/shared/info-map";
import type { AlignResult, AudioUploadResult, ExportResult, Job, JobKind, OpenProjectResult, ParseScoreResult, TranscribeScoreResult } from "@/shared/jobs";
import type { DisplaySettings, ProjectFile } from "@/shared/project-file";
import { mergeAlignment, UNCERTAIN_THRESHOLD, type SyncState } from "@/shared/sync";
import type {
  ActivityDto,
  ExportDto,
  JobDto,
  ProfileDto,
  ProfileUpdate,
  ProgramCreate,
  ProgramDto,
  ProgramPatch,
  ProgramResponse,
  ProjectCreate,
  ProjectDto,
  ProjectListResponse,
  ProjectPatch,
  ProjectResponse,
  ProjectUrls,
  RegisterAudioRequest,
  RegisterExportRequest,
  RegisterScoreRequest,
  RegisterScoreResponse,
  UploadKind,
  UploadRequest,
  UploadTarget,
  UsageDto,
} from "@/shared/api";
import { decodeAudioFile, peaksFromAudioBuffer, renderScoreToAudioBuffer, toAlignAudio } from "@/lib/audio";
import { alignInWorker } from "@/lib/align/worker-client";
import { buildProjectFile, packProjectFile, renderMp4, unpackProjectFile } from "@/lib/export";
import { getJob, mirrorRemoteJob, runLocalJob, subscribeJob, type LocalJobHandle } from "@/lib/jobs/registry";
import { defaultDisplay } from "@/lib/store/display-defaults";
import { cacheAudio, evictAudio, getCachedAudio } from "./audio-cache";
import { AuthRequiredError, isNotFound, errorMessage } from "./errors";
import { ensureExtension, fetchBytes, fetchJson, putWithProgress, request, scoreContentType, toArrayBuffer } from "./transport";
import type { ApiClient, ExportMp4Options } from "./types";

export const CREATED_WITH = "Orchestra Visualizer 0.1.0";

/** Longest recording the browser will decode and export (matches the server cap). */
const MAX_AUDIO_SECONDS = 2 * 60 * 60;

/** Presigned GET URLs expire after 15 minutes; refresh them before that. */
const URL_TTL_MS = 10 * 60_000;

export interface HttpApiOptions {
  /** how often GET /api/jobs/:id is polled while a server job runs */
  pollIntervalMs?: number;
  urlTtlMs?: number;
}

type JobContext = LocalJobHandle & { id: string };

/** runLocalJob, but the work also knows its own job id (for mirroring). */
function startJob<T>(kind: JobKind, work: (ctx: JobContext) => Promise<T>): Job<T> {
  const ref = { id: "" };
  const job = runLocalJob<T>(kind, (handle) => work({ ...handle, id: ref.id }));
  ref.id = job.id;
  return job;
}

/** Map a sub-task's 0–1 progress into [from, to] of the enclosing job. */
function scaled(report: LocalJobHandle["report"], from: number, to: number) {
  return (p: number, message: string) => report(from + Math.max(0, Math.min(1, p)) * (to - from), message);
}

const enc = encodeURIComponent;

export function createHttpApi(options: HttpApiOptions = {}): ApiClient {
  const pollIntervalMs = options.pollIntervalMs ?? 1200;
  const urlTtlMs = options.urlTtlMs ?? URL_TTL_MS;

  const urlCache = new Map<string, { urls: ProjectUrls; at: number }>();
  const infoMapCache = new Map<string, { key: string; infoMap: InfoMap }>();

  function invalidate(projectId: string) {
    urlCache.delete(projectId);
    infoMapCache.delete(projectId);
  }

  /* ------------------------------ basics ------------------------------ */

  const presign = (kind: UploadKind, filename: string, contentType: string, projectId?: string, bytes?: number) =>
    request<UploadTarget>("/uploads", { method: "POST", json: { kind, filename, contentType, projectId, bytes } satisfies UploadRequest });

  async function getProject(id: string): Promise<ProjectDto | null> {
    try {
      return (await request<ProjectResponse>(`/projects/${enc(id)}`)).project;
    } catch (err) {
      if (isNotFound(err)) return null;
      throw err;
    }
  }

  async function mustGetProject(id: string): Promise<ProjectDto> {
    const project = await getProject(id);
    if (!project) throw new Error("Project not found");
    return project;
  }

  async function getProjectUrls(id: string, fresh = false): Promise<ProjectUrls> {
    const hit = urlCache.get(id);
    if (!fresh && hit && Date.now() - hit.at < urlTtlMs) return hit.urls;
    const urls = await request<ProjectUrls>(`/projects/${enc(id)}/urls`);
    urlCache.set(id, { urls, at: Date.now() });
    return urls;
  }

  async function fetchInfoMap(id: string): Promise<InfoMap> {
    const project = await mustGetProject(id);
    if (!project.infoMapKey) throw new Error("The score has not been parsed yet");
    const hit = infoMapCache.get(id);
    if (hit && hit.key === project.infoMapKey) return hit.infoMap;
    let urls = await getProjectUrls(id);
    if (!urls.infoMap) urls = await getProjectUrls(id, true);
    if (!urls.infoMap) throw new Error("The information map is not available yet");
    const infoMap = await fetchJson<InfoMap>(urls.infoMap);
    infoMapCache.set(id, { key: project.infoMapKey, infoMap });
    return infoMap;
  }

  async function saveSync(id: string, sync: SyncState, options: { keepalive?: boolean } = {}): Promise<ProjectDto> {
    return (await request<ProjectResponse>(`/projects/${enc(id)}/sync`, { method: "PUT", json: sync, keepalive: options.keepalive })).project;
  }

  async function saveDisplay(id: string, display: DisplaySettings, options: { keepalive?: boolean } = {}): Promise<ProjectDto> {
    return (await request<ProjectResponse>(`/projects/${enc(id)}/display`, { method: "PUT", json: display, keepalive: options.keepalive })).project;
  }

  /** The decoded recording: from the LRU, else downloaded and decoded. */
  async function loadAudioBuffer(projectId: string, signal?: AbortSignal): Promise<AudioBuffer> {
    const cached = getCachedAudio(projectId);
    if (cached) return cached;
    let urls = await getProjectUrls(projectId);
    if (!urls.audio) urls = await getProjectUrls(projectId, true);
    if (!urls.audio) throw new Error("This project has no recording");
    const bytes = await fetchBytes(urls.audio, signal);
    const buffer = await decodeAudioFile(bytes);
    cacheAudio(projectId, buffer);
    return buffer;
  }

  /** Mirror a server job into the local one, mapping its progress into [from, to]. */
  async function pollRemoteJob<T>(localId: string, remoteId: string, from: number, to: number, signal: AbortSignal): Promise<Job<T>> {
    const last: { job: Job<T> | null } = { job: null };
    await mirrorRemoteJob<T>(
      localId,
      async () => {
        const { job } = await request<{ job: JobDto }>(`/jobs/${enc(remoteId)}`, { signal });
        last.job = job as Job<T>;
        return last.job;
      },
      {
        intervalMs: pollIntervalMs,
        signal,
        map: (remote) => ({ progress: from + remote.progress * (to - from), message: remote.message }),
      },
    );
    if (!last.job) throw new Error("Job vanished");
    return last.job;
  }

  /** presign → PUT → register → poll the parse job. Progress spans [from, to]. */
  async function uploadAndParseScore(projectId: string, blob: Blob, filename: string, ctx: JobContext, from: number, to: number): Promise<ParseScoreResult> {
    const span = to - from;
    const contentType = scoreContentType(filename);
    ctx.report(from, "Preparing upload");
    const target = await presign("score", filename, contentType, projectId, blob.size);
    await putWithProgress(target.uploadUrl, blob, contentType, (p) => ctx.report(from + p * span * 0.4, "Uploading score"), ctx.signal);
    ctx.report(from + span * 0.4, "Parsing score");
    const { job: remote } = await request<RegisterScoreResponse>(`/projects/${enc(projectId)}/score`, {
      method: "POST",
      json: { key: target.key, filename } satisfies RegisterScoreRequest,
    });
    const final = await pollRemoteJob<ParseScoreResult>(ctx.id, remote.id, from + span * 0.4, to, ctx.signal);
    invalidate(projectId);
    if (final.status === "failed") throw new Error(final.error ?? "The score could not be parsed");
    if (!final.result) throw new Error("The parse job finished without a result");
    return final.result;
  }

  /** decode → presign → PUT → register. Progress spans [from, to]. */
  async function uploadAndRegisterAudio(projectId: string, blob: Blob, filename: string, contentType: string, ctx: JobContext, from: number, to: number): Promise<AudioUploadResult> {
    const span = to - from;
    ctx.report(from, "Decoding");
    const buffer = await decodeAudioFile(blob instanceof File ? blob : await blob.arrayBuffer());
    cacheAudio(projectId, buffer);
    const peaks = peaksFromAudioBuffer(buffer);
    if (buffer.duration > MAX_AUDIO_SECONDS) {
      throw new Error(`Recordings longer than ${Math.round(MAX_AUDIO_SECONDS / 3600)} hours are not supported.`);
    }
    const durationSec = Math.max(1, Math.round(buffer.duration));
    ctx.report(from + span * 0.2, "Uploading recording");
    const target = await presign("audio", filename, contentType, projectId, blob.size);
    await putWithProgress(target.uploadUrl, blob, contentType, (p) => ctx.report(from + span * (0.2 + p * 0.7), "Uploading recording"), ctx.signal);
    ctx.report(from + span * 0.92, "Registering recording");
    await request<ProjectResponse>(`/projects/${enc(projectId)}/audio`, {
      method: "POST",
      json: { key: target.key, filename, durationSec, peaks } satisfies RegisterAudioRequest,
    });
    invalidate(projectId);
    return { filename, durationSec, peaks };
  }

  /** presign (kind export) → PUT → register in history. Progress spans [from, to]. */
  async function uploadExport(projectId: string, blob: Blob, filename: string, contentType: string, body: Omit<RegisterExportRequest, "key" | "filename" | "bytes">, ctx: JobContext, from: number, to: number): Promise<ExportResult> {
    const span = to - from;
    // The local download works even if the history upload fails (ADR 0010/0012):
    // a real-time render or the user's own save path must never be thrown away.
    const result: ExportResult = { filename, bytes: blob.size, url: URL.createObjectURL(blob) };
    try {
      ctx.report(from, "Uploading export");
      const target = await presign("export", filename, contentType, projectId, blob.size);
      await putWithProgress(target.uploadUrl, blob, contentType, (p) => ctx.report(from + p * span * 0.85, "Uploading export"), ctx.signal);
      ctx.report(from + span * 0.9, "Saving to history");
      const { export: exported } = await request<{ export: ExportDto }>(`/projects/${enc(projectId)}/exports`, {
        method: "POST",
        json: { ...body, filename, key: target.key, bytes: blob.size } satisfies RegisterExportRequest,
      });
      result.exportId = exported.id;
    } catch (err) {
      if (ctx.signal.aborted) throw err;
      result.warnings = [`The file is ready to download, but it could not be saved to the export history: ${errorMessage(err, "upload failed")}.`];
    }
    return result;
  }

  /* ------------------------------ client ------------------------------ */

  const client: ApiClient = {
    // session & profile
    async getProfile() {
      try {
        return (await request<{ profile: ProfileDto }>("/me")).profile;
      } catch (err) {
        if (err instanceof AuthRequiredError) return null;
        throw err;
      }
    },
    async updateProfile(patch: ProfileUpdate) {
      return (await request<{ profile: ProfileDto }>("/me", { method: "PUT", json: patch })).profile;
    },
    async deleteAccount() {
      await request<void>("/me", { method: "DELETE" });
    },
    getUsage() {
      return request<UsageDto>("/me/usage");
    },

    // projects
    async listProjects() {
      return (await request<ProjectListResponse>("/projects")).projects;
    },
    getProject,
    async createProject(input: ProjectCreate = {}) {
      return (await request<ProjectResponse>("/projects", { method: "POST", json: input })).project;
    },
    async updateProject(id, patch: ProjectPatch) {
      return (await request<ProjectResponse>(`/projects/${enc(id)}`, { method: "PATCH", json: patch })).project;
    },
    async deleteProject(id) {
      await request<void>(`/projects/${enc(id)}`, { method: "DELETE" });
      invalidate(id);
      evictAudio(id);
    },

    async uploadScore(projectId, file) {
      return startJob<ParseScoreResult>("upload-score", (ctx) => uploadAndParseScore(projectId, file, file.name, ctx, 0, 1));
    },

    async uploadAudio(projectId, file) {
      return startJob<AudioUploadResult>("upload-audio", (ctx) => uploadAndRegisterAudio(projectId, file, file.name, file.type || "audio/mpeg", ctx, 0, 1));
    },

    async transcribeScore(projectId) {
      return startJob<TranscribeScoreResult>("transcribe", async (ctx) => {
        ctx.report(0.01, "Starting transcription");
        const { job: remote } = await request<{ job: JobDto }>(`/projects/${enc(projectId)}/transcribe-score`, { method: "POST" });
        const done = await pollRemoteJob<TranscribeScoreResult>(ctx.id, remote.id, 0.01, 0.9, ctx.signal);
        if (done.status === "failed" || !done.result) throw new Error(done.error ?? "The transcription failed");
        // The transcribed score is imported by a normal parse-score job.
        const parsed = await pollRemoteJob<ParseScoreResult>(ctx.id, done.result.parseJobId, 0.9, 1, ctx.signal);
        invalidate(projectId);
        if (parsed.status === "failed") throw new Error(parsed.error ?? "The transcribed score could not be read");
        return done.result;
      });
    },

    async removeAudio(projectId) {
      const { project } = await request<ProjectResponse>(`/projects/${enc(projectId)}/audio`, { method: "DELETE" });
      invalidate(projectId);
      evictAudio(projectId);
      return project;
    },

    getProjectUrls: (id, options) => getProjectUrls(id, options?.fresh ?? false),
    fetchInfoMap,
    saveSync,
    saveDisplay,

    // processing
    async startAlignment(projectId) {
      return startJob<AlignResult>("align", async (ctx) => {
        ctx.report(0.02, "Loading project");
        const project = await mustGetProject(projectId);
        if (!project.hasRecording) throw new Error("Upload a recording before aligning");
        const infoMap = await fetchInfoMap(projectId);
        ctx.report(0.06, "Loading recording");
        const buffer = await loadAudioBuffer(projectId, ctx.signal);
        ctx.report(0.12, "Preparing audio");
        const audio = toAlignAudio(buffer);
        const result = await alignInWorker(infoMap, audio, scaled(ctx.report, 0.12, 0.92), ctx.signal);
        ctx.report(0.94, "Saving alignment");
        // Manual markers always win and must survive a re-run (sync rule).
        const sync: SyncState = { ...result, manual: project.sync?.manual ?? [] };
        await saveSync(projectId, sync);
        const uncertainMeasures = sync.auto.filter((m) => m.confidence < UNCERTAIN_THRESHOLD).length;
        return { measures: sync.auto.length, averageConfidence: sync.averageConfidence, uncertainMeasures, method: sync.method };
      });
    },

    async exportMp4(options: ExportMp4Options) {
      const { projectId, resolution, frameRate } = options;
      return startJob<ExportResult>("export-mp4", async (ctx) => {
        ctx.report(0.01, "Loading project");
        const project = await mustGetProject(projectId);
        const infoMap = await fetchInfoMap(projectId);
        const display = project.display ?? defaultDisplay(infoMap);
        let audio: AudioBuffer;
        let aligned = mergeAlignment([], []);
        if (options.audio === "uploaded") {
          if (!project.hasRecording) throw new Error("This project has no uploaded recording");
          ctx.report(0.02, "Loading recording");
          audio = await loadAudioBuffer(projectId, ctx.signal);
          if (project.sync) aligned = mergeAlignment(project.sync.auto, project.sync.manual);
        } else {
          ctx.report(0.02, "Generating playback from the score");
          audio = await renderScoreToAudioBuffer(infoMap, infoMap.duration, {
            onProgress: (fraction) => ctx.report(0.02 + fraction * 0.18, "Generating playback from the score"),
            signal: ctx.signal,
          });
        }
        const durationSec = options.audio === "uploaded" ? audio.duration : infoMap.duration;
        const rendered = await renderMp4({
          infoMap,
          display,
          aligned,
          audio,
          durationSec,
          resolution,
          frameRate,
          title: project.title,
          onProgress: scaled(ctx.report, options.audio === "uploaded" ? 0.05 : 0.2, 0.85),
          signal: ctx.signal,
        });
        const filename = ensureExtension(options.filename, ".mp4");
        const result = await uploadExport(projectId, rendered.blob, filename, "video/mp4", { kind: "mp4", resolution, frameRate }, ctx, 0.85, 1);
        return rendered.warnings.length > 0 ? { ...result, warnings: rendered.warnings, codec: rendered.codecName } : { ...result, codec: rendered.codecName };
      });
    },

    async exportProjectFile(projectId, requestedName) {
      return startJob<ExportResult>("export-project", async (ctx) => {
        ctx.report(0.02, "Loading project");
        const project = await mustGetProject(projectId);
        if (!project.scoreKey) throw new Error("This project has no score yet");
        const infoMap = project.infoMapKey ? await fetchInfoMap(projectId) : undefined;
        const urls = await getProjectUrls(projectId, true);
        if (!urls.score) throw new Error("The score file is not available");
        ctx.report(0.1, "Fetching score");
        const scoreBytes = new Uint8Array(await fetchBytes(urls.score, ctx.signal));
        let audioBytes: Uint8Array | undefined;
        if (project.hasRecording && urls.audio) {
          ctx.report(0.3, "Fetching recording");
          audioBytes = new Uint8Array(await fetchBytes(urls.audio, ctx.signal));
        }
        ctx.report(0.6, "Packing score, audio and markers");
        const display = project.display ?? (infoMap ? defaultDisplay(infoMap) : null);
        if (!display) throw new Error("The score has not been parsed yet");
        const projectFile: ProjectFile = {
          ...buildProjectFile({
            infoMap,
            sync: project.sync,
            display,
            scoreFilename: project.scoreName,
            audioFilename: audioBytes ? (project.recordingName ?? "audio.mp3") : null,
            audioSource: audioBytes ? "uploaded" : "generated",
            createdWith: CREATED_WITH,
          }),
          meta: { title: project.title, subtitle: project.subtitle ?? null, composer: project.composer, movement: project.movement },
        };
        const packed = packProjectFile({
          project: projectFile,
          scoreBytes,
          scoreFilename: project.scoreName,
          audioBytes,
          audioFilename: audioBytes ? (project.recordingName ?? "audio.mp3") : undefined,
        });
        const blob = new Blob([toArrayBuffer(packed)], { type: "application/zip" });
        const filename = ensureExtension(requestedName, ".ovproj");
        return uploadExport(projectId, blob, filename, "application/zip", { kind: "project" }, ctx, 0.7, 1);
      });
    },

    async openProjectFile(file) {
      return startJob<OpenProjectResult>("open-project", async (ctx) => {
        ctx.report(0.02, "Reading project file");
        const { project: projectFile, scoreBytes, audioBytes } = unpackProjectFile(new Uint8Array(await file.arrayBuffer()));
        const fallbackTitle = file.name.replace(/\.ovproj$/i, "").trim();
        const title = projectFile.meta?.title || fallbackTitle || "Imported project";
        ctx.report(0.06, "Creating project");
        const { project } = await request<ProjectResponse>("/projects", { method: "POST", json: { title } satisfies ProjectCreate });
        try {
          const scoreFilename = projectFile.score.filename || "score.musicxml";
          const scoreBlob = new Blob([toArrayBuffer(scoreBytes)], { type: scoreContentType(scoreFilename) });
          const parsed = await uploadAndParseScore(project.id, scoreBlob, scoreFilename, ctx, 0.08, 0.6);
          if (projectFile.meta && (projectFile.meta.title || projectFile.meta.composer || projectFile.meta.movement)) {
            // the parse job may have taken the score's own names; the file's names win
            await request<ProjectResponse>(`/projects/${enc(project.id)}`, {
              method: "PATCH",
              json: { title: projectFile.meta.title || undefined, subtitle: projectFile.meta.subtitle ?? undefined, composer: projectFile.meta.composer || undefined, movement: projectFile.meta.movement || undefined } satisfies ProjectPatch,
            });
          }
          const hasRecording = Boolean(audioBytes && audioBytes.byteLength > 0);
          if (audioBytes && hasRecording) {
            const audioFilename = projectFile.audio.filename || "audio.mp3";
            const audioBlob = new Blob([toArrayBuffer(audioBytes)], { type: "audio/mpeg" });
            await uploadAndRegisterAudio(project.id, audioBlob, audioFilename, "audio/mpeg", ctx, 0.6, 0.88);
          }
          if (projectFile.sync && hasRecording) {
            // Measure numbers are playback order with repeats expanded; a file
            // whose alignment was made for a different measure count cannot be
            // trusted bar by bar. Keep manual markers that are still in range.
            const measures = parsed.measures;
            const auto = projectFile.sync.auto.length === measures ? projectFile.sync.auto : [];
            const manual = projectFile.sync.manual.filter((m) => m.measure >= 1 && m.measure <= measures);
            if (auto.length > 0 || manual.length > 0) {
              ctx.report(0.9, "Restoring alignment");
              await saveSync(project.id, { ...projectFile.sync, auto, manual, averageConfidence: auto.length ? projectFile.sync.averageConfidence : 0 });
            }
          }
          ctx.report(0.95, "Restoring display settings");
          await saveDisplay(project.id, projectFile.display);
          invalidate(project.id);
          return { projectId: project.id, hasRecording };
        } catch (err) {
          // do not leave a half-imported project behind
          await request(`/projects/${enc(project.id)}`, { method: "DELETE" }).catch(() => {});
          throw err;
        }
      });
    },

    async listExports(projectId) {
      return (await request<{ exports: ExportDto[] }>(`/projects/${enc(projectId)}/exports`)).exports;
    },
    async getExportDownloadUrl(exportId) {
      return (await request<{ url: string }>(`/exports/${enc(exportId)}/download-url`)).url;
    },

    // programs & activity
    async listPrograms() {
      return (await request<{ programs: ProgramDto[] }>("/programs")).programs;
    },
    async getProgram(id) {
      try {
        const { program, projects } = await request<ProgramResponse>(`/programs/${enc(id)}`);
        return { program, projects: projects as ProjectSummary[] };
      } catch (err) {
        if (isNotFound(err)) return null;
        throw err;
      }
    },
    async createProgram(input: ProgramCreate) {
      return (await request<{ program: ProgramDto }>("/programs", { method: "POST", json: input })).program;
    },
    async updateProgram(id, patch: ProgramPatch) {
      return (await request<{ program: ProgramDto }>(`/programs/${enc(id)}`, { method: "PATCH", json: patch })).program;
    },
    async deleteProgram(id) {
      await request<void>(`/programs/${enc(id)}`, { method: "DELETE" });
    },
    async listActivity() {
      return (await request<{ activity: ActivityDto[] }>("/activity")).activity as ActivityItem[];
    },

    // jobs
    getJob,
    subscribeJob,
  };

  return client;
}

/** `{ googleEnabled }` from GET /api/config (not part of ApiClient; the session store reads it). */
export function fetchConfig(): Promise<{ googleEnabled: boolean }> {
  return request<{ googleEnabled: boolean }>("/config");
}

export const httpApi: ApiClient = createHttpApi();
export { getCachedAudio, cacheAudio } from "./audio-cache";
