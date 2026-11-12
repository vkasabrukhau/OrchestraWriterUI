/**
 * One registry for the editor's commands. The menu bar, the toolbar and the
 * keyboard handler all read it, so a label, a shortcut and the enabled /
 * checked state are defined once.
 *
 * Pure: `buildCommands` takes a context of state and actions and returns
 * plain objects. The React hook that builds the context lives in
 * `src/components/editor/useEditorCommands.ts`.
 */

export interface Shortcut {
  /** `KeyboardEvent.key` (case-insensitive) or the digit/letter of `KeyboardEvent.code` */
  key: string;
  /** ⌘ on macOS, Ctrl elsewhere */
  mod?: boolean;
  shift?: boolean;
  alt?: boolean;
}

export interface Command {
  id: CommandId;
  label: string;
  shortcut?: Shortcut;
  /** the shortcut is handled by another component (the Transport); only show it */
  shortcutElsewhere?: boolean;
  enabled: boolean;
  /** present on toggles and radio items */
  checked?: boolean;
  run: () => void;
}

export type CommandId =
  | "file.new"
  | "file.open"
  | "file.save"
  | "file.export"
  | "file.rename"
  | "file.library"
  | "edit.undo"
  | "edit.redo"
  | "edit.find"
  | "edit.deselect"
  | "edit.resetPart"
  | "edit.resetPositions"
  | "edit.resetColors"
  | "view.instruments"
  | "view.properties"
  | "view.lanes"
  | "view.labels"
  | "view.labelSections"
  | "view.labelParts"
  | "view.seating"
  | "view.legend"
  | "view.lock"
  | "view.fullscreen"
  | "view.themeLight"
  | "view.themeDark"
  | "view.reducedMotion"
  | "play.toggle"
  | "play.start"
  | "play.back"
  | "play.forward"
  | "play.goto"
  | "play.loop"
  | "play.rate1"
  | "play.rate075"
  | "play.rate05"
  | "play.mute"
  | "parts.toggleVisible"
  | "parts.solo"
  | "parts.showAll"
  | "parts.useSectionColor"
  | "help.shortcuts"
  | "help.about"
  | "nav.preview";

export type Commands = Record<CommandId, Command>;

export interface CommandContext {
  ready: boolean;
  dirty: boolean;
  canUndo: boolean;
  canRedo: boolean;
  selectedId: string | null;
  selectedVisible: boolean;
  selectedHasColor: boolean;
  soloed: string | null;
  allVisible: boolean;
  panels: { instruments: boolean; properties: boolean; lanes: boolean };
  showLabels: boolean;
  labelMode: "sections" | "parts";
  showSeating: boolean;
  showLegend: boolean;
  locked: boolean;
  theme: "program" | "stage";
  reducedMotion: boolean;
  playing: boolean;
  loop: boolean;
  muted: boolean;
  rate: number;
  act: {
    navigate: (path: string) => void;
    save: () => void;
    exportProject: () => void;
    openDialog: (d: "rename" | "shortcuts" | "about" | "goto") => void;
    undo: () => void;
    redo: () => void;
    focusSearch: () => void;
    select: (id: string | null) => void;
    resetPart: (id: string) => void;
    resetPositions: () => void;
    resetColors: () => void;
    togglePanel: (p: "instruments" | "properties" | "lanes") => void;
    setShowLabels: (v: boolean) => void;
    setLabelMode: (m: "sections" | "parts") => void;
    setShowSeating: (v: boolean) => void;
    setShowLegend: (v: boolean) => void;
    setLocked: (v: boolean) => void;
    fullscreen: () => void;
    setTheme: (t: "program" | "stage") => void;
    setReducedMotion: (v: boolean) => void;
    togglePlay: () => void;
    seek: (t: number) => void;
    skip: (dt: number) => void;
    toggleLoop: () => void;
    setRate: (r: number) => void;
    toggleMute: () => void;
    setVisible: (id: string, v: boolean) => void;
    solo: (id: string) => void;
    showAll: () => void;
    clearPartColor: (id: string) => void;
    continueToPreview: () => void;
  };
}

