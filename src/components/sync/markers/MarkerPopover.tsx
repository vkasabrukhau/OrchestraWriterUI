"use client";

import { useMemo } from "react";
import { Popover } from "radix-ui";
import { X } from "lucide-react";
import type { InfoMap } from "@/shared/info-map";
import { appliedOf } from "@/shared/sync";
import { useProject } from "@/lib/store/project";
import { useSyncUi } from "@/lib/store/sync-ui";
import { formatTime } from "@/lib/utils/format";
import { Button } from "@/components/ui/Button";
import { MarkerDetails } from "./MarkerDetails";
import { markerTitle } from "./markerName";
import { useMarkerCommands } from "./useMarkerCommands";

/**
 * The one marker details popover, anchored to the pressed icon (a DOM button,
 * or a rectangle on the piano roll's canvas). Non-modal: Esc or clicking
 * outside closes it, and focus returns to what opened it.
 */
export function MarkerPopover({ infoMap }: { infoMap: InfoMap }) {
  const popover = useSyncUi((s) => s.popover);
  const close = useSyncUi((s) => s.closePopover);
  const sync = useProject((s) => s.sync);
  const cmd = useMarkerCommands();
  const virtualRef = useMemo(() => ({ current: popover?.anchor ?? { getBoundingClientRect: () => new DOMRect() } }), [popover]);
  if (!popover || !sync) return null;
  const marker = sync.manual.find((m) => m.id === popover.id);
  const deleted = marker ? null : appliedOf(sync).find((m) => m.id === popover.id);

  return (
    <Popover.Root
      open
      onOpenChange={(open) => {
        if (!open) close();
      }}
    >
      <Popover.Anchor virtualRef={virtualRef} />
      <Popover.Portal>
        <Popover.Content
          side="bottom"
          align="start"
          sideOffset={8}
          collisionPadding={12}
          className="card z-50 p-3 shadow-[var(--shadow-pop,0_8px_28px_rgba(0,0,0,0.18))]"
          onCloseAutoFocus={(e) => {
            const el = popover.anchor as unknown as HTMLElement;
            if (typeof el.focus === "function") {
              e.preventDefault();
              el.focus();
            }
          }}
        >
          <div className="mb-2 flex items-center justify-between gap-2">
            <p className="font-medium text-ink">{marker ? markerTitle(infoMap, marker) : deleted ? markerTitle(infoMap, deleted) : "Marker"}</p>
            <Popover.Close asChild>
              <Button variant="ghost" size="icon-sm" aria-label="Close marker details">
                <X size={14} />
              </Button>
            </Popover.Close>
          </div>
          {marker ? (
            <MarkerDetails infoMap={infoMap} marker={marker} onClose={close} />
          ) : deleted ? (
            <div className="w-[300px] space-y-2 text-[13px]">
              <p className="text-ink-2">
                Deleted: recompute to apply. Playback still uses it at {formatTime(deleted.startSec, true)} until then.
              </p>
              <Button
                variant="outline"
                size="sm"
                onClick={() => {
                  cmd.revert(deleted.id);
                  close();
                }}
              >
                Revert (keep the marker)
              </Button>
            </div>
          ) : (
            <p className="text-[13px] text-ink-3">This marker no longer exists.</p>
          )}
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}
