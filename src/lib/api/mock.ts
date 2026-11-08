/**
 * In-memory ApiClient for design review and tests (NEXT_PUBLIC_API_MOCK=1).
 * Deterministic demo data from src/lib/mock; jobs walk through believable
 * steps on a timer through the same registry the HTTP client uses, so
 * useJob(jobId) behaves identically. Mutations update in-memory copies and
 * are forgotten on reload (no persistence, by design).
 */
import type { ActivityItem, ProjectSummary } from "@/shared/domain";
import type { InfoMap } from "@/shared/info-map";
import type { AlignResult, AudioUploadResult, ExportResult, Job, JobKind, OpenProjectResult, ParseScoreResult, TranscribeScoreResult } from "@/shared/jobs";
import type { DisplaySettings } from "@/shared/project-file";
import { UNCERTAIN_THRESHOLD, type SyncState } from "@/shared/sync";
import { DEFAULT_PREFERENCES, type ExportDto, type ProfileDto, type ProgramDto, type ProjectDto, type ProjectUrls, type UsageDto } from "@/shared/api";
import { ACTIVITY, DEMO_DIRECTOR, PROGRAMS, PROJECTS } from "@/lib/mock/library";
import { buildMockInfoMap } from "@/lib/mock/info-map";
import { BEETHOVEN_5, specForProject } from "@/lib/mock/scores";
import { buildMockAlignment } from "@/lib/mock/sync";
import { buildWaveform } from "@/lib/mock/waveform";
import { getJob, runLocalJob, subscribeJob, type LocalJobHandle } from "@/lib/jobs/registry";
import type { ApiClient, ExportMp4Options } from "./types";

const DEMO_PROJECT_ID = "beethoven-5";
const LATENCY_MS = 60;

/** Speed multiplier for simulated jobs (tests set it to 0 to finish instantly). */
export const mockTiming = { scale: 1 };

const wait = (ms: number) => new Promise<void>((r) => setTimeout(r, ms * mockTiming.scale));
const clone = <T>(v: T): T => (v === undefined ? v : (JSON.parse(JSON.stringify(v)) as T));
const now = () => new Date().toISOString();

let counter = 0;
const newId = (prefix: string) => `${prefix}_${(++counter).toString(36)}`;

/* ------------------------------------------------------------------ */
/* Seed data                                                           */
/* ------------------------------------------------------------------ */

const peaksSeed = (p: ProjectSummary) => p.id.length * 7 + p.measures;
const keyFor = (id: string, file: string) => `users/demo/projects/${id}/${file}`;

const infoMaps = new Map<string, InfoMap>();
function infoMapFor(id: string): InfoMap {
  let map = infoMaps.get(id);
  if (!map) {
    map = buildMockInfoMap(specForProject(id));
    infoMaps.set(id, map);
  }
  return map;
}

function toDto(summary: ProjectSummary): ProjectDto {
  const parsed = summary.status !== "importing" && summary.status !== "failed";
  const sync = summary.hasRecording && parsed && summary.status !== "needs-sync" ? buildMockAlignment(infoMapFor(summary.id), specForProject(summary.id).seed) : null;
  return {
    ...summary,
    scoreKey: keyFor(summary.id, `score/${summary.scoreName}`),
    audioFileId: summary.hasRecording ? `af_${summary.id}` : null,
    audioKey: summary.hasRecording ? keyFor(summary.id, `audio/${summary.recordingName ?? "recording.mp3"}`) : null,
    infoMapKey: parsed ? keyFor(summary.id, "info-map.json") : null,
    audioPeaks: summary.hasRecording ? buildWaveform(peaksSeed(summary)) : null,
    parseJobId: null,
    sync,
    display: null,
  };
}

const projects = new Map<string, ProjectDto>(PROJECTS.map((p) => [p.id, toDto(p)]));
const programs = new Map<string, ProgramDto>(PROGRAMS.map((p) => [p.id, { ...clone(p), notes: "", createdAt: p.date }]));
const exportsByProject = new Map<string, ExportDto[]>();
const activity: ActivityItem[] = clone(ACTIVITY);
let profile: ProfileDto = { ...DEMO_DIRECTOR, image: null, preferences: { ...DEFAULT_PREFERENCES } };