export function buildCommands(c: CommandContext): Commands {
  const a = c.act;
  const sel = c.selectedId;
  const cmd = (id: CommandId, label: string, run: () => void, opts: Partial<Omit<Command, "id" | "label" | "run">> = {}): Command => ({
    id,
    label,
    run,
    enabled: opts.enabled ?? true,
    ...opts,
  });
  const list: Command[] = [
    cmd("file.new", "New project", () => a.navigate("/projects/new")),
    cmd("file.open", "Open project file…", () => a.navigate("/projects/new/import"), { shortcut: { key: "o", mod: true } }),
    cmd("file.save", "Save", a.save, { shortcut: { key: "s", mod: true }, enabled: c.ready }),
    cmd("file.export", "Export project file or video…", a.exportProject, { shortcut: { key: "e", mod: true, shift: true }, enabled: c.ready }),
    cmd("file.rename", "Rename project…", () => a.openDialog("rename"), { enabled: c.ready }),
    cmd("file.library", "Back to library", () => a.navigate("/library")),

    cmd("edit.undo", "Undo", a.undo, { shortcut: { key: "z", mod: true }, enabled: c.canUndo }),
    cmd("edit.redo", "Redo", a.redo, { shortcut: { key: "z", mod: true, shift: true }, enabled: c.canRedo }),
    cmd("edit.find", "Find instrument", a.focusSearch, { shortcut: { key: "k", mod: true } }),
    cmd("edit.deselect", "Deselect", () => a.select(null), { shortcut: { key: "Escape" }, enabled: sel !== null }),
    cmd("edit.resetPart", "Reset selected part", () => sel && a.resetPart(sel), { enabled: sel !== null }),
    cmd("edit.resetPositions", "Reset all positions", a.resetPositions, { enabled: c.ready }),
    cmd("edit.resetColors", "Reset all colors", a.resetColors, { enabled: c.ready }),

    cmd("view.instruments", "Instruments panel", () => a.togglePanel("instruments"), { checked: c.panels.instruments, shortcut: { key: "1", alt: true } }),
    cmd("view.properties", "Properties panel", () => a.togglePanel("properties"), { checked: c.panels.properties, shortcut: { key: "2", alt: true } }),
    cmd("view.lanes", "Part lanes", () => a.togglePanel("lanes"), { checked: c.panels.lanes, shortcut: { key: "3", alt: true } }),
    cmd("view.labels", "Part labels", () => a.setShowLabels(!c.showLabels), { checked: c.showLabels, enabled: c.ready }),
    cmd("view.labelSections", "Label by section", () => a.setLabelMode("sections"), { checked: c.labelMode === "sections", enabled: c.ready && c.showLabels }),
    cmd("view.labelParts", "Label every part", () => a.setLabelMode("parts"), { checked: c.labelMode === "parts", enabled: c.ready && c.showLabels }),
    cmd("view.seating", "Seating guide", () => a.setShowSeating(!c.showSeating), { checked: c.showSeating }),
    cmd("view.legend", "Dynamics legend", () => a.setShowLegend(!c.showLegend), { checked: c.showLegend }),
    cmd("view.lock", "Lock layout", () => a.setLocked(!c.locked), { checked: c.locked, shortcut: { key: "l" } }),
    cmd("view.fullscreen", "Full screen stage", a.fullscreen, { shortcut: { key: "f" } }),
    cmd("view.themeLight", "Light", () => a.setTheme("program"), { checked: c.theme === "program" }),
    cmd("view.themeDark", "Dark", () => a.setTheme("stage"), { checked: c.theme === "stage" }),
    cmd("view.reducedMotion", "Reduced motion", () => a.setReducedMotion(!c.reducedMotion), { checked: c.reducedMotion, enabled: c.ready }),

    cmd("play.toggle", c.playing ? "Pause" : "Play", a.togglePlay, { shortcut: { key: " " }, shortcutElsewhere: true }),
    cmd("play.start", "Go to start", () => a.seek(0), { shortcut: { key: "Home" }, shortcutElsewhere: true }),
    cmd("play.back", "Back 5 seconds", () => a.skip(-5), { shortcut: { key: "ArrowLeft" }, shortcutElsewhere: true }),
    cmd("play.forward", "Forward 5 seconds", () => a.skip(5), { shortcut: { key: "ArrowRight" }, shortcutElsewhere: true }),
    cmd("play.goto", "Go to bar…", () => a.openDialog("goto"), { shortcut: { key: "g", mod: true }, enabled: c.ready }),
    cmd("play.loop", "Loop", a.toggleLoop, { checked: c.loop }),
    cmd("play.rate1", "1×", () => a.setRate(1), { checked: c.rate === 1 }),
    cmd("play.rate075", "0.75×", () => a.setRate(0.75), { checked: c.rate === 0.75 }),
    cmd("play.rate05", "0.5×", () => a.setRate(0.5), { checked: c.rate === 0.5 }),
    cmd("play.mute", "Mute", a.toggleMute, { checked: c.muted, shortcut: { key: "m" }, shortcutElsewhere: true }),

    cmd("parts.toggleVisible", c.selectedVisible || !sel ? "Hide selected part" : "Show selected part", () => sel && a.setVisible(sel, !c.selectedVisible), {
      shortcut: { key: "h" },
      enabled: sel !== null,
    }),
    cmd("parts.solo", sel && c.soloed === sel ? "Show all parts" : "Solo selected part", () => sel && a.solo(sel), {
      shortcut: { key: "s" },
      enabled: sel !== null,
    }),
    cmd("parts.showAll", "Show all parts", a.showAll, { enabled: c.ready && !c.allVisible }),
    cmd("parts.useSectionColor", "Use section color", () => sel && a.clearPartColor(sel), { enabled: sel !== null && c.selectedHasColor }),

    cmd("help.shortcuts", "Keyboard shortcuts", () => a.openDialog("shortcuts"), { shortcut: { key: "?", shift: true } }),
    cmd("help.about", "How the display works", () => a.openDialog("about")),
    cmd("nav.preview", "Continue to Preview", a.continueToPreview, { enabled: c.ready }),
  ];
  return Object.fromEntries(list.map((x) => [x.id, x])) as Commands;
}

