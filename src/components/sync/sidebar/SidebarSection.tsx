"use client";

import type { ReactNode } from "react";
import { ChevronDown, ChevronRight } from "lucide-react";
import { useSyncLayout, type SidebarSectionId } from "@/lib/store/sync-layout";

const ALL: SidebarSectionId[] = ["measures", "markers", "sync"];

/**
 * A sidebar section in the Lightroom Classic manner: a header with a
 * disclosure triangle; any number can be open, the open state is
 * remembered, and Alt-click (or Alt+Enter) on a header opens only that one.
 */
export function SidebarSection({ id, title, summary, children }: { id: SidebarSectionId; title: string; summary?: ReactNode; children: ReactNode }) {
  const open = useSyncLayout((s) => s.open.includes(id));
  const update = useSyncLayout((s) => s.update);
  const toggle = (solo: boolean) => {
    const cur = useSyncLayout.getState().open;
    if (solo) update({ open: [id] });
    else update({ open: open ? cur.filter((x) => x !== id) : ALL.filter((x) => x === id || cur.includes(x)) });
  };
  return (
    <section className="border-b border-line" aria-labelledby={`side-${id}`}>
      <h2 className="m-0">
        <button
          id={`side-${id}`}
          type="button"
          className="flex w-full items-center gap-1.5 px-3 py-2 text-left text-[12px] font-semibold uppercase tracking-wide text-ink-2 hover:text-ink"
          aria-expanded={open}
          aria-controls={`side-${id}-body`}
          title="Alt-click to open only this section"
          onClick={(e) => toggle(e.altKey)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && e.altKey) {
              e.preventDefault();
              toggle(true);
            }
          }}
          data-sidebar-section={id}
        >
          {open ? <ChevronDown size={13} aria-hidden /> : <ChevronRight size={13} aria-hidden />}
          {title}
          {summary && <span className="ml-auto text-[11px] font-normal normal-case tracking-normal text-ink-3">{summary}</span>}
        </button>
      </h2>
      <div id={`side-${id}-body`} hidden={!open} className="px-3 pb-3">
        {open && children}
      </div>
    </section>
  );
}
