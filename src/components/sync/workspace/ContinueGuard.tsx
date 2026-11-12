"use client";

import { useState } from "react";
import { ArrowRight } from "lucide-react";
import type { AlignJobInput } from "@/shared/jobs";
import { appliedOf, pendingOf } from "@/shared/sync";
import { useProject } from "@/lib/store/project";
import { Button } from "@/components/ui/Button";
import { Dialog } from "@/components/ui/Dialog";
import { barsText, pendingRanges } from "../markers/markerName";

/**
 * Continue to Customize. With markers still pending it asks first: they are
 * not in playback, Preview or the video until a recompute applies them.
 * Nothing is applied without the user choosing it.
 */
export function ContinueGuard({ onContinue, onRecompute, running }: { onContinue: () => void; onRecompute: (inputs: AlignJobInput[]) => void; running: boolean }) {
  const [open, setOpen] = useState(false);
  const sync = useProject((s) => s.sync);
  const count = useProject((s) => s.infoMap?.measures.length ?? 0);
  const pending = sync ? pendingOf(sync.manual, appliedOf(sync)) : [];
  const ranges = pendingRanges(pending, count);
  return (
    <>
      <Button size="sm" onClick={() => (pending.length > 0 ? setOpen(true) : onContinue())} trailing={<ArrowRight size={14} />}>
        Continue to Customize
      </Button>
      <Dialog
        open={open}
        onClose={() => setOpen(false)}
        width="sm"
        title={`${pending.length} marker${pending.length === 1 ? " isn't" : "s aren't"} applied yet`}
        description={`They won't be in playback, Preview or the video until you recompute ${ranges.map(barsText).join(", ")}.`}
        footer={
          <>
            <Button variant="ghost" size="sm" onClick={() => (setOpen(false), onContinue())}>
              Continue without them
            </Button>
            <Button
              size="sm"
              disabled={running}
              onClick={() => {
                setOpen(false);
                onRecompute(ranges.map((range) => ({ range })));
              }}
            >
              Recompute now
            </Button>
          </>
        }
      >
        <p className="text-[13px] text-ink-3">Recomputing takes a few seconds. You can continue once it finishes.</p>
      </Dialog>
    </>
  );
}
