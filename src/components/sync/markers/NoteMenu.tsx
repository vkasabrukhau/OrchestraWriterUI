"use client";

import { useEffect, useRef } from "react";
import type { InfoMap } from "@/shared/info-map";
import { sameMarkerSpot } from "@/shared/sync";
import { useProject } from "@/lib/store/project";
import { useSyncUi } from "@/lib/store/sync-ui";
import { useProjectTiming } from "@/lib/store/useProjectTiming";
import { spotText } from "@/components/music/bars";
import { useMarkerCommands } from "./useMarkerCommands";
import { RUN_LOCK_REASON, useSyncActions } from "../workspace/SyncActions";

/**
 * Where to open a marker's details: its pin on the score when that pin is on
 * screen, else the point that was right-clicked (always visible).
 */
function anchorFor(id: string, x: number, y: number): HTMLElement | { getBoundingClientRect: () => DOMRect } {
  const el = document.querySelector<HTMLElement>(`.score-marker-button[data-marker-id="${id}"]`);
  const r = el?.getBoundingClientRect();
  const visible = r && r.width + r.height > 0 && r.top >= 0 && r.bottom <= window.innerHeight && r.left >= 0 && r.right <= window.innerWidth && Math.abs(r.left - x) < 40;
  return visible && el ? el : { getBoundingClientRect: () => new DOMRect(x, y, 1, 1) };
}

/**
 * The note menu (right-click, long press, Shift+F10 or the Menu key on the
 * selected note). One item, as the owner asked: "Add marker", or "Edit
 * marker…" when the note already has one. A new marker starts where the note
 * plays now and is pending until a recompute.
 */
export function NoteMenu({ infoMap }: { infoMap: InfoMap }) {
  const menu = useSyncUi((s) => s.menu);
  const closeMenu = useSyncUi((s) => s.closeMenu);
  const sync = useProject((s) => s.sync);
  const { toTransport } = useProjectTiming();
  const cmd = useMarkerCommands();
  const { running } = useSyncActions();
  const ref = useRef<HTMLDivElement>(null);
  const itemRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!menu) return;
    itemRef.current?.focus();
    const away = (e: PointerEvent) => {
      if (!ref.current?.contains(e.target as Node)) closeMenu();
    };
    const key = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        closeMenu();
      }
    };
    window.addEventListener("pointerdown", away, true);
    window.addEventListener("keydown", key, true);
    return () => {
      window.removeEventListener("pointerdown", away, true);
      window.removeEventListener("keydown", key, true);
    };
  }, [menu, closeMenu]);

  if (!menu || !sync) return null;
  const { spot } = menu;
  const existing = sync.manual.find((m) => sameMarkerSpot(m, spot.measure, spot.position));
  const m = infoMap.measures[spot.measure - 1];
  const where = spotText(infoMap, spot.measure, spot.position);

  const act = () => {
    closeMenu();
    if (existing) {
      useSyncUi.getState().openPopover(existing.id, anchorFor(existing.id, menu.x, menu.y));
      return;
    }
    if (!m) return;
    const r = cmd.add(spot.measure, toTransport(m.startTime + spot.position * m.duration), spot.position);
    if (r?.ok) {
      requestAnimationFrame(() => {
        useSyncUi.getState().openPopover(r.id, anchorFor(r.id, menu.x, menu.y));
      });
    }
  };

  return (
    <div
      ref={ref}
      role="menu"
      aria-label={`Note menu: ${where}`}
      className="card fixed z-50 min-w-[180px] p-1 text-[13px] shadow-lg"
      style={{ left: Math.min(menu.x, window.innerWidth - 200), top: Math.min(menu.y, window.innerHeight - 80) }}
    >
      <p className="px-2.5 pb-1 pt-1.5 text-[11px] text-ink-3">{where}</p>
      <button
        ref={itemRef}
        type="button"
        role="menuitem"
        className="w-full rounded-md px-2.5 py-1.5 text-left text-ink hover:bg-paper-3 focus:bg-paper-3 focus:outline-none disabled:opacity-50"
        onClick={act}
        disabled={running && !existing}
        title={running && !existing ? RUN_LOCK_REASON : undefined}
      >
        {existing ? "Edit marker…" : "Add marker"}
      </button>
    </div>
  );
}
