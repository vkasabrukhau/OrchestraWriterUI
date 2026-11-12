import { render, fireEvent } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { DisplaySettings } from "@/shared/project-file";
import { DEFAULT_SECTION_COLORS } from "@/shared/sections";

vi.mock("@/lib/api", () => ({
  api: { saveDisplay: vi.fn(async () => null) },
  API_MOCK: false,
  onAuthRequired: () => () => {},
  errorMessage: (_e: unknown, f: string) => f,
}));
vi.mock("@/lib/audio", () => ({ peaksFromInfoMap: () => [] }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn() }), usePathname: () => "/projects/p1/customize" }));

import { PlaybackShortcuts } from "@/components/music/Transport";
import { buildCommands, type CommandContext } from "@/lib/editor/commands";
import { useEditor } from "@/lib/store/editor";
import { usePlayback } from "@/lib/store/playback";
import { useProject } from "@/lib/store/project";
import { useEditorShortcuts } from "./useEditorCommands";

const display: DisplaySettings = {
  visibleParts: ["P1"],
  positions: { P1: { x: 0.5, y: 0.5 } },
  colors: {},
  sectionColors: { ...DEFAULT_SECTION_COLORS },
  sections: {},
  showLabels: true,
  labelMode: "sections",
  reducedMotion: false,
  glowScale: 1,
};

const save = vi.fn();
const toggleVisible = vi.fn();

function Harness() {
  const act = new Proxy({ save, setVisible: toggleVisible }, { get: (t: Record<string, unknown>, k: string) => (t[k] ??= vi.fn()) }) as unknown as CommandContext["act"];
  const commands = buildCommands({
    ready: true,
    dirty: false,
    canUndo: false,
    canRedo: false,
    selectedId: useEditor.getState().selectedId,
    selectedVisible: true,
    selectedHasColor: false,
    soloed: null,
    allVisible: true,
    panels: { instruments: true, properties: true, lanes: true },
    showLabels: true,
    labelMode: "sections",
    showSeating: true,
    showLegend: true,
    locked: false,
    theme: "program",
    reducedMotion: false,
    playing: false,
    loop: false,
    muted: false,
    rate: 1,
    act,
  });
  useEditorShortcuts(commands);
  return (
    <>
      <PlaybackShortcuts />
      <div data-editor-stage="" tabIndex={0} data-testid="stage" />
      <input data-testid="field" />
      <button type="button" data-testid="other">
        other
      </button>
    </>
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  useProject.setState({ projectId: "p1", display, dirty: false });
  useEditor.setState({ selectedId: "P1", locked: false });
  usePlayback.setState({ time: 10, duration: 100, playing: false });
});

describe("editor shortcuts", () => {
  it("arrow keys nudge the selected part while the stage has focus, and do not seek", () => {
    const { getByTestId } = render(<Harness />);
    const stage = getByTestId("stage");
    stage.focus();
    fireEvent.keyDown(stage, { key: "ArrowRight" });
    expect(useProject.getState().display!.positions.P1.x).toBeCloseTo(0.51);
    fireEvent.keyDown(stage, { key: "ArrowUp", shiftKey: true });
    expect(useProject.getState().display!.positions.P1.y).toBeCloseTo(0.5 - 0.015 * 5);
    expect(usePlayback.getState().time).toBe(10);
  });

  it("arrow keys seek when the stage is not focused", () => {
    const { getByTestId } = render(<Harness />);
    const other = getByTestId("other");
    other.focus();
    fireEvent.keyDown(other, { key: "ArrowRight" });
    expect(usePlayback.getState().time).toBe(15);
    expect(useProject.getState().display!.positions.P1).toEqual({ x: 0.5, y: 0.5 });
  });

  it("a locked layout does not nudge", () => {
    useEditor.setState({ locked: true });
    const { getByTestId } = render(<Harness />);
    const stage = getByTestId("stage");
    stage.focus();
    fireEvent.keyDown(stage, { key: "ArrowLeft" });
    expect(useProject.getState().display!.positions.P1).toEqual({ x: 0.5, y: 0.5 });
  });

  it("single-letter shortcuts are ignored while typing, modifier shortcuts are not", () => {
    const { getByTestId } = render(<Harness />);
    const field = getByTestId("field");
    field.focus();
    fireEvent.keyDown(field, { key: "h", code: "KeyH" });
    expect(toggleVisible).not.toHaveBeenCalled();
    const mod = navigator.platform.toLowerCase().includes("mac") ? { metaKey: true } : { ctrlKey: true };
    fireEvent.keyDown(field, { key: "s", code: "KeyS", ...mod });
    expect(save).toHaveBeenCalledTimes(1);
  });

  it("H hides the selected part outside fields", () => {
    const { getByTestId } = render(<Harness />);
    const other = getByTestId("other");
    other.focus();
    fireEvent.keyDown(other, { key: "h", code: "KeyH" });
    expect(toggleVisible).toHaveBeenCalledWith("P1", false);
  });
});
