import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ProjectDto } from "@/shared/api";
import type { InfoMap } from "@/shared/info-map";
import type { DisplaySettings } from "@/shared/project-file";
import type { SyncState } from "@/shared/sync";

const { api } = vi.hoisted(() => ({
  api: {
    getProject: vi.fn(),
    fetchInfoMap: vi.fn(),
    getProjectUrls: vi.fn(),
    saveDisplay: vi.fn(),
    saveSync: vi.fn(),
    updateProject: vi.fn(),
  },
}));

vi.mock("@/lib/api", () => ({
  api,
  API_MOCK: false,
  onAuthRequired: () => () => {},
  errorMessage: (e: unknown, f: string) => (e instanceof Error ? e.message : f),
}));
vi.mock("@/lib/audio", () => ({ peaksFromInfoMap: () => [0.3, 0.3] }));

import { DISPLAY_SAVE_DEBOUNCE_MS, SYNC_SAVE_DEBOUNCE_MS, STAGE_SAVE_DEBOUNCE_MS, useProject } from "@/lib/store/project";

const infoMap: InfoMap = {
  instruments: [
    { id: "P1", name: "Violin I", shortName: "Vln. I", section: "Strings", notes: [] },
    { id: "P2", name: "Flute I", shortName: "Fl. I", section: "Woodwinds", notes: [] },
  ],
  measures: [
    { number: 1, startTime: 0, duration: 2 },
    { number: 2, startTime: 2, duration: 2 },
    { number: 3, startTime: 4, duration: 2 },
  ],
  duration: 6,
  tempo: 120,
  timeSignature: "4/4",
  warnings: [],
};

function dto(overrides: Partial<ProjectDto> = {}): ProjectDto {
  return {
    id: "p1",
    title: "Symphony",
    composer: "X",
    movement: "I",
    parts: 2,
    measures: 3,
    durationSec: 6,
    hasRecording: false,
    scoreName: "s.musicxml",
    stage: "import",
    status: "ready",
    updatedAt: "2026-10-26T10:00:00Z",
    createdAt: "2026-10-26T09:00:00Z",
    programIds: [],
    thumbnail: [],
    exports: 0,
    scoreKey: "k/score",
    audioFileId: null,
    audioKey: null,
    infoMapKey: "k/info-map.json",
    audioPeaks: null,
    parseJobId: null,
    sync: null,
    display: null,
    ...overrides,
  };
}

const sync: SyncState = {
  method: "test",
  auto: [
    { n: 1, startSec: 0.5, confidence: 95 },
    { n: 2, startSec: 2.5, confidence: 80 },
    { n: 3, startSec: 4.5, confidence: 99 },
  ],
  manual: [],
  averageConfidence: 91,
};

let savedCounter = 0;
const savedResponse = (patch: Partial<ProjectDto> = {}) => dto({ updatedAt: `2026-10-26T10:0${++savedCounter}:00Z`, ...patch });

beforeEach(() => {
  vi.useFakeTimers();
  vi.clearAllMocks();
  savedCounter = 0;
  api.getProject.mockResolvedValue(dto());
  api.fetchInfoMap.mockResolvedValue(infoMap);
  api.getProjectUrls.mockResolvedValue({ score: "s", audio: "https://s3.test/audio", infoMap: "i", expiresInSeconds: 900 });
  api.saveDisplay.mockImplementation(async (_id: string, display: DisplaySettings) => savedResponse({ display }));
  api.saveSync.mockImplementation(async (_id: string, s: SyncState) => savedResponse({ sync: s, status: "ready" }));
  api.updateProject.mockImplementation(async (_id: string, patch: Partial<ProjectDto>) => savedResponse(patch));
  useProject.setState({ projectId: null, status: "idle", summary: null, infoMap: null, display: null, sync: null, dirty: false, savedAt: null });
});

afterEach(() => {
  vi.useRealTimers();
});

