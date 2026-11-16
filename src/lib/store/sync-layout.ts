"use client";

import { create } from "zustand";

/**
 * The Sync workspace layout, remembered per browser (localStorage; ADR 0017).
 * Written only on user changes; size changes the window forces (a short
 * window, a narrow one) are never stored.
 */
export type SyncPaneId = "confidence" | "score" | "joint";
export type SidebarSectionId = "measures" | "markers" | "sync";

export interface SyncLayout {
  /** shares of the left column's height (they sum to 1 over expanded panes) */
  sizes: Record<SyncPaneId, number>;
  collapsed: SyncPaneId[];
  sidebarOpen: boolean;
  sidebarWidth: number;
  open: SidebarSectionId[];
  /** single-key shortcuts (A, N, P, R, [ ]) */
  singleKeys: boolean;
}

export const DEFAULT_SYNC_LAYOUT: SyncLayout = {
  sizes: { confidence: 0.12, score: 0.42, joint: 0.46 },
  collapsed: [],
  sidebarOpen: true,
  sidebarWidth: 320,
  open: ["measures", "markers", "sync"],
  singleKeys: true,
};

const KEY = "ov:sync-layout:v1";
const PANES: SyncPaneId[] = ["confidence", "score", "joint"];
const SECTIONS: SidebarSectionId[] = ["measures", "markers", "sync"];

/** A stored layout, or the defaults when it is missing, unreadable or blocked. */
export function readSyncLayout(): SyncLayout {
  try {
    const raw = typeof window === "undefined" ? null : window.localStorage.getItem(KEY);
    if (!raw) return DEFAULT_SYNC_LAYOUT;
    const v = JSON.parse(raw) as Partial<SyncLayout>;
    const sizes = { ...DEFAULT_SYNC_LAYOUT.sizes };
    for (const p of PANES) {
      const n = v.sizes?.[p];
      if (typeof n === "number" && n > 0.02 && n < 1) sizes[p] = n;
    }
    return {
      sizes,
      collapsed: Array.isArray(v.collapsed) ? v.collapsed.filter((p): p is SyncPaneId => PANES.includes(p as SyncPaneId)).slice(0, 2) : [],
      sidebarOpen: typeof v.sidebarOpen === "boolean" ? v.sidebarOpen : true,
      sidebarWidth: typeof v.sidebarWidth === "number" ? Math.max(280, Math.min(520, v.sidebarWidth)) : 320,
      open: Array.isArray(v.open) ? v.open.filter((p): p is SidebarSectionId => SECTIONS.includes(p as SidebarSectionId)) : DEFAULT_SYNC_LAYOUT.open,
      singleKeys: typeof v.singleKeys === "boolean" ? v.singleKeys : true,
    };
  } catch {
    return DEFAULT_SYNC_LAYOUT;
  }
}

function write(layout: SyncLayout) {
  try {
    window.localStorage.setItem(KEY, JSON.stringify(layout));
  } catch {
    // storage blocked or full: the layout just isn't remembered
  }
}

interface SyncLayoutState extends SyncLayout {
  loaded: boolean;
  load: () => void;
  /** a user change: applied and remembered */
  update: (patch: Partial<SyncLayout>) => void;
}

export const useSyncLayout = create<SyncLayoutState>((set, get) => ({
  ...DEFAULT_SYNC_LAYOUT,
  loaded: false,
  load: () => {
    if (get().loaded) return;
    set({ ...readSyncLayout(), loaded: true });
  },
  update: (patch) => {
    set(patch);
    const { sizes, collapsed, sidebarOpen, sidebarWidth, open, singleKeys } = get();
    write({ sizes, collapsed, sidebarOpen, sidebarWidth, open, singleKeys });
  },
}));
