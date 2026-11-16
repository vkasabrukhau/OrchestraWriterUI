"use client";

import { useCallback } from "react";
import { useProject, type MarkerEditResult } from "@/lib/store/project";
import { useSyncUi } from "@/lib/store/sync-ui";
import { toast } from "@/components/ui/toast";
import type { ManualMarker } from "@/shared/sync";

/** Undo toasts stay up long enough to reach by keyboard (Cmd/Ctrl+Z also works). */
export const UNDO_TOAST_MS = 10_000;
const UNDO_TOAST_ID = "sync-marker-undo";

/**
 * Marker commands for the Sync page (ADR 0018). Every command edits `manual`
 * only (nothing audible changes until a recompute), keeps a single undo slot
 * holding the manual list from before, shows an Undo toast and announces the
 * result. Failed commands (out of order, occupied) announce why and change nothing.
 */
export function useMarkerCommands() {
  const run = useCallback((label: string, fn: () => MarkerEditResult | ManualMarker | null | void): MarkerEditResult | null => {
    const before = useProject.getState().sync?.manual ?? [];
    const ui = useSyncUi.getState();
    const out = fn();
    if (out && "ok" in out && !out.ok) {
      ui.announce(out.message);
      return out;
    }
    if (out === null) return null;
    ui.setUndo({ label, manual: before });
    ui.announce(`${label}. Recompute to apply.`);
    toast.success(label, {
      id: UNDO_TOAST_ID,
      description: "Pending: recompute to apply.",
      duration: UNDO_TOAST_MS,
      action: { label: "Undo", onClick: () => undo() },
    });
    return out && "ok" in out ? out : { ok: true, id: "" };
  }, []);

  return {
    add: (measure: number, startSec: number, position = 0, what = "Marker added") => run(what, () => useProject.getState().addMarker(measure, startSec, position)),
    update: (id: string, patch: Parameters<ReturnType<typeof useProject.getState>["updateMarker"]>[1], what = "Marker moved") => run(what, () => useProject.getState().updateMarker(id, patch)),
    rename: (id: string, label: string) => run("Marker renamed", () => useProject.getState().updateMarker(id, { label })),
    remove: (id: string) => run("Marker deleted", () => useProject.getState().removeMarkerById(id)),
    revert: (id: string) => run("Change reverted", () => useProject.getState().revertMarker(id)),
    undo,
  };
}

/** Restore the manual list from before the last marker command (Cmd/Ctrl+Z, the toast's Undo). */
export function undo(): boolean {
  const ui = useSyncUi.getState();
  const slot = ui.undo;
  if (!slot) return false;
  useProject.getState().restoreManual(slot.manual);
  ui.setUndo(null);
  toast.dismiss(UNDO_TOAST_ID);
  ui.announce(`Undone: ${slot.label.toLowerCase()}.`);
  return true;
}

/** A run cannot be undone from the marker slot: clear it (ADR 0018). */
export function clearUndo() {
  useSyncUi.getState().setUndo(null);
  toast.dismiss(UNDO_TOAST_ID);
}
