"use client";

/**
 * EXPERIMENT: choose the aligner (Smooth = integrated tempo, Redline = the
 * redline port) when a sync starts. While on, the first visit to Sync waits
 * for "Start sync" instead of aligning automatically.
 *
 * To hide it: set REDLINE_EXPERIMENT to false (auto-start comes back).
 * To remove it: delete this folder and the REDLINE_EXPERIMENT lines in
 * SyncPage.tsx (and its mock in SyncPage.test.tsx); optionally drop the
 * "redline" entries in src/lib/align/methods.ts, select.ts, src/shared/jobs.ts
 * and src/lib/align/redline/.
 */
import { create } from "zustand";
import { Segmented } from "@/components/ui/Segmented";
import { methodLabel } from "@/lib/align/methods";

export const REDLINE_EXPERIMENT = true;

export type AlignerStyle = "smooth" | "redline";

const useAlignerChoice = create<{
  style: AlignerStyle;
  set: (style: AlignerStyle) => void;
}>((set) => ({
  style: "smooth",
  set: (style) => set({ style }),
}));

/** The style the next sync run should use. */
export function chosenAlignerStyle(): AlignerStyle {
  return useAlignerChoice.getState().style;
}

export function AlignerChoice({ currentMethod }: { currentMethod?: string }) {
  const style = useAlignerChoice((s) => s.style);
  const set = useAlignerChoice((s) => s.set);
  return (
    <div className="flex flex-wrap items-center gap-2 text-[11px] text-ink-3" data-testid="aligner-choice">
      <span>Aligner</span>
      <Segmented<AlignerStyle>
        size="sm"
        ariaLabel="Aligner for the next sync"
        value={style}
        onChange={set}
        options={[
          { value: "smooth", label: "Smooth (current)" },
          { value: "redline", label: "Redline" },
        ]}
      />
      {currentMethod && <span>Timing now from: {methodLabel(currentMethod)}</span>}
    </div>
  );
}