describe("useProject.load", () => {
  it("fetches the project and info map, and saves default display once", async () => {
    await useProject.getState().load("p1");
    const s = useProject.getState();
    expect(s.status).toBe("ready");
    expect(s.summary?.title).toBe("Symphony");
    expect(s.infoMap?.instruments).toHaveLength(2);
    expect(s.display?.visibleParts).toEqual(["P1", "P2"]);
    expect(s.peaks).toEqual([0.3, 0.3]);
    expect(s.audioUrl).toBeNull();
    expect(s.dirty).toBe(false);
    expect(api.saveDisplay).toHaveBeenCalledTimes(1);
    expect(api.getProjectUrls).not.toHaveBeenCalled();
    expect(s.savedAt).toBe("2026-10-26T10:01:00Z");
  });

  it("keeps the stored display, resolves the audio URL, and reports not-found", async () => {
    const display: DisplaySettings = { visibleParts: ["P1"], positions: {}, colors: {}, sectionColors: { Strings: "#1", Woodwinds: "#2", Brass: "#3", Percussion: "#4", Other: "#5" }, sections: {}, showLabels: false, labelMode: "parts", reducedMotion: false, glowScale: 1.2 };
    api.getProject.mockResolvedValue(dto({ hasRecording: true, audioPeaks: [0.5], display, sync }));
    await useProject.getState().load("p1");
    const s = useProject.getState();
    expect(s.display).toEqual(display);
    // a legacy row (no `applied`) is normalized on load: every marker was audible, so applied = manual
    expect(s.sync).toEqual({ ...sync, applied: [] });
    expect(s.peaks).toEqual([0.5]);
    expect(s.audioUrl).toBe("https://s3.test/audio");
    expect(api.saveDisplay).not.toHaveBeenCalled();

    api.getProject.mockResolvedValue(null);
    await useProject.getState().load("missing");
    expect(useProject.getState().status).toBe("not-found");
    expect(useProject.getState().notFound).toBe(true);
  });

  it("ignores a stale response when the id changes mid-flight", async () => {
    let resolveA!: (p: ProjectDto) => void;
    api.getProject.mockImplementationOnce(() => new Promise<ProjectDto>((r) => (resolveA = r)));
    const first = useProject.getState().load("a");
    api.getProject.mockResolvedValueOnce(dto({ id: "b", title: "B" }));
    await useProject.getState().load("b");
    resolveA(dto({ id: "a", title: "A" }));
    await first;
    expect(useProject.getState().projectId).toBe("b");
    expect(useProject.getState().summary?.title).toBe("B");
  });
});

