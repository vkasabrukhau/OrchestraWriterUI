/**
 * Async jobs. Server jobs (parse-score) are polled over HTTP; browser jobs
 * (align, export-mp4, export-project, open-project, upload-*) run in the page
 * or a worker. Both publish into src/lib/jobs/registry.ts so pages consume
 * them the same way through useJob(jobId).
 */
export type JobKind =
  | "parse-score"
  | "upload-score"
  | "upload-audio"
  | "generate-audio"
  | "align"
  | "export-mp4"
  | "export-project"
  | "open-project"
  | "transcribe";

export type JobStatus = "queued" | "running" | "succeeded" | "failed";

export interface Job<T = unknown> {
  id: string;
  kind: JobKind;
  status: JobStatus;
  /** 0–1 */
  progress: number;
  /** human-readable current step */
  message: string;
  result?: T;
  error?: string;
  startedAt: string;
  updatedAt: string;
}

export interface ParseScoreResult {
  title: string;
  composer: string;
  movement: string;
  parts: number;
  measures: number;
  durationSec: number;
  warnings: string[];
}

/**
 * Experimental: which instruments the transcriber may write (ml/server.py
 * ENSEMBLES). Left free, MuScriptor often hears strings as guitar and bass.
 */
export const TRANSCRIBE_ENSEMBLES = ["orchestra", "strings", "any"] as const;
export type TranscribeEnsemble = (typeof TRANSCRIBE_ENSEMBLES)[number];

/** Experimental: a score transcribed from the recording (ml/server.py, MuScriptor). */
export interface TranscribeScoreResult {
  /** detected instruments, one score part each */
  parts: string[];
  bpm: number | null;
  /** e.g. "muscriptor-medium" */
  model: string;
  /** wall-clock seconds the model took */
  seconds: number;
  /** the parse-score job that imports the transcribed score */
  parseJobId: string;
  /** true when the measure starts from the transcription were saved as the project's sync */
  synced: boolean;
}

/**
 * Experimental: corrections to a transcribed score's bars. They move bar
 * lines, never notes (MuScriptor's export options), and are applied without
 * running the model again.
 */
export interface TranscriptionBars {
  /** time signature in quarter-note beats (2 = 2/4 ... 7 = 7/4); null = as detected (4/4 when nothing was detected) */
  beatsPerBar: number | null;
  /** bar lines moved later by this many beats; the server keeps it within one bar (0 ≤ shift < beats per bar) */
  shiftBeats: number;
  /** 2: the tracker counted half notes as beats (double the tempo); 0.5: it counted eighths (halve it) */
  beatScale: 0.5 | 1 | 2;
}

export const TRANSCRIPTION_BEAT_SCALES = [0.5, 1, 2] as const;
export const TRANSCRIPTION_METERS = [2, 3, 4, 5, 6, 7] as const;
export const DEFAULT_TRANSCRIPTION_BARS: TranscriptionBars = { beatsPerBar: null, shiftBeats: 0, beatScale: 1 };

/** Experimental: what the project knows about its transcribed score (on the project summary). */
export interface TranscriptionInfo {
  /** e.g. "muscriptor-medium" */
  model: string;
  /** what the beat tracker found: beats per bar (null = not detected) and tempo */
  detected: { beatsPerBar: number | null; bpm: number | null };
  /** the bar settings the current score was written with */
  bars: TranscriptionBars;
  /** written tempo and beats per bar of the current score */
  bpm: number;
  beatsPerBar: number;
  /** plain-language caveats about the score ("rhythms are approximate", "4/4 was assumed") */
  warnings: string[];
}

export interface AudioUploadResult {
  filename: string;
  durationSec: number;
  /** 0–1, 420 bars */
  peaks: number[];
}

export interface AlignResult {
  measures: number;
  averageConfidence: number;
  uncertainMeasures: number;
  method: string;
}

export interface ExportResult {
  filename: string;
  bytes: number;
  /** download URL: a blob: URL right after a browser export, or a presigned S3 URL from history */
  url: string;
  exportId?: string;
  /** video codec actually used (MP4 exports) */
  codec?: string;
  /** e.g. "No AAC encoder in this browser; the video has no audio track." */
  warnings?: string[];
}

export interface OpenProjectResult {
  projectId: string;
  hasRecording: boolean;
}
