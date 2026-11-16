"use client";

import { Popover } from "radix-ui";
import { CircleHelp } from "lucide-react";

/** How to sync, on demand (owner: a help button in a corner instead of hint text). */
export function SyncHelp() {
  return (
    <Popover.Root>
      <Popover.Trigger asChild>
        <button type="button" className="rounded p-1 text-ink-3 hover:bg-paper-3 hover:text-ink" aria-label="How to sync">
          <CircleHelp size={15} />
        </button>
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Content className="card z-50 w-80 space-y-2 p-3 text-[12.5px] leading-relaxed text-ink-2" sideOffset={6} align="end" collisionPadding={12}>
          <p className="font-medium text-ink">How to sync</p>
          <ol className="list-decimal space-y-1 pl-4">
            <li>Check the confidence map: red and amber bars are the ones to listen to. &ldquo;Next uncertain&rdquo; jumps to them.</li>
            <li>Click a note in the score to select it (it becomes the start point); double-click plays from it. Shift-click a second note repeats the passage.</li>
            <li>Right-click a note and choose &ldquo;Add marker&rdquo;, or drag its handle in the piano roll to where you hear it.</li>
            <li>Markers are pending (dashed) until you recompute: nothing you hear changes yet.</li>
            <li>Recompute the suggested bars, or pick bars in the Sync section and run a sync. Timing and confidence then update together.</li>
          </ol>
          <p className="text-ink-3">
            Keys: ← → step through notes in the score or the roll · A add a marker · [ ] nudge it · P set it to the playhead · R go to Recompute · ⌘/Ctrl Z undo · ⌘/Ctrl \ sidebar · Space play.
          </p>
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}
