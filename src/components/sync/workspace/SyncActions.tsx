"use client";

import { createContext, useContext } from "react";
import type { Spot } from "@/lib/store/sync-ui";

/** What the workspace does on behalf of its panes. */
export interface SyncActions {
  /** run a recompute over local ranges, or the whole piece (null) */
  recompute: (ranges: Array<{ from: number; to: number }> | null) => void;
  /** a run is in progress: marker editing is locked */
  running: boolean;
  /** select a note (it becomes the start point) and seek to it */
  jumpTo: (spot: Spot) => void;
  /** select a note without moving playback */
  select: (spot: Spot) => void;
  /** recording length, seconds */
  durationSec: number;
}

export const SyncActionsContext = createContext<SyncActions | null>(null);

export function useSyncActions(): SyncActions {
  const v = useContext(SyncActionsContext);
  if (!v) throw new Error("useSyncActions outside SyncWorkspace");
  return v;
}

export const RUN_LOCK_REASON = "Markers can't be edited while a sync is running.";
