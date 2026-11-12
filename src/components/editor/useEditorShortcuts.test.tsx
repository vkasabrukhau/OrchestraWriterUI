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
import { useEditor, useEditorRequest } from "@/lib/store/editor";
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
      <div role="menu">
        <div role="menuitem" tabIndex={-1} data-testid="menuitem">
          Play
        </div>
      </div>
      <div role="slider" tabIndex={0} aria-valuenow={1} data-testid="slider" />
    </>
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  useProject.setState({ projectId: "p1", display, dirty: false, canUndo: false, canRedo: false });
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

describe("playback shortcuts leave keys to the focused widget", () => {
  it("Space on a menu item does not also toggle playback", () => {
    const { getByTestId } = render(<Harness />);
    const item = getByTestId("menuitem");
    item.focus();
    fireEvent.keyDown(item, { key: " ", code: "Space" });
    expect(usePlayback.getState().playing).toBe(false);
  });

  it("arrow keys on a slider do not seek", () => {
    const { getByTestId } = render(<Harness />);
    const slider = getByTestId("slider");
    slider.focus();
    fireEvent.keyDown(slider, { key: "ArrowRight" });
    fireEvent.keyDown(slider, { key: "Home" });
    expect(usePlayback.getState().time).toBe(10);
  });

  it("modifier combinations are not playback shortcuts", () => {
    const { getByTestId } = render(<Harness />);
    const other = getByTestId("other");
    other.focus();
    fireEvent.keyDown(other, { key: "ArrowRight", metaKey: true });
    fireEvent.keyDown(other, { key: "ArrowRight", altKey: true });
    expect(usePlayback.getState().time).toBe(10);
  });
});

describe("editor shortcut details", () => {
  it("a disabled shortcut does not swallow its key", () => {
    useEditor.setState({ selectedId: null });
    const { getByTestId } = render(<Harness />);
    const other = getByTestId("other");
    other.focus();
    // fireEvent returns false when the event was default-prevented
    expect(fireEvent.keyDown(other, { key: "Escape", code: "Escape" })).toBe(true);
    expect(fireEvent.keyDown(other, { key: "h", code: "KeyH" })).toBe(true);
    expect(toggleVisible).not.toHaveBeenCalled();
  });

  it("letter shortcuts follow the keyboard layout, not the physical key", () => {
    const { getByTestId } = render(<Harness />);
    const other = getByTestId("other");
    other.focus();
    // AZERTY-style: the key labelled H sits where QWERTY has J
    fireEvent.keyDown(other, { key: "h", code: "KeyJ" });
    expect(toggleVisible).toHaveBeenCalledTimes(1);
    fireEvent.keyDown(other, { key: "j", code: "KeyH" });
    expect(toggleVisible).toHaveBeenCalledTimes(1);
  });

  it("a held arrow key is one undo step; separate presses are separate steps", () => {
    const { getByTestId } = render(<Harness />);
    const stage = getByTestId("stage");
    stage.focus();
    fireEvent.keyDown(stage, { key: "ArrowRight" });
    for (let i = 0; i < 5; i++) fireEvent.keyDown(stage, { key: "ArrowRight", repeat: true });
    fireEvent.keyDown(stage, { key: "ArrowRight" });
    expect(useProject.getState().display!.positions.P1.x).toBeCloseTo(0.57);
    useProject.getState().undo();
    expect(useProject.getState().display!.positions.P1.x).toBeCloseTo(0.56);
    useProject.getState().undo();
    // (earlier tests' steps may still be below these two; the stacks are module-wide)
    expect(useProject.getState().display!.positions.P1.x).toBeCloseTo(0.5);
  });
});

describe("useEditorRequest", () => {
  function Listener({ onFocus }: { onFocus: () => void }) {
    useEditorRequest("searchFocus", onFocus);
    return null;
  }

  it("reacts to requests made while mounted, and does not replay them on remount", () => {
    const first = vi.fn();
    const a = render(<Listener onFocus={first} />);
    useEditor.getState().focusSearch();
    expect(first).toHaveBeenCalledTimes(1);
    a.unmount();

    const second = vi.fn();
    render(<Listener onFocus={second} />);
    expect(second).not.toHaveBeenCalled();
    useEditor.getState().focusSearch();
    expect(second).toHaveBeenCalledTimes(1);
  });
});
