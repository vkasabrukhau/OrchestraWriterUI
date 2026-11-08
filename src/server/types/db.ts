// Row types mirroring the SQL tables (snake_case, as Postgres returns them).
// pg returns BIGINT as string, REAL/INTEGER as number, JSONB parsed, TIMESTAMPTZ as Date.

export type UserRow = {
  id: number;
  name: string;
  email: string;
  email_verified: boolean;
  image: string | null;
  created_at: Date;
  updated_at: Date;
};

export type AudioFileRow = {
  id: number;
  user_id: number;
  name: string;
  s3_key: string;
  audio_length_seconds: number;
  bytes: string | null;
  created_at: Date;
};

export type ProfileRow = {
  user_id: number;
  handle: string;
  role: string;
  ensemble: string;
  location: string;
  bio: string;
  website: string | null;
  preferences: Record<string, unknown>;
  created_at: Date;
  updated_at: Date;
};

export type ParseStatus = "none" | "running" | "succeeded" | "failed";

export type ProjectRow = {
  id: number;
  user_id: number;
  title: string;
  subtitle: string | null;
  composer: string;
  movement: string;
  score_filename: string | null;
  score_key: string | null;
  score_bytes: string | null;
  info_map_key: string | null;
  audio_file_id: number | null;
  audio_peaks: number[] | null;
  parts: number;
  measures: number;
  duration_seconds: number;
  tempo: number | null;
  time_signature: string | null;
  warnings: string[];
  thumbnail: unknown[];
  stage: string;
  parse_status: ParseStatus;
  parse_error: string | null;
  parse_job_id: number | null;
  sync: unknown;
  display: unknown;
  /** experimental: see services/transcribe-score.ts (StoredTranscription) */
  transcription: unknown;
  created_at: Date;
  updated_at: Date;
};

export type ProgramRow = {
  id: number;
  user_id: number;
  name: string;
  season: string;
  date: string | null;
  venue: string;
  description: string;
  color: string;
  notes: string;
  created_at: Date;
  updated_at: Date;
};

export type JobRow = {
  id: number;
  user_id: number;
  project_id: number | null;
  kind: string;
  status: "queued" | "running" | "succeeded" | "failed";
  progress: number;
  message: string;
  result: unknown;
  error: string | null;
  created_at: Date;
  updated_at: Date;
};

export type ExportRow = {
  id: number;
  user_id: number;
  project_id: number;
  kind: "mp4" | "project";
  filename: string;
  s3_key: string;
  bytes: string;
  resolution: "720p" | "1080p" | "4k" | null;
  frame_rate: number | null;
  created_at: Date;
};

export type ActivityRow = {
  id: number;
  user_id: number;
  project_id: number;
  kind: "import" | "sync" | "export" | "edit" | "share";
  text: string;
  created_at: Date;
};
