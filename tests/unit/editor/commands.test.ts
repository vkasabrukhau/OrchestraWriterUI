import { describe, expect, it, vi } from "vitest";
import { buildCommands, clampPosition, formatShortcut, matchesShortcut, type CommandContext } from "@/lib/editor/commands";

function ctx(over: Partial<CommandContext> = {}): CommandContext {
  const act = new Proxy({}, { get: (t: Record<string, unknown>, k: string) => (t[k] ??= vi.fn()) }) as CommandContext["act"];
  return {
    ready: true,
    dirty: false,
    canUndo: false,
    canRedo: false,
    selectedId: null,
    selectedVisible: false,
    selectedHasColor: false,
    soloed: null,
    allVisible: true,
    panels: { instruments: true, properties: true, lanes: false },
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
    ...over,
  };
}

const key = (k: string, mods: Partial<Record<"metaKey" | "ctrlKey" | "shiftKey" | "altKey", boolean>> = {}, code = "") => ({
  key: k,
  code,
  metaKey: false,
  ctrlKey: false,
  shiftKey: false,
  altKey: false,
  ...mods,
});

describe("formatShortcut", () => {
  it("uses symbols on macOS and words elsewhere", () => {
    expect(formatShortcut({ key: "z", mod: true, shift: true }, true)).toBe("⇧⌘Z");
    expect(formatShortcut({ key: "z", mod: true, shift: true }, false)).toBe("Ctrl+Shift+Z");
    expect(formatShortcut({ key: "1", alt: true }, true)).toBe("⌥1");
    expect(formatShortcut({ key: " " }, true)).toBe("Space");
    expect(formatShortcut({ key: "?", shift: true }, true)).toBe("?");
    expect(formatShortcut({ key: "ArrowLeft" }, false)).toBe("←");
  });
});

describe("matchesShortcut", () => {
  it("requires exactly the listed modifiers", () => {
    expect(matchesShortcut(key("s", { metaKey: true }), { key: "s", mod: true }, true)).toBe(true);
    expect(matchesShortcut(key("s", { ctrlKey: true }), { key: "s", mod: true }, true)).toBe(false);
    expect(matchesShortcut(key("s", { ctrlKey: true }), { key: "s", mod: true }, false)).toBe(true);
    expect(matchesShortcut(key("s"), { key: "s", mod: true }, true)).toBe(false);
    expect(matchesShortcut(key("s", { metaKey: true, shiftKey: true }), { key: "s", mod: true }, true)).toBe(false);
    expect(matchesShortcut(key("Z", { metaKey: true, shiftKey: true }), { key: "z", mod: true, shift: true }, true)).toBe(true);
  });

  it("matches digits by code so ⌥1 works on macOS", () => {
    expect(matchesShortcut(key("¡", { altKey: true }, "Digit1"), { key: "1", alt: true }, true)).toBe(true);
    expect(matchesShortcut(key("h", {}, "KeyH"), { key: "h" }, true)).toBe(true);
  });
});

describe("buildCommands", () => {
  it("disables part commands without a selection", () => {
    const c = buildCommands(ctx());
    expect(c["parts.toggleVisible"].enabled).toBe(false);
    expect(c["parts.solo"].enabled).toBe(false);
    expect(c["edit.resetPart"].enabled).toBe(false);
    expect(c["edit.undo"].enabled).toBe(false);
  });

  it("labels the hide/show and solo toggles for the selected part", () => {
    expect(buildCommands(ctx({ selectedId: "P1", selectedVisible: true }))["parts.toggleVisible"].label).toBe("Hide selected part");
    expect(buildCommands(ctx({ selectedId: "P1", selectedVisible: false }))["parts.toggleVisible"].label).toBe("Show selected part");
    expect(buildCommands(ctx({ selectedId: "P1", soloed: "P1" }))["parts.solo"].label).toBe("Show all parts");
  });

  it("reports checked state for toggles and radios", () => {
    const c = buildCommands(ctx({ labelMode: "parts", rate: 0.75, theme: "stage" }));
    expect(c["view.lanes"].checked).toBe(false);
    expect(c["view.instruments"].checked).toBe(true);
    expect(c["view.labelParts"].checked).toBe(true);
    expect(c["view.labelSections"].checked).toBe(false);
    expect(c["play.rate075"].checked).toBe(true);
    expect(c["view.themeDark"].checked).toBe(true);
  });

  it("runs the matching action", () => {
    const context = ctx({ selectedId: "P2", selectedVisible: true });
    const c = buildCommands(context);
    c["parts.toggleVisible"].run();
    expect(context.act.setVisible).toHaveBeenCalledWith("P2", false);
    c["view.lock"].run();
    expect(context.act.setLocked).toHaveBeenCalledWith(true);
    c["play.goto"].run();
    expect(context.act.openDialog).toHaveBeenCalledWith("goto");
  });

  it("marks transport keys as handled by the Transport", () => {
    const c = buildCommands(ctx());
    expect(c["play.toggle"].shortcutElsewhere).toBe(true);
    expect(c["play.back"].shortcutElsewhere).toBe(true);
    expect(c["file.save"].shortcutElsewhere).toBeUndefined();
  });
});

describe("clampPosition", () => {
  it("keeps parts on the stage like a drag does", () => {
    expect(clampPosition({ x: -1, y: 2 })).toEqual({ x: 0.03, y: 0.9 });
    expect(clampPosition({ x: 0.5, y: 0.5 })).toEqual({ x: 0.5, y: 0.5 });
  });
});
