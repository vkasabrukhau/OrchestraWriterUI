import { StrictMode } from "react";
import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ProjectSummary } from "@/shared/domain";
import type { InfoMap } from "@/shared/info-map";
import type { AlignResult } from "@/shared/jobs";

const { api, router } = vi.hoisted(() => ({
  api: {
    startAlignment: vi.fn(),
    getProject: vi.fn(),
    saveDisplay: vi.fn(),
    saveSync: vi.fn(),
    updateProject: vi.fn(),
    getJob: vi.fn(),
    subscribeJob: vi.fn(),
  },
  router: { push: vi.fn(), replace: vi.fn() },
}));

// the aligner experiment turns off auto-start; these tests cover the page without it
vi.mock("./experiment/AlignerChoice", async (orig) => ({ ...(await orig<typeof import("./experiment/AlignerChoice")>()), REDLINE_EXPERIMENT: false }));

vi.mock("@/lib/api", async () => {
  const registry = await import("@/lib/jobs/registry");
  api.getJob.mockImplementation(registry.getJob);
  api.subscribeJob.mockImplementation(registry.subscribeJob);
  return {
    api,
    API_MOCK: false,
    onAuthRequired: () => () => {},
    errorMessage: (e: unknown, f: string) => (e instanceof Error ? e.message : f),
  };
});
vi.mock("@/lib/audio", () => ({ peaksFromInfoMap: () => [0.3, 0.3] }));
vi.mock("next/navigation", () => ({ useRouter: () => router, usePathname: () => "/projects/p1/sync" }));

import { createJob, updateJob } from "@/lib/jobs/registry";
import { useProject } from "@/lib/store/project";
import { forgetAllJobs } from "@/components/import/projectJobs";
import { SyncPage } from "./SyncPage";

const summary: ProjectSummary = {
  id: "p1",
  title: "Orchestra Demo",
  composer: "Fixture Composer",
  movement: "I",
  parts: 1,
  measures: 2,
  durationSec: 4,
  hasRecording: true,
  recordingName: "orchestra-demo.mp3",
  scoreName: "orchestra-demo.musicxml",
  stage: "sync",
  status: "needs-sync",
  updatedAt: "2026-10-26T10:00:00Z",
  createdAt: "2026-10-26T10:00:00Z",
  programIds: [],
  thumbnail: [],
  exports: 0,
};

const infoMap: InfoMap = {
  instruments: [{ id: "P1", name: "Violin I", shortName: "Vln. I", section: "Strings", notes: [] }],
  measures: [
    { number: 1, startTime: 0, duration: 2 },
    { number: 2, startTime: 2, duration: 2 },
  ],
  duration: 4,
  tempo: 120,
  timeSignature: "4/4",
  warnings: [],
};

const refresh = vi.fn(async () => {});

function setProject(overrides: Partial<ProjectSummary> = {}) {
  useProject.setState({
    projectId: "p1",
    status: "ready",
    summary: { ...summary, ...overrides },
    infoMap,
    display: null,
    sync: null,
    peaks: [0.2, 0.4],
    audioUrl: "https://s3.test/audio.mp3",
    refresh,
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  forgetAllJobs();
});

describe("SyncPage", () => {
  it("starts auto-alignment once when the project has a recording but no alignment", async () => {
    setProject();
    const job = createJob<AlignResult>("align");
    api.startAlignment.mockResolvedValue(job);

    render(
      <StrictMode>
        <SyncPage projectId="p1" />
      </StrictMode>,
    );

    expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent("Sync the recording");
    expect(screen.getByRole("heading", { name: "Aligning the recording to the score" })).toBeInTheDocument();
    await waitFor(() => expect(api.startAlignment).toHaveBeenCalledWith("p1"));

    act(() => {
      updateJob(job.id, { status: "running", progress: 0.5, message: "Matching the recording to the score" });
    });
    expect(await screen.findByText("Matching the recording to the score…")).toBeInTheDocument();
    expect(screen.getByText("50%")).toBeInTheDocument();
    expect(api.startAlignment).toHaveBeenCalledTimes(1);

    act(() => {
      updateJob(job.id, { status: "succeeded", progress: 1, message: "Done", result: { measures: 2, averageConfidence: 95, uncertainMeasures: 0, method: "chroma-dtw" } });
    });
    await waitFor(() => expect(refresh).toHaveBeenCalledTimes(1));
    expect(api.startAlignment).toHaveBeenCalledTimes(1);
  });

  it("offers a retry when auto-alignment fails instead of starting again", async () => {
    setProject();
    const job = createJob<AlignResult>("align");
    api.startAlignment.mockResolvedValue(job);
    render(<SyncPage projectId="p1" />);
    await waitFor(() => expect(api.startAlignment).toHaveBeenCalledTimes(1));

    act(() => {
      updateJob(job.id, { status: "failed", message: "Failed", error: "The recording could not be decoded" });
    });
    expect(await screen.findByRole("heading", { name: "Auto-alignment failed" })).toBeInTheDocument();
    expect(screen.getByRole("alert")).toHaveTextContent("The recording could not be decoded");
    expect(api.startAlignment).toHaveBeenCalledTimes(1);

    const retryJob = createJob<AlignResult>("align");
    api.startAlignment.mockResolvedValue(retryJob);
    await userEvent.setup().click(screen.getByRole("button", { name: "Retry" }));
    await waitFor(() => expect(api.startAlignment).toHaveBeenCalledTimes(2));
  });

  it("shows the no-recording state and never aligns", async () => {
    setProject({ hasRecording: false, recordingName: undefined, status: "ready" });
    const user = userEvent.setup();
    render(<SyncPage projectId="p1" />);

    expect(screen.getByRole("heading", { level: 1, name: "No recording to sync" })).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: /continue to customize/i }));
    expect(router.push).toHaveBeenCalledWith("/projects/p1/customize");
    expect(api.startAlignment).not.toHaveBeenCalled();
  });
});