const summaryOf = (p: ProjectDto): ProjectSummary => {
  const { scoreKey, audioFileId, audioKey, infoMapKey, audioPeaks, parseJobId, sync, display, ...summary } = p;
  void scoreKey;
  void audioFileId;
  void audioKey;
  void infoMapKey;
  void audioPeaks;
  void parseJobId;
  void sync;
  void display;
  return summary;
};

function mustProject(id: string): ProjectDto {
  const p = projects.get(id);
  if (!p) throw new Error("Project not found");
  return p;
}

function touch(p: ProjectDto, patch: Partial<ProjectDto> = {}): ProjectDto {
  const next = { ...p, ...patch, updatedAt: now() };
  next.status = deriveStatus(next);
  projects.set(next.id, next);
  return next;
}

/** Same derivation as the server: importing → failed → needs-sync → exported → ready. */
function deriveStatus(p: ProjectDto): ProjectSummary["status"] {
  if (p.status === "importing" || p.status === "failed") return p.status;
  if (p.hasRecording && !p.sync) return "needs-sync";
  if ((exportsByProject.get(p.id)?.length ?? 0) > 0 || p.exports > 0) return "exported";
  return "ready";
}

function logActivity(kind: ActivityItem["kind"], projectId: string, text: string) {
  activity.unshift({ id: newId("act"), kind, projectId, text, at: now() });
  activity.splice(25);
}

/* ------------------------------------------------------------------ */
/* Simulated jobs                                                      */
/* ------------------------------------------------------------------ */

interface Step {
  until: number;
  message: string;
}

/** Walk through `steps` over `durationMs`, optionally failing at 62 %. */
async function simulate(handle: LocalJobHandle, steps: Step[], durationMs: number, failWith?: string) {
  const total = durationMs * mockTiming.scale;
  const start = Date.now();
  for (;;) {
    if (handle.signal.aborted) throw new Error("Cancelled");
    const p = total > 0 ? Math.min(1, (Date.now() - start) / total) : 1;
    if (failWith && p >= 0.62) throw new Error(failWith);
    if (p >= 1) return;
    const step = steps.find((s) => p <= s.until) ?? steps[steps.length - 1];
    handle.report(p, step.message);
    await wait(120);
  }
}

function simulated<T>(kind: JobKind, steps: Step[], durationMs: number, finish: () => T, failWith?: string): Job<T> {
  return runLocalJob<T>(kind, async (handle) => {
    await wait(350);
    await simulate(handle, steps, durationMs, failWith);
    return finish();
  });
}

/* ------------------------------------------------------------------ */
/* Client                                                              */
/* ------------------------------------------------------------------ */

