"use client";

import { create } from "zustand";
import type { ManualMarker } from "@/shared/sync";

/** A note: playback bar (1-based) and the fraction of the bar in score time. */
export interface Spot {
  measure: number;
  position: number;
}

export interface UndoSlot {
  /** "Marker added on bar 12" */
  label: string;
  /** the manual list before the command (Undo restores it exactly; ADR 0018) */
  manual: ManualMarker[];
}

export type MeasureSort = "order" | "confidence";
export type BandFilter = "high" | "mid" | "low";

/**
 * Sync page UI state that is not saved with the project: the selected note
 * (also the start point), the open marker details, the note menu, the single
 * undo slot, and list and roll view options. Reset when the project changes.
 */
interface SyncUiState {
  projectId: string | null;
  selected: Spot | null;
  /** the marker whose details are open, and what to anchor them to */
  popover: { id: string; anchor: { getBoundingClientRect: () => DOMRect } } | null;
  /** the note menu (right-click / Shift+F10) */
  menu: { spot: Spot; x: number; y: number } | null;
  undo: UndoSlot | null;
  /** one polite announcement at a time */
  announcement: { text: string; seq: number };
  measureSort: MeasureSort;
  bands: Set<BandFilter>;
  barFrom: number | null;
  barTo: number | null;
  /** sections hidden in the piano roll (part filter) */
  hiddenSections: Set<string>;
  hiddenParts: Set<string>;
  /** show only parts that are visible in Customize */
  onlyVisible: boolean;
  /** the roll follows the playhead */
  follow: boolean;
  /** sync form: bars to re-sync; null = follow the pending default */
  syncFrom: string;
  syncTo: string;
  reset: (projectId: string) => void;
  select: (spot: Spot | null) => void;
  openPopover: (id: string, anchor: { getBoundingClientRect: () => DOMRect }) => void;
  closePopover: () => void;
  openMenu: (spot: Spot, x: number, y: number) => void;
  closeMenu: () => void;
  setUndo: (slot: UndoSlot | null) => void;
  announce: (text: string) => void;
  set: (patch: Partial<Pick<SyncUiState, "measureSort" | "bands" | "barFrom" | "barTo" | "hiddenSections" | "hiddenParts" | "onlyVisible" | "follow" | "syncFrom" | "syncTo">>) => void;
}

const fresh = () => ({
  selected: null,
  popover: null,
  menu: null,
  undo: null,
  measureSort: "order" as MeasureSort,
  bands: new Set<BandFilter>(),
  barFrom: null,
  barTo: null,
  hiddenSections: new Set<string>(),
  hiddenParts: new Set<string>(),
  onlyVisible: false,
  follow: true,
  syncFrom: "",
  syncTo: "",
});

export const useSyncUi = create<SyncUiState>((set, get) => ({
  projectId: null,
  announcement: { text: "", seq: 0 },
  ...fresh(),
  reset: (projectId) => {
    if (get().projectId === projectId) return;
    set({ projectId, ...fresh() });
  },
  select: (selected) => set({ selected }),
  openPopover: (id, anchor) => set({ popover: { id, anchor }, menu: null }),
  closePopover: () => set({ popover: null }),
  openMenu: (spot, x, y) => set({ menu: { spot, x, y }, popover: null }),
  closeMenu: () => set({ menu: null }),
  setUndo: (undo) => set({ undo }),
  announce: (text) => set((s) => ({ announcement: { text, seq: s.announcement.seq + 1 } })),
  set: (patch) => set(patch),
}));
