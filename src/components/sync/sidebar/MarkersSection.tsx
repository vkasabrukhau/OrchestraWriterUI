"use client";

import { useState } from "react";
import { Plus, RotateCcw, Trash2 } from "lucide-react";
import type { InfoMap } from "@/shared/info-map";
import { markerPosition, sameMarkerSpot } from "@/shared/sync";
import { useProject } from "@/lib/store/project";
import { useSyncUi } from "@/lib/store/sync-ui";
import { useProjectTiming } from "@/lib/store/useProjectTiming";
import { cx, formatTime } from "@/lib/utils/format";
import { Button } from "@/components/ui/Button";
import { spotText } from "@/components/music/bars";
import { MarkerDetails } from "../markers/MarkerDetails";
import { MarkerIcon } from "../markers/MarkerIcon";
import { markerAccessibleName, markerTitle } from "../markers/markerName";
import { useDisplayedMarkers } from "../markers/useDisplayedMarkers";
import { useMarkerCommands } from "../markers/useMarkerCommands";
import { RUN_LOCK_REASON, useSyncActions } from "../workspace/SyncActions";
import { SidebarSection } from "./SidebarSection";

/**
 * Markers in recording order. Click one to see and edit it below the list:
 * rename, delete, jump to, edit its time and its note. Pending ones are
 * badged; a pending deletion stays listed (crossed out) until a recompute.
 */
export function MarkersSection({ infoMap }: { infoMap: InfoMap }) {
  const sync = useProject((s) => s.sync);
  const selected = useSyncUi((s) => s.selected);
  const { list, pending } = useDisplayedMarkers();
  const cmd = useMarkerCommands();
  const { toTransport } = useProjectTiming();
  const { running, jumpTo } = useSyncActions();
  const [openId, setOpenId] = useState<string | null>(null);
  const open = sync?.manual.find((m) => m.id === openId) ?? null;
  const selMarker = selected && sync ? sync.manual.find((m) => sameMarkerSpot(m, selected.measure, selected.position)) : undefined;

  const addAtSelection = () => {
    if (!selected) return useSyncUi.getState().announce("Select a note first.");
    const m = infoMap.measures[selected.measure - 1];
    if (!m) return;
    const r = cmd.add(selected.measure, toTransport(m.startTime + selected.position * m.duration), selected.position);
    if (r?.ok) setOpenId(r.id);
  };
  const unhonoured = list.filter((d) => d.unhonoured).length;

  return (
    <SidebarSection id="markers" title="Markers" summary={`${sync?.manual.length ?? 0}${pending.length ? ` · ${pending.length} pending` : ""}`}>
      <div className="mb-2 flex items-center justify-between gap-2 text-[12px]">
        <span className="text-ink-3">
          Selected: <span className="text-ink">{selected ? spotText(infoMap, selected.measure, selected.position, true) : "none"}</span>
        </span>
        {selMarker ? (
          <Button size="sm" variant="outline" onClick={() => setOpenId(selMarker.id)}>
            Edit marker
          </Button>
        ) : (
          <Button size="sm" variant="outline" leading={<Plus size={12} />} onClick={addAtSelection} disabled={running || !selected} title={running ? RUN_LOCK_REASON : "Add a marker on the selected note (A)"}>
            Add marker
          </Button>
        )}
      </div>
      {unhonoured > 0 && (
        <p className="mb-2 rounded bg-paper-2 px-2 py-1 text-[12px] text-danger">
          {unhonoured} marker{unhonoured === 1 ? " is" : "s are"} too close to a neighbour to keep exactly. Move one of them.
        </p>
      )}
      {list.length === 0 ? (
        <p className="text-[12px] leading-relaxed text-ink-3">No markers yet. Right-click a note in the score, or drag a note&apos;s handle in the roll to where you hear it. Markers apply when you recompute.</p>
      ) : (
        <ul className="scroll-thin max-h-56 overflow-y-auto" aria-label="Markers">
          {list.map((d) => {
            const m = d.marker;
            const isOpen = openId === m.id && d.state !== "deleted";
            return (
              <li key={`${m.id}:${d.state}`} className={cx("flex items-center gap-1.5 rounded px-1.5 py-1 text-[12px]", isOpen && "bg-brass-soft", d.state === "deleted" && "text-ink-3")}>
                <MarkerIcon id={m.id} state={d.state} name={markerAccessibleName(infoMap, m, d.state)} onPress={(el) => useSyncUi.getState().openPopover(m.id, el)} />
                <button
                  type="button"
                  className={cx("min-w-0 flex-1 truncate text-left", d.state === "deleted" && "line-through")}
                  onClick={() => {
                    if (d.state === "deleted") return;
                    setOpenId(isOpen ? null : m.id);
                    useSyncUi.getState().select({ measure: m.measure, position: markerPosition(m) });
                  }}
                  aria-expanded={d.state === "deleted" ? undefined : isOpen}
                >
                  {markerTitle(infoMap, m)} <span className="tnum text-ink-3">· {formatTime(m.startSec, true)}</span>
                </button>
                {d.state === "pending" && <span className="rounded bg-paper-3 px-1 text-[10px] text-brass-3">pending</span>}
                {d.state === "deleted" && <span className="text-[10px]">Deleted: recompute to apply</span>}
                {d.unhonoured && <span className="rounded bg-paper-3 px-1 text-[10px] text-danger">not kept exactly</span>}
                {d.state === "deleted" ? (
                  <button type="button" className="text-ink-3 hover:text-ink" aria-label={`Revert the deletion of ${markerTitle(infoMap, m)}`} onClick={() => cmd.revert(m.id)} disabled={running}>
                    <RotateCcw size={12} />
                  </button>
                ) : (
                  <button
                    type="button"
                    className="text-ink-3 hover:text-danger disabled:opacity-40"
                    aria-label={`Delete ${markerTitle(infoMap, m)}`}
                    onClick={() => {
                      cmd.remove(m.id);
                      if (openId === m.id) setOpenId(null);
                    }}
                    onKeyDown={(e) => {
                      if (e.key === "Delete" || e.key === "Backspace") {
                        e.preventDefault();
                        cmd.remove(m.id);
                      }
                    }}
                    disabled={running}
                  >
                    <Trash2 size={12} />
                  </button>
                )}
              </li>
            );
          })}
        </ul>
      )}
      {open && (
        <div className="mt-2 rounded border border-line p-2">
          <div className="mb-1 flex items-center justify-between">
            <p className="text-[12px] font-medium text-ink">{markerTitle(infoMap, open)}</p>
            <button type="button" className="text-[11px] text-ink-3 hover:text-ink" onClick={() => jumpTo({ measure: open.measure, position: markerPosition(open) })}>
              Jump to
            </button>
          </div>
          <MarkerDetails infoMap={infoMap} marker={open} onClose={() => setOpenId(null)} />
        </div>
      )}
    </SidebarSection>
  );
}
