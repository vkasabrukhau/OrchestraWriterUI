import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ProjectDto } from "@/shared/api";
import type { InfoMap } from "@/shared/info-map";
import type { DisplaySettings } from "@/shared/project-file";

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

import { DISPLAY_SAVE_DEBOUNCE_MS, HISTORY_LIMIT, MERGE_WINDOW_MS, useProject } from "@/lib/store/project";

const infoMap: InfoMap = {
  instruments: [
    { id: "P1", name: "Violin I", shortName: "Vln. I", section: "Strings", notes: [] },
    { id: "P2", name: "Flute I", shortName: "Fl. I", section: "Woodwinds", notes: [] },
  ],
  measures: [{ number: 1, startTime: 0, duration: 2 }],
  duration: 2,
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
    measures: 1,
    durationSec: 2,
    hasRecording: false,
    scoreName: "s.musicxml",
    stage: "customize",
    status: "ready",
    updatedAt: "2026-11-11T10:00:00Z",
    createdAt: "2026-11-11T09:00:00Z",
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

beforeEach(async () => {
  vi.useFakeTimers();
  vi.clearAllMocks();
  api.getProject.mockResolvedValue(dto());
  api.fetchInfoMap.mockResolvedValue(infoMap);
  api.getProjectUrls.mockResolvedValue({ score: "s", audio: null, infoMap: "i", expiresInSeconds: 900 });
  api.saveDisplay.mockImplementation(async (_id: string, display: DisplaySettings) => dto({ display }));
  api.updateProject.mockImplementation(async (_id: string, patch: Partial<ProjectDto>) => dto(patch));
  useProject.setState({ projectId: null, status: "idle", summary: null, infoMap: null, display: null, sync: null, dirty: false, savedAt: null });
  await useProject.getState().load("p1");
  api.saveDisplay.mockClear();
});

afterEach(() => {
  vi.useRealTimers();
});

const s = () => useProject.getState();

describe("display undo/redo", () => {
  it("starts empty after load", () => {
    expect(s().canUndo).toBe(false);
    expect(s().canRedo).toBe(false);
  });

  it("undoes and redoes one edit at a time", () => {
    const original = s().display!;
    s().setShowLabels(false);
    s().setGlowScale(1.2);
    expect(s().canUndo).toBe(true);

    s().undo();
    expect(s().display!.glowScale).toBe(1);
    expect(s().display!.showLabels).toBe(false);
    expect(s().canRedo).toBe(true);

    s().undo();
    expect(s().display).toBe(original);
    expect(s().canUndo).toBe(false);

    s().redo();
    s().redo();
    expect(s().display!).toMatchObject({ showLabels: false, glowScale: 1.2 });
    expect(s().canRedo).toBe(false);
  });

  it("a new edit clears the redo stack", () => {
    s().setGlowScale(1.2);
    s().undo();
    expect(s().canRedo).toBe(true);
    s().setShowLabels(false);
    expect(s().canRedo).toBe(false);
  });

  it("groups a drag (many moves) into one step", () => {
    const before = s().display!.positions.P1;
    s().beginGesture();
    for (let i = 1; i <= 20; i++) s().setPosition("P1", { x: 0.1 + i * 0.01, y: 0.5 });
    s().endGesture();
    expect(s().display!.positions.P1.x).toBeCloseTo(0.3);
    s().undo();
    expect(s().display!.positions.P1).toEqual(before);
    expect(s().canUndo).toBe(false);
  });

  it("keeps at most HISTORY_LIMIT steps", () => {
    for (let i = 0; i < HISTORY_LIMIT + 10; i++) s().setGlowScale(0.6 + (i % 2) * 0.1);
    let n = 0;
    while (s().canUndo) {
      s().undo();
      n++;
    }
    expect(n).toBe(HISTORY_LIMIT);
  });

  it("autosaves the restored display", async () => {
    s().setGlowScale(1.3);
    await vi.advanceTimersByTimeAsync(DISPLAY_SAVE_DEBOUNCE_MS);
    api.saveDisplay.mockClear();
    s().undo();
    expect(s().dirty).toBe(true);
    await vi.advanceTimersByTimeAsync(DISPLAY_SAVE_DEBOUNCE_MS);
    expect(api.saveDisplay).toHaveBeenCalledTimes(1);
    expect((api.saveDisplay.mock.calls[0] as [string, DisplaySettings])[1].glowScale).toBe(1);
    expect(s().dirty).toBe(false);
  });

  it("forgets the history when another project loads", async () => {
    s().setGlowScale(1.3);
    api.getProject.mockResolvedValue(dto({ id: "p2" }));
    await s().load("p2");
    expect(s().canUndo).toBe(false);
    s().undo();
    expect(s().display!.glowScale).toBe(1);
  });
});

describe("streamed edits (merge keys)", () => {
  it("a color picker's input events become one undo step", () => {
    const before = s().display!.colors.P1;
    for (const c of ["#111111", "#222222", "#333333", "#444444"]) {
      s().setPartColor("P1", c, { merge: "color:P1" });
      vi.advanceTimersByTime(50);
    }
    expect(s().display!.colors.P1).toBe("#444444");
    s().undo();
    expect(s().display!.colors.P1).toBe(before);
    expect(s().canUndo).toBe(false);
  });

  it("starts a new step after a pause, a different key, or an undo", () => {
    s().setGlowScale(1.1, { merge: "glow" });
    s().setGlowScale(1.2, { merge: "glow" });
    vi.advanceTimersByTime(MERGE_WINDOW_MS + 1);
    s().setGlowScale(1.3, { merge: "glow" });
    s().setPartColor("P1", "#123456", { merge: "color:P1" });
    s().undo();
    expect(s().display!.glowScale).toBe(1.3);
    s().undo();
    expect(s().display!.glowScale).toBe(1.2);
    // after an undo the next edit with the same key is a fresh step
    s().setGlowScale(0.8, { merge: "glow" });
    s().undo();
    expect(s().display!.glowScale).toBe(1.2);
  });

  it("an unmerged edit in between ends the run", () => {
    s().setGlowScale(1.1, { merge: "glow" });
    s().setShowLabels(false);
    s().setGlowScale(1.2, { merge: "glow" });
    s().undo();
    expect(s().display!).toMatchObject({ glowScale: 1.1, showLabels: false });
  });

  it("merged edits still clear the redo stack", () => {
    s().setGlowScale(1.1, { merge: "glow" });
    s().setShowLabels(false);
    s().undo();
    expect(s().canRedo).toBe(true);
    s().setGlowScale(1.2, { merge: "glow" });
    expect(s().canRedo).toBe(false);
  });
});

describe("refresh keeps the history", () => {
  it("keeps undo when the server returns the same display (keys reordered by jsonb)", async () => {
    s().setGlowScale(1.3);
    await vi.advanceTimersByTimeAsync(DISPLAY_SAVE_DEBOUNCE_MS);
    expect(s().dirty).toBe(false);
    const local = s().display!;
    // same values, different key order (Postgres jsonb does this)
    const reordered = Object.fromEntries(Object.entries(structuredClone(local)).reverse()) as DisplaySettings;
    api.getProject.mockResolvedValue(dto({ display: reordered }));
    await s().refresh();
    expect(s().canUndo).toBe(true);
    expect(s().display).toBe(local);
    s().undo();
    expect(s().display!.glowScale).toBe(1);
  });

  it("clears undo when the server copy really changed", async () => {
    s().setGlowScale(1.3);
    await vi.advanceTimersByTimeAsync(DISPLAY_SAVE_DEBOUNCE_MS);
    api.getProject.mockResolvedValue(dto({ display: { ...s().display!, glowScale: 0.7 } }));
    await s().refresh();
    expect(s().display!.glowScale).toBe(0.7);
    expect(s().canUndo).toBe(false);
  });
});

describe("resetPart and rename", () => {
  it("puts one part back on its seat and drops its color", () => {
    const seat = s().display!.positions.P1;
    s().setPosition("P1", { x: 0.9, y: 0.1 });
    s().setPartColor("P1", "#123456");
    s().setPosition("P2", { x: 0.2, y: 0.2 });
    s().resetPart("P1");
    expect(s().display!.positions.P1).toEqual(seat);
    expect(s().display!.colors.P1).toBeUndefined();
    expect(s().display!.positions.P2).toEqual({ x: 0.2, y: 0.2 });
  });

  it("renames optimistically and rolls back on failure", async () => {
    await s().rename("  Eroica  ");
    expect(api.updateProject).toHaveBeenCalledWith("p1", { title: "Eroica" });
    expect(s().summary!.title).toBe("Eroica");

    api.updateProject.mockRejectedValueOnce(new Error("nope"));
    await expect(s().rename("Pastoral")).rejects.toThrow("nope");
    expect(s().summary!.title).toBe("Eroica");
  });
});
