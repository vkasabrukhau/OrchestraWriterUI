import type { TranscriptionInfo } from "./jobs";
import type { Section } from "./sections";

/** A director / educator / listener using the app. */
export interface Director {
  id: string;
  name: string;
  handle: string;
  email: string;
  role: "Music director" | "Educator" | "Conductor" | "Listener" | "Student";
  ensemble: string;
  location: string;
  bio: string;
  initials: string;
  joinedAt: string;
  website?: string;
}

export type ProjectStage = "import" | "sync" | "customize" | "preview" | "export";

export type ProjectStatus = "importing" | "needs-sync" | "ready" | "exported" | "failed";

export interface ProjectSummary {
  id: string;
  title: string;
  /** e.g. "in C minor" — rendered in italics after the title */
  subtitle?: string;
  composer: string;
  movement: string;
  parts: number;
  measures: number;
  durationSec: number;
  hasRecording: boolean;
  recordingName?: string;
  scoreName: string;
  stage: ProjectStage;
  status: ProjectStatus;
  statusDetail?: string;
  updatedAt: string;
  createdAt: string;
  programIds: string[];
  /** which sections are prominent — drives the card thumbnail */
  thumbnail: Array<{ section: Section; x: number; y: number; level: number }>;
  averageConfidence?: number;
  exports: number;
  /** experimental: a transcription of the recording into a score is running on the server */
  transcribing?: boolean;
  /** experimental: the score was transcribed from the recording; its bar settings and caveats */
  transcription?: TranscriptionInfo;
}

export interface Program {
  id: string;
  name: string;
  season: string;
  date: string;
  venue: string;
  description: string;
  projectIds: string[];
  color: Section;
}

export interface ActivityItem {
  id: string;
  kind: "import" | "sync" | "export" | "edit" | "share";
  projectId: string;
  text: string;
  at: string;
}