export const mockApi: ApiClient = {
  // session & profile
  async getProfile() {
    await wait(LATENCY_MS);
    return clone(profile);
  },
  async updateProfile(patch) {
    await wait(LATENCY_MS);
    const { preferences, website, ...rest } = patch;
    profile = {
      ...profile,
      ...rest,
      ...(website !== undefined ? { website: website ?? undefined } : {}),
      preferences: { ...profile.preferences, ...(preferences ?? {}) },
    };
    if (patch.name) {
      profile.initials = patch.name
        .split(/\s+/)
        .map((p) => p[0] ?? "")
        .join("")
        .slice(0, 2)
        .toUpperCase();
    }
    return clone(profile);
  },
  async deleteAccount() {
    await wait(LATENCY_MS);
  },
  async getUsage(): Promise<UsageDto> {
    await wait(LATENCY_MS);
    const all = [...projects.values()];
    const scores = all.filter((p) => p.scoreKey);
    const recordings = all.filter((p) => p.hasRecording);
    const exportCount = all.reduce((n, p) => n + p.exports, 0);
    const usage = {
      scores: { count: scores.length, bytes: scores.length * 1_200_000 },
      recordings: { count: recordings.length, bytes: recordings.reduce((n, p) => n + p.durationSec * 32_000, 0) },
      exports: { count: exportCount, bytes: exportCount * 184_000_000 },
    };
    return { ...usage, totalBytes: usage.scores.bytes + usage.recordings.bytes + usage.exports.bytes };
  },

  // projects
  async listProjects() {
    await wait(LATENCY_MS * 2);
    return [...projects.values()].map(summaryOf).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  },
  async getProject(id) {
    await wait(LATENCY_MS);
    const p = projects.get(id);
    return p ? clone(p) : null;
  },
  async createProject(input = {}) {
    await wait(LATENCY_MS);
    const id = newId("proj");
    const at = now();
    const project: ProjectDto = {
      id,
      title: input.title ?? "Untitled project",
      composer: "",
      movement: "",
      parts: 0,
      measures: 0,
      durationSec: 0,
      hasRecording: false,
      scoreName: "",
      stage: "import",
      status: "ready",
      updatedAt: at,
      createdAt: at,
      programIds: [],
      thumbnail: [],
      exports: 0,
      scoreKey: null,
      audioFileId: null,
      audioKey: null,
      infoMapKey: null,
      audioPeaks: null,
      parseJobId: null,
      sync: null,
      display: null,
    };
    projects.set(id, project);
    return clone(project);
  },
  async updateProject(id, patch) {
    await wait(LATENCY_MS);
    const p = mustProject(id);
    const { subtitle, programIds, ...rest } = patch;
    return clone(touch(p, { ...rest, ...(subtitle !== undefined ? { subtitle: subtitle ?? undefined } : {}), ...(programIds ? { programIds } : {}) }));
  },
  async deleteProject(id) {
    await wait(LATENCY_MS);
    projects.delete(id);
    exportsByProject.delete(id);
    for (const program of programs.values()) program.projectIds = program.projectIds.filter((pid) => pid !== id);
  },

  async uploadScore(projectId, file) {
    const tooBig = /mahler/i.test(file.name);
    const spec = BEETHOVEN_5;
    return simulated<ParseScoreResult>(
      "upload-score",
      [
        { until: 0.18, message: "Uploading score" },
        { until: 0.42, message: "Reading part list" },
        { until: 0.7, message: "Walking measures and dynamics" },
        { until: 0.9, message: "Building the information map" },
        { until: 1, message: "Finishing" },
      ],
      4200,
      () => {
        const result: ParseScoreResult = {
          title: "Symphony No. 5",
          composer: "Ludwig van Beethoven",
          movement: "I. Allegro con brio",
          parts: spec.parts.length,
          measures: spec.measures,
          durationSec: spec.durationSec,
          warnings: spec.warnings ?? [],
        };
        const p = projects.get(projectId);
        if (p) {
          infoMaps.set(projectId, buildMockInfoMap(spec));
          touch(p, {
            ...result,
            subtitle: "in C minor",
            scoreName: file.name,
            scoreKey: keyFor(projectId, `score/${file.name}`),
            infoMapKey: keyFor(projectId, "info-map.json"),
            status: "ready",
            thumbnail: PROJECTS[0].thumbnail,
            display: null,
          });
          logActivity("import", projectId, `Imported ${file.name}`);
        }
        return result;
      },
      tooBig ? "86 parts exceed the 64-part limit. Split the score or hide parts before export." : undefined,
    );
  },

  async uploadAudio(projectId, file) {
    return simulated<AudioUploadResult>(
      "upload-audio",
      [
        { until: 0.3, message: "Decoding" },
        { until: 0.85, message: "Uploading recording" },
        { until: 1, message: "Registering recording" },
      ],
      2600,
      () => {
        const p = projects.get(projectId);
        const durationSec = p?.durationSec || BEETHOVEN_5.durationSec;
        const peaks = buildWaveform(file.name.length * 7 + durationSec);
        if (p) {
          touch(p, {
            hasRecording: true,
            recordingName: file.name,
            audioFileId: `af_${projectId}`,
            audioKey: keyFor(projectId, `audio/${file.name}`),
            audioPeaks: peaks,
            sync: null,
          });
          logActivity("import", projectId, `Added recording ${file.name}`);
        }
        return { filename: file.name, durationSec, peaks };
      },
    );
  },

  async transcribeScore() {
    return simulated<TranscribeScoreResult>("transcribe", [{ until: 1, message: "Transcribing" }], 600, () => {
      throw new Error("Transcription needs the real API and the local MuScriptor service (npm run ml:serve).");
    });
  },

  async rebarTranscription() {
    return simulated<TranscribeScoreResult>("transcribe", [{ until: 1, message: "Rewriting the bars" }], 600, () => {
      throw new Error("Transcription needs the real API and the local MuScriptor service (npm run ml:serve).");
    });
  },

  async removeAudio(projectId) {
    await wait(LATENCY_MS);
    const p = mustProject(projectId);
    return clone(touch(p, { hasRecording: false, recordingName: undefined, audioFileId: null, audioKey: null, audioPeaks: null, sync: null }));
  },

  async getProjectUrls(id): Promise<ProjectUrls> {
    await wait(LATENCY_MS);
    const p = mustProject(id);
    const url = (key: string | null) => (key ? `/mock-s3/${key}` : null);
    return { score: url(p.scoreKey), audio: url(p.audioKey), infoMap: url(p.infoMapKey), expiresInSeconds: 900 };
  },

  async fetchInfoMap(id) {
    await wait(LATENCY_MS);
    const p = mustProject(id);
    if (!p.infoMapKey) throw new Error("The score has not been parsed yet");
    return infoMapFor(id);
  },

  async saveSync(id, sync: SyncState) {
    await wait(LATENCY_MS);
    return clone(touch(mustProject(id), { sync: clone(sync), averageConfidence: Math.round(sync.averageConfidence) }));
  },

  async saveDisplay(id, display: DisplaySettings) {
    await wait(LATENCY_MS);
    return clone(touch(mustProject(id), { display: clone(display) }));
  },

  // processing
  async startAlignment(projectId) {
    return simulated<AlignResult>(
      "align",
      [
        { until: 0.2, message: "Rendering score to audio" },
        { until: 0.45, message: "Computing chroma features" },
        { until: 0.8, message: "Warping score time onto the recording" },
        { until: 0.95, message: "Scoring confidence per measure" },
        { until: 1, message: "Finishing" },
      ],
      5200,
      () => {
        const p = mustProject(projectId);
        const infoMap = infoMapFor(projectId);
        const fresh = buildMockAlignment(infoMap, specForProject(projectId).seed + (p.sync ? 1 : 0));
        const sync: SyncState = { ...fresh, manual: p.sync?.manual ?? [] };
        touch(p, { sync, averageConfidence: sync.averageConfidence });
        const uncertainMeasures = sync.auto.filter((m) => m.confidence < UNCERTAIN_THRESHOLD).length;
        logActivity("sync", projectId, `Auto-alignment finished · ${sync.averageConfidence}% average confidence`);
        return { measures: sync.auto.length, averageConfidence: sync.averageConfidence, uncertainMeasures, method: sync.method };
      },
    );
  },

  async exportMp4(options: ExportMp4Options) {
    const frames = options.frameRate === 60 ? "60 fps" : "30 fps";
    const filename = options.filename.toLowerCase().endsWith(".mp4") ? options.filename : `${options.filename}.mp4`;
    return simulated<ExportResult>(
      "export-mp4",
      [
        { until: 0.1, message: "Preparing renderer" },
        { until: 0.78, message: `Rendering frames · ${options.resolution} · ${frames}` },
        { until: 0.92, message: options.audio === "uploaded" ? "Muxing uploaded recording" : "Muxing generated playback" },
        { until: 1, message: "Finishing" },
      ],
      6800,
      () => {
        const bytes = options.resolution === "4k" ? 612_000_000 : options.resolution === "1080p" ? 184_000_000 : 96_000_000;
        const row = registerExport(options.projectId, "mp4", filename, bytes, options.resolution, options.frameRate);
        return { filename, bytes, url: "#", exportId: row.id };
      },
    );
  },

  async exportProjectFile(projectId, requestedName) {
    const filename = requestedName.toLowerCase().endsWith(".ovproj") ? requestedName : `${requestedName}.ovproj`;
    return simulated<ExportResult>(
      "export-project",
      [
        { until: 0.4, message: "Packing score, audio and markers" },
        { until: 0.8, message: "Writing display settings" },
        { until: 1, message: "Zipping" },
      ],
      1800,
      () => {
        const bytes = 14_800_000;
        const row = registerExport(projectId, "project", filename, bytes);
        return { filename, bytes, url: "#", exportId: row.id };
      },
    );
  },

  async openProjectFile(file) {
    return simulated<OpenProjectResult>(
      "open-project",
      [
        { until: 0.3, message: `Unpacking ${file.name}` },
        { until: 0.6, message: "Uploading score" },
        { until: 0.85, message: "Restoring recording and markers" },
        { until: 1, message: "Restoring display settings" },
      ],
      2400,
      () => ({ projectId: DEMO_PROJECT_ID, hasRecording: projects.get(DEMO_PROJECT_ID)?.hasRecording ?? true }),
    );
  },

  async listExports(projectId) {
    await wait(LATENCY_MS);
    return clone(exportsByProject.get(projectId) ?? []);
  },
  async getExportDownloadUrl() {
    await wait(LATENCY_MS);
    return "#";
  },

  // programs & activity
  async listPrograms() {
    await wait(LATENCY_MS);
    return clone([...programs.values()]);
  },
  async getProgram(id) {
    await wait(LATENCY_MS);
    const program = programs.get(id);
    if (!program) return null;
    const rows = program.projectIds.map((pid) => projects.get(pid)).filter((p): p is ProjectDto => Boolean(p));
    return { program: clone(program), projects: rows.map(summaryOf) };
  },
  async createProgram(input) {
    await wait(LATENCY_MS);
    const program: ProgramDto = {
      id: newId("prog"),
      name: input.name,
      season: input.season ?? "",
      date: input.date ?? "",
      venue: input.venue ?? "",
      description: input.description ?? "",
      color: input.color ?? "Strings",
      projectIds: [],
      notes: "",
      createdAt: now(),
    };
    programs.set(program.id, program);
    return clone(program);
  },
  async updateProgram(id, patch) {
    await wait(LATENCY_MS);
    const current = programs.get(id);
    if (!current) throw new Error("Program not found");
    const { projectIds, ...rest } = patch;
    const next: ProgramDto = { ...current, ...rest, ...(projectIds ? { projectIds: [...projectIds] } : {}) };
    programs.set(id, next);
    if (projectIds) {
      for (const p of projects.values()) {
        const inProgram = projectIds.includes(p.id);
        const listed = p.programIds.includes(id);
        if (inProgram && !listed) projects.set(p.id, { ...p, programIds: [...p.programIds, id] });
        if (!inProgram && listed) projects.set(p.id, { ...p, programIds: p.programIds.filter((pid) => pid !== id) });
      }
    }
    return clone(next);
  },
  async deleteProgram(id) {
    await wait(LATENCY_MS);
    programs.delete(id);
    for (const p of projects.values()) {
      if (p.programIds.includes(id)) projects.set(p.id, { ...p, programIds: p.programIds.filter((pid) => pid !== id) });
    }
  },
  async listActivity() {
    await wait(LATENCY_MS);
    return clone(activity);
  },

  // jobs
  getJob,
  subscribeJob,
};

function registerExport(projectId: string, kind: ExportDto["kind"], filename: string, bytes: number, resolution?: ExportDto["resolution"], frameRate?: ExportDto["frameRate"]): ExportDto {
  const row: ExportDto = {
    id: newId("exp"),
    projectId,
    kind,
    filename,
    key: keyFor(projectId, `exports/${filename}`),
    bytes,
    resolution: resolution ?? null,
    frameRate: frameRate ?? null,
    createdAt: now(),
  };
  const list = exportsByProject.get(projectId) ?? [];
  list.unshift(row);
  exportsByProject.set(projectId, list);
  const p = projects.get(projectId);
  if (p) {
    touch(p, { exports: p.exports + 1, statusDetail: kind === "mp4" ? `MP4 · ${resolution ?? ""} · just now` : p.statusDetail });
    logActivity("export", projectId, kind === "mp4" ? `Exported MP4 (${resolution}, ${frameRate} fps)` : `Saved project file ${filename}`);
  }
  return row;
}