/* ------------------------------------------------------------------ */
/* Shortcuts                                                            */
/* ------------------------------------------------------------------ */

const KEY_NAMES: Record<string, string> = {
  " ": "Space",
  arrowleft: "←",
  arrowright: "→",
  arrowup: "↑",
  arrowdown: "↓",
  escape: "Esc",
  home: "Home",
};

export function isMacPlatform(): boolean {
  if (typeof navigator === "undefined") return true;
  const platform = (navigator as Navigator & { userAgentData?: { platform?: string } }).userAgentData?.platform ?? navigator.platform ?? "";
  return /mac|iphone|ipad/i.test(platform);
}

/** "⇧⌘Z" on macOS, "Ctrl+Shift+Z" elsewhere. */
export function formatShortcut(s: Shortcut, mac = isMacPlatform()): string {
  const k = s.key.toLowerCase();
  const key = KEY_NAMES[k] ?? (s.key.length === 1 ? s.key.toUpperCase() : s.key);
  // "?" already implies Shift
  const shift = s.shift && s.key !== "?";
  if (mac) return `${s.alt ? "⌥" : ""}${shift ? "⇧" : ""}${s.mod ? "⌘" : ""}${key}`;
  return [s.mod && "Ctrl", s.alt && "Alt", shift && "Shift", key].filter(Boolean).join("+");
}

/** Does this keydown match the shortcut? Letters and digits also match by `code`, so ⌥1 works on macOS. */
export function matchesShortcut(e: Pick<KeyboardEvent, "key" | "code" | "metaKey" | "ctrlKey" | "shiftKey" | "altKey">, s: Shortcut, mac = isMacPlatform()): boolean {
  const mod = mac ? e.metaKey : e.ctrlKey;
  if (Boolean(s.mod) !== mod) return false;
  if (Boolean(s.alt) !== e.altKey) return false;
  if (Boolean(s.shift) !== e.shiftKey) return false;
  // the other platform's modifier must not be held (Ctrl+S on macOS is not Save)
  if (mac ? e.ctrlKey : e.metaKey) return false;
  const want = s.key.toLowerCase();
  if (e.key.toLowerCase() === want) return true;
  const code = e.code.startsWith("Key") ? e.code.slice(3).toLowerCase() : e.code.startsWith("Digit") ? e.code.slice(5) : null;
  return code === want;
}

/** Keyboard nudge step as a fraction of the stage (Shift = bigger). */
export const NUDGE_STEP = { x: 0.01, y: 0.015, bigFactor: 5 };

/** Clamp the same way Stage clamps a drag. */
export function clampPosition(p: { x: number; y: number }): { x: number; y: number } {
  return { x: Math.min(0.97, Math.max(0.03, p.x)), y: Math.min(0.9, Math.max(0.05, p.y)) };
}
