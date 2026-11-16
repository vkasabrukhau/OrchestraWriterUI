"use client";

import { create } from "zustand";
import type { EditorPanel } from "./editor";

/**
 * Sizes of the Customize editor's docked panels, in px, remembered per
 * browser (localStorage), like the Sync layout. View state only: never part
 * of the project. Written on user changes only; when the window is too small
 * for the stored sizes, `fitPanels` shrinks what is shown without storing it.
 */
export type EditorPanelSizes = Record<EditorPanel, number>;

export const DEFAULT_PANEL_SIZES: EditorPanelSizes = { instruments: 244, properties: 300, lanes: 260 };

/** [min, max] per panel, px */
export const PANEL_LIMITS: Record<EditorPanel, readonly [number, number]> = {
  instruments: [200, 440],
  properties: [260, 480],
  lanes: [120, 640],
};

/** the stage column never gets narrower than this when side panels grow */
export const STAGE_MIN_WIDTH = 420;
/** the stage area (header, stage, transport) never gets shorter than this when the lanes grow */
export const STAGE_MIN_HEIGHT = 340;

const KEY = "ov:editor-layout:v1";
const PANELS: EditorPanel[] = ["instruments", "properties", "lanes"];

const clamp = (v: number, [min, max]: readonly [number, number]) => Math.round(Math.max(min, Math.min(max, v)));

/** Stored sizes, or the defaults when they are missing, unreadable or blocked. */
export function readPanelSizes(): EditorPanelSizes {
  try {
    const raw = typeof window === "undefined" ? null : window.localStorage.getItem(KEY);
    if (!raw) return DEFAULT_PANEL_SIZES;
    const v = JSON.parse(raw) as Partial<Record<EditorPanel, unknown>>;
    const sizes = { ...DEFAULT_PANEL_SIZES };
    for (const p of PANELS) {
      const n = v[p];
      if (typeof n === "number" && Number.isFinite(n)) sizes[p] = clamp(n, PANEL_LIMITS[p]);
    }
    return sizes;
  } catch {
    return DEFAULT_PANEL_SIZES;
  }
}

export interface FittedPanels {
  /** sizes to draw */
  size: EditorPanelSizes;
  /** the largest each panel can be dragged to right now */
  max: EditorPanelSizes;
}

/**
 * Fits the stored sizes into the editor's grid (`width` × `height`, 0 when not
 * measured yet). Side panels give up width, properties first, so the stage
 * column keeps `STAGE_MIN_WIDTH`; the lanes give up height so the stage area
 * keeps `STAGE_MIN_HEIGHT`. No panel goes below its minimum.
 */
export function fitPanels(stored: EditorPanelSizes, box: { width: number; height: number }, shown: Record<EditorPanel, boolean>): FittedPanels {
  let instruments = clamp(stored.instruments, PANEL_LIMITS.instruments);
  let properties = clamp(stored.properties, PANEL_LIMITS.properties);
  const [iMin] = PANEL_LIMITS.instruments;
  const [pMin] = PANEL_LIMITS.properties;

  if (box.width > 0) {
    let over = (shown.instruments ? instruments : 0) + (shown.properties ? properties : 0) - (box.width - STAGE_MIN_WIDTH);
    if (over > 0 && shown.properties) {
      const d = Math.min(over, properties - pMin);
      properties -= d;
      over -= d;
    }
    if (over > 0 && shown.instruments) instruments -= Math.min(over, instruments - iMin);
  }

  const max: EditorPanelSizes = {
    instruments: box.width > 0 ? clamp(box.width - STAGE_MIN_WIDTH - (shown.properties ? properties : 0), PANEL_LIMITS.instruments) : PANEL_LIMITS.instruments[1],
    properties: box.width > 0 ? clamp(box.width - STAGE_MIN_WIDTH - (shown.instruments ? instruments : 0), PANEL_LIMITS.properties) : PANEL_LIMITS.properties[1],
    lanes: box.height > 0 ? clamp(box.height - STAGE_MIN_HEIGHT, PANEL_LIMITS.lanes) : PANEL_LIMITS.lanes[1],
  };
  const lanes = Math.min(clamp(stored.lanes, PANEL_LIMITS.lanes), max.lanes);
  return { size: { instruments, properties, lanes }, max };
}

interface EditorLayoutState {
  sizes: EditorPanelSizes;
  loaded: boolean;
  load: () => void;
  /** a user change: applied and remembered */
  resize: (panel: EditorPanel, px: number) => void;
  /** back to the default size (double-click on a border) */
  reset: (panel: EditorPanel) => void;
}

function write(sizes: EditorPanelSizes) {
  try {
    window.localStorage.setItem(KEY, JSON.stringify(sizes));
  } catch {
    // storage blocked or full: the sizes just aren't remembered
  }
}

export const useEditorLayout = create<EditorLayoutState>((set, get) => ({
  sizes: DEFAULT_PANEL_SIZES,
  loaded: false,
  load: () => {
    if (get().loaded) return;
    set({ sizes: readPanelSizes(), loaded: true });
  },
  resize: (panel, px) => {
    const sizes = { ...get().sizes, [panel]: clamp(px, PANEL_LIMITS[panel]) };
    set({ sizes });
    write(sizes);
  },
  reset: (panel) => get().resize(panel, DEFAULT_PANEL_SIZES[panel]),
}));
