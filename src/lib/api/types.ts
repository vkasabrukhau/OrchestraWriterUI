import type { ActivityItem, ProjectSummary } from "@/shared/domain";
import type { InfoMap } from "@/shared/info-map";
import type { AlignJobInput, AlignResult, AudioUploadResult, ExportResult, Job, OpenProjectResult, ParseScoreResult } from "@/shared/jobs";
import type { DisplaySettings } from "@/shared/project-file";
import type { SyncState } from "@/shared/sync";
import type { PeakPyramid } from "@/lib/audio/peaks";
import type {
  ExportDto,
  ProfileDto,
  ProfileUpdate,
  ProgramCreate,
  ProgramDto,
  ProgramPatch,
  ProjectCreate,
  ProjectDto,
  ProjectPatch,
  ProjectUrls,
  UsageDto,
} from "@/shared/api";

export interface ExportMp4Options {
  projectId: string;
  filename: string;
  resolution: "720p" | "1080p" | "4k";
  frameRate: 30 | 60;
  audio: "uploaded" | "generated";
}

/**
 * The one client the pages talk to. `http.ts` implements it against the Hono
 * API (uploads go straight to S3 with presigned URLs; alignment and exports
 * run in the browser and persist their results through the API). `mock.ts`
 * implements the same interface in memory for tests and design work.
 */
export interface ApiClient {
  // session & profile
  getProfile(): Promise<ProfileDto | null>;
  updateProfile(patch: ProfileUpdate): Promise<ProfileDto>;
  deleteAccount(): Promise<void>;
  getUsage(): Promise<UsageDto>;

  // projects
  listProjects(): Promise<ProjectSummary[]>;
  getProject(id: string): Promise<ProjectDto | null>;
  createProject(input?: ProjectCreate): Promise<ProjectDto>;
  updateProject(id: string, patch: ProjectPatch): Promise<ProjectDto>;
  deleteProject(id: string): Promise<void>;
  /** presign → PUT to S3 → register → mirror the server parse job */
  uploadScore(projectId: string, file: File): Promise<Job<ParseScoreResult>>;
  /** presign → PUT to S3 → decode for duration + peaks → register */
  uploadAudio(projectId: string, file: File): Promise<Job<AudioUploadResult>>;
  removeAudio(projectId: string): Promise<ProjectDto>;
  getProjectUrls(id: string, options?: { fresh?: boolean }): Promise<ProjectUrls>;
  fetchInfoMap(id: string): Promise<InfoMap>;
  /** The uploaded MusicXML as text (.mxl unzipped) for engraved notation; null when there is no score file to show. */
  fetchScoreXml(id: string): Promise<string | null>;
  /** PUT the whole sync state; resolves with the project (updatedAt, derived status) */
  saveSync(id: string, sync: SyncState, options?: { keepalive?: boolean }): Promise<ProjectDto>;
  /** PUT the whole display settings; resolves with the project (updatedAt) */
  saveDisplay(id: string, display: DisplaySettings, options?: { keepalive?: boolean }): Promise<ProjectDto>;

  // processing (browser-side jobs that persist through the API)
  startAlignment(projectId: string, input?: AlignJobInput): Promise<Job<AlignResult>>;
  /** detailed min/max peaks of the recording for the zoomable waveform (null when unavailable) */
  loadRecordingPeaks(projectId: string, signal?: AbortSignal): Promise<PeakPyramid | null>;
  exportMp4(options: ExportMp4Options): Promise<Job<ExportResult>>;
  exportProjectFile(projectId: string, filename: string): Promise<Job<ExportResult>>;
  openProjectFile(file: File): Promise<Job<OpenProjectResult>>;
  listExports(projectId: string): Promise<ExportDto[]>;
  getExportDownloadUrl(exportId: string): Promise<string>;

  // programs & activity
  listPrograms(): Promise<ProgramDto[]>;
  getProgram(id: string): Promise<{ program: ProgramDto; projects: ProjectSummary[] } | null>;
  createProgram(input: ProgramCreate): Promise<ProgramDto>;
  updateProgram(id: string, patch: ProgramPatch): Promise<ProgramDto>;
  deleteProgram(id: string): Promise<void>;
  listActivity(): Promise<ActivityItem[]>;

  // jobs (registry-backed; see src/lib/jobs/registry.ts)
  getJob<T>(jobId: string): Job<T> | null;
  subscribeJob<T>(jobId: string, cb: (job: Job<T>) => void): () => void;
}
