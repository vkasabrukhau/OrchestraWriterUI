"use client";

import { create } from "zustand";
import type { Dynamic } from "@/shared/dynamics";

/**
 * View state of the editor pages (Customize today). Nothing here is part of
 * the project: it is never saved to the server or the project file, and it
 * resets when another project opens.
 */

export type EditorPanel = "instruments" | "properties" | "lanes";
export type PartFilter = "all" | "playing" | "hidden";
export type EditorDialog = "rename" | "shortcuts" | "about" | "goto" | null;

interface EditorState {
  /** the project this state belongs to */
  projectId: string | null;
  selectedId: string | null;
  panels: Record<EditorPanel, boolean>;
  /** select only, no dragging on the stage */
  locked: boolean;
  showSeating: boolean;
  showLegend: boolean;
  search: string;
  filter: PartFilter;
  dialog: EditorDialog;
  /** bumps when "Find instrument" runs so the search box can focus itself */
  searchFocus: number;
  /** bumps when "Full screen" runs; the stage area owns the element */
  fullscreen: number;
  /** forget everything when the editor opens another project */
  bind: (projectId: string) => void;
  select: (id: string | null) => void;
  togglePanel: (panel: EditorPanel) => void;
  setLocked: (v: boolean) => void;
  setShowSeating: (v: boolean) => void;
  setShowLegend: (v: boolean) => void;
  setSearch: (v: string) => void;
  setFilter: (v: PartFilter) => void;
  openDialog: (d: EditorDialog) => void;
  focusSearch: () => void;
  requestFullscreen: () => void;
}

const initial = {
  selectedId: null,
  panels: { instruments: true, properties: true, lanes: true },
  locked: false,
  showSeating: true,
  showLegend: true,
  search: "",
  filter: "all" as PartFilter,
  dialog: null as EditorDialog,
  searchFocus: 0,
  fullscreen: 0,
};

export const useEditor = create<EditorState>((set, get) => ({
  projectId: null,
  ...initial,
  bind: (projectId) => {
    if (get().projectId === projectId) return;
    set({ projectId, ...initial, panels: get().panels });
  },
  select: (selectedId) => set({ selectedId }),
  togglePanel: (panel) => set((s) => ({ panels: { ...s.panels, [panel]: !s.panels[panel] } })),
  setLocked: (locked) => set({ locked }),
  setShowSeating: (showSeating) => set({ showSeating }),
  setShowLegend: (showLegend) => set({ showLegend }),
  setSearch: (search) => set({ search }),
  setFilter: (filter) => set({ filter }),
  openDialog: (dialog) => set({ dialog }),
  focusSearch: () => set((s) => ({ searchFocus: s.searchFocus + 1, panels: { ...s.panels, instruments: true } })),
  requestFullscreen: () => set((s) => ({ fullscreen: s.fullscreen + 1 })),
}));

/**
 * Which parts are sounding now and at which written dynamic (id → dynamic,
 * null while resting). Written ~10×/s from the Stage's frame callback and read
 * only by the parts list, so the rest of the editor does not re-render.
 */
export const usePartActivity = create<{ activity: Record<string, Dynamic | null>; key: string; set: (parts: Array<{ id: string; playing: boolean; dynamic: Dynamic }>) => void }>((set, get) => ({
  activity: {},
  key: "",
  set: (parts) => {
    const key = parts.map((p) => (p.playing ? p.dynamic : "-")).join(",");
    if (key === get().key) return;
    const activity: Record<string, Dynamic | null> = {};
    for (const p of parts) activity[p.id] = p.playing ? p.dynamic : null;
    set({ activity, key });
  },
}));