describe("useProject autosave", () => {
  it("debounces display saves (800 ms) and clears dirty from the response", async () => {
    await useProject.getState().load("p1");
    api.saveDisplay.mockClear();
    useProject.getState().setShowLabels(false);
    useProject.getState().setGlowScale(1.2);
    useProject.getState().setVisible("P2", false);
    expect(useProject.getState().dirty).toBe(true);
    expect(api.saveDisplay).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(DISPLAY_SAVE_DEBOUNCE_MS - 1);
    expect(api.saveDisplay).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(api.saveDisplay).toHaveBeenCalledTimes(1);
    const [, saved] = api.saveDisplay.mock.calls[0] as [string, DisplaySettings];
    expect(saved).toMatchObject({ showLabels: false, glowScale: 1.2, visibleParts: ["P1"] });
    const s = useProject.getState();
    expect(s.dirty).toBe(false);
    expect(s.savedAt).toBe("2026-10-26T10:02:00Z");
  });

  it("debounces sync saves (400 ms) and keeps manual markers", async () => {
    api.getProject.mockResolvedValue(dto({ hasRecording: true, sync, display: { visibleParts: [], positions: {}, colors: {}, sectionColors: { Strings: "#1", Woodwinds: "#2", Brass: "#3", Percussion: "#4", Other: "#5" }, sections: {}, showLabels: true, labelMode: "sections", reducedMotion: false, glowScale: 1 } }));
    await useProject.getState().load("p1");
    useProject.getState().addMarker(2, 2.8);
    useProject.getState().nudgeMarker(2, 0.1);
    await vi.advanceTimersByTimeAsync(SYNC_SAVE_DEBOUNCE_MS);
    expect(api.saveSync).toHaveBeenCalledTimes(1);
    const [, savedSync] = api.saveSync.mock.calls[0] as [string, SyncState];
    expect(savedSync.manual).toHaveLength(1);
    expect(savedSync.manual[0].measure).toBe(2);
    expect(savedSync.manual[0].startSec).toBeCloseTo(2.9);
    expect(useProject.getState().dirty).toBe(false);
    expect(api.saveDisplay).not.toHaveBeenCalled();

    useProject.getState().replaceAuto({ ...sync, method: "fresh", averageConfidence: 97 });
    await vi.advanceTimersByTimeAsync(SYNC_SAVE_DEBOUNCE_MS);
    const [, second] = api.saveSync.mock.calls[1] as [string, SyncState];
    expect(second.method).toBe("fresh");
    expect(second.manual).toHaveLength(1);
  });

  it("keeps note-level markers apart from the downbeat marker of the same bar", async () => {
    api.getProject.mockResolvedValue(dto({ hasRecording: true, sync }));
    await useProject.getState().load("p1");
    const st = () => useProject.getState();
    st().addMarker(2, 2.8);
    st().addMarker(2, 3.3, 0.5);
    st().addMarker(2, 3.35, 0.5); // same note: replaces
    st().nudgeMarker(2, -0.05, 0.5);
    let manual = st().sync!.manual;
    expect(manual.map((m) => [m.measure, m.position, m.startSec])).toEqual([
      [2, undefined, 2.8],
      [2, 0.5, expect.closeTo(3.3)],
    ]);
    st().removeMarker(2);
    manual = st().sync!.manual;
    expect(manual.map((m) => [m.measure, m.position])).toEqual([[2, 0.5]]);
  });

  it("stays dirty until the last edit is saved, and saveNow flushes immediately", async () => {
    await useProject.getState().load("p1");
    api.saveDisplay.mockClear();
    useProject.getState().setShowLabels(false);
    await vi.advanceTimersByTimeAsync(DISPLAY_SAVE_DEBOUNCE_MS / 2);
    useProject.getState().setShowLabels(true);
    await vi.advanceTimersByTimeAsync(DISPLAY_SAVE_DEBOUNCE_MS / 2);
    expect(api.saveDisplay).not.toHaveBeenCalled(); // timer restarted
    await useProject.getState().saveNow();
    expect(api.saveDisplay).toHaveBeenCalledTimes(1);
    expect(useProject.getState().dirty).toBe(false);
    await vi.advanceTimersByTimeAsync(DISPLAY_SAVE_DEBOUNCE_MS);
    expect(api.saveDisplay).toHaveBeenCalledTimes(1); // nothing left to flush
  });

  it("advances the stage forward only, with a debounced PATCH", async () => {
    await useProject.getState().load("p1");
    useProject.getState().setStage("customize");
    useProject.getState().setStage("import");
    expect(useProject.getState().summary?.stage).toBe("customize");
    await vi.advanceTimersByTimeAsync(STAGE_SAVE_DEBOUNCE_MS);
    expect(api.updateProject).toHaveBeenCalledTimes(1);
    expect(api.updateProject).toHaveBeenCalledWith("p1", { stage: "customize" });
    expect(useProject.getState().dirty).toBe(false);
  });

  it("records a save error without dropping local edits", async () => {
    await useProject.getState().load("p1");
    api.saveDisplay.mockRejectedValueOnce(new Error("Not signed in"));
    useProject.getState().setGlowScale(0.8);
    await vi.advanceTimersByTimeAsync(DISPLAY_SAVE_DEBOUNCE_MS);
    const s = useProject.getState();
    expect(s.saveError).toBe("Not signed in");
    expect(s.dirty).toBe(true);
    expect(s.display?.glowScale).toBe(0.8);
  });
});
