"use client";

import { useMemo, useRef, useState } from "react";
import { Check, ChevronDown, Eye, EyeOff, ListFilter, Search, X } from "lucide-react";
import type { InfoMap } from "@/shared/info-map";
import { MAX_PARTS } from "@/shared/info-map";
import type { DisplaySettings } from "@/shared/project-file";
import { SECTION_ORDER, type Section } from "@/shared/sections";
import { partColor } from "@/lib/visualizer";
import { useEditor, useEditorRequest, usePartActivity, type PartFilter } from "@/lib/store/editor";
import { useProject } from "@/lib/store/project";
import { formatShortcut } from "@/lib/editor/commands";
import { cx } from "@/lib/utils/format";
import { Menu, MenuItem } from "@/components/ui/Menu";
import { Tooltip } from "@/components/ui/Tooltip";
import { Dyn } from "@/components/music/Dyn";
import { PanelHeader, FieldBox, bareInput } from "@/components/editor/parts";
import { ColorSwatch } from "./ColorSwatch";

const FILTERS: Array<{ value: PartFilter; label: string }> = [
  { value: "all", label: "All parts" },
  { value: "playing", label: "Playing now" },
  { value: "hidden", label: "Hidden" },
];

/**
 * Left panel: every part, grouped by section. The section swatches are the
 * color legend; each row says whether the part is playing and at which
 * written dynamic, and has show/hide and solo.
 */
export function InstrumentsPanel({ infoMap, display }: { infoMap: InfoMap; display: DisplaySettings }) {
  const activity = usePartActivity((s) => s.activity);
  const { setVisible, setSectionVisible, soloPart, setSectionColor } = useProject.getState();
  const selectedId = useEditor((s) => s.selectedId);
  const select = useEditor((s) => s.select);
  const search = useEditor((s) => s.search);
  const setSearch = useEditor((s) => s.setSearch);
  const filter = useEditor((s) => s.filter);
  const setFilter = useEditor((s) => s.setFilter);
  const searchRef = useRef<HTMLInputElement>(null);
  const [collapsed, setCollapsed] = useState<Partial<Record<Section, boolean>>>({});

  useEditorRequest("searchFocus", () => searchRef.current?.focus());

  const visible = useMemo(() => new Set(display.visibleParts), [display.visibleParts]);
  const soloed = display.visibleParts.length === 1 ? display.visibleParts[0] : null;
  const q = search.trim().toLowerCase();

  const groups = useMemo(
    () =>
      SECTION_ORDER.map((section) => {
        const members = infoMap.instruments.filter((i) => (display.sections[i.id] ?? i.section) === section);
        const shown = members.filter((m) => {
          if (q && !m.name.toLowerCase().includes(q) && !m.shortName.toLowerCase().includes(q)) return false;
          if (filter === "playing") return Boolean(activity[m.id]) && visible.has(m.id);
          if (filter === "hidden") return !visible.has(m.id);
          return true;
        });
        return { section, members, shown };
      }).filter((g) => g.members.length > 0),
    [infoMap, display.sections, q, filter, activity, visible],
  );
  const anyShown = groups.some((g) => g.shown.length > 0);

  return (
    <aside className="flex min-h-0 flex-col bg-paper" aria-labelledby="instruments-title">
      <PanelHeader
        id="instruments-title"
        title="Instruments"
        meta={`${infoMap.instruments.length} / ${MAX_PARTS}`}
        actions={
          <Menu
            align="end"
            ariaLabel="Filter parts"
            className="min-w-40"
            trigger={
              <button
                type="button"
                aria-label="Filter parts"
                className={cx(
                  "grid h-6 w-6 place-items-center rounded-[var(--radius-sm)] hover:bg-paper-3",
                  filter !== "all" ? "bg-brass-soft text-brass-3" : "text-ink-3 hover:text-ink",
                )}
              >
                <ListFilter size={14} aria-hidden />
              </button>
            }
          >
            {FILTERS.map((f) => (
              <MenuItem key={f.value} onSelect={() => setFilter(f.value)} icon={<Check size={13} className={filter === f.value ? "text-brass" : "invisible"} />}>
                {f.label}
              </MenuItem>
            ))}
          </Menu>
        }
      />

      <div className="shrink-0 space-y-2.5 px-2.5 pt-3">
        <FieldBox className="bg-paper-3">
          <Search size={13} className="shrink-0 text-ink-3" aria-hidden />
          <input
            ref={searchRef}
            type="search"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Escape") {
                setSearch("");
                e.currentTarget.blur();
              }
            }}
            placeholder="Find an instrument"
            aria-label="Find an instrument"
            className={cx(bareInput, "[&::-webkit-search-cancel-button]:hidden")}
          />
          {search ? (
            <button type="button" aria-label="Clear search" onClick={() => setSearch("")} className="text-ink-3 hover:text-ink">
              <X size={12} />
            </button>
          ) : (
            <span className="shrink-0 text-[10px] text-ink-3" aria-hidden>
              {formatShortcut({ key: "k", mod: true })}
            </span>
          )}
        </FieldBox>
        <div className="flex items-center justify-between px-1.5 text-[10.5px] text-ink-3">
          <span>Part / activity</span>
          <Eye size={12} aria-hidden />
        </div>
      </div>

      <div className="scroll-thin min-h-0 flex-1 overflow-y-auto px-2.5 pb-3 pt-1">
        {groups.map(({ section, members, shown }) => {
          if (shown.length === 0 && (q || filter !== "all")) return null;
          const open = !collapsed[section];
          const shownCount = members.filter((m) => visible.has(m.id)).length;
          const allShown = shownCount === members.length;
          return (
            <div key={section} className="mt-1.5">
              <div className="flex h-7 items-center gap-1.5 pl-1 pr-1.5">
                <button
                  type="button"
                  className="flex min-w-0 flex-1 items-center gap-1.5 text-left text-[10.5px] font-semibold uppercase tracking-[0.07em] text-ink-3 hover:text-ink"
                  onClick={() => setCollapsed((c) => ({ ...c, [section]: open }))}
                  aria-expanded={open}
                >
                  <ChevronDown size={11} className={cx("shrink-0 transition-transform", !open && "-rotate-90")} aria-hidden />
                  <span className="truncate">{section}</span>
                </button>
                <span className="tnum text-[10.5px] text-ink-3">
                  {shownCount}/{members.length}
                </span>
                <ColorSwatch size="sm" value={display.sectionColors[section]} onChange={(c) => setSectionColor(section, c, { merge: `section-color:${section}` })} label={`${section} color`} />
                <Tooltip label={allShown ? `Hide ${section}` : `Show ${section}`}>
                  <button
                    type="button"
                    className="grid h-6 w-6 place-items-center rounded-[var(--radius-sm)] text-ink-3 hover:bg-paper-3 hover:text-ink"
                    onClick={() => setSectionVisible(section, !allShown)}
                    aria-label={allShown ? `Hide ${section}` : `Show ${section}`}
                  >
                    {allShown ? <Eye size={13} /> : <EyeOff size={13} />}
                  </button>
                </Tooltip>
              </div>
              {open && (
                <ul className="space-y-0.5" aria-label={section}>
                  {shown.map((m) => {
                    const on = visible.has(m.id);
                    const isSel = selectedId === m.id;
                    const dyn = activity[m.id] ?? null;
                    return (
                      <li
                        key={m.id}
                        className={cx("group flex h-11 items-center gap-2.5 rounded-[var(--radius-sm)] pl-2.5 pr-1.5", isSel ? "bg-brass-soft" : "hover:bg-paper-3")}
                      >
                        <span className={cx("h-2 w-2 shrink-0 rounded-full", !on && "opacity-40")} style={{ background: partColor(infoMap, display, m.id) }} aria-hidden />
                        <button
                          type="button"
                          className="flex min-w-0 flex-1 flex-col items-start gap-0.5 text-left"
                          onClick={() => select(isSel ? null : m.id)}
                          aria-pressed={isSel}
                        >
                          <span className={cx("w-full truncate text-[12px]", isSel ? "font-semibold text-brass-3" : on ? "text-ink" : "text-ink-3")}>{m.name}</span>
                          <span className="flex h-3.5 items-center gap-1 text-[10.5px] text-ink-3">
                            {!on ? (
                              "Hidden"
                            ) : dyn ? (
                              <>
                                Playing ·<Dyn value={dyn} size="sm" className="text-[13px] leading-none text-ink-2" />
                              </>
                            ) : (
                              "Rest"
                            )}
                          </span>
                        </button>
                        <Tooltip label={soloed === m.id ? "Show all parts" : "Solo"}>
                          <button
                            type="button"
                            className={cx(
                              "grid h-6 w-6 place-items-center rounded-[var(--radius-sm)] text-[10px] font-semibold hover:bg-paper-4 focus:opacity-100 group-hover:opacity-100",
                              soloed === m.id ? "text-brass-3 opacity-100" : "text-ink-3 opacity-0",
                            )}
                            onClick={() => soloPart(m.id)}
                            aria-label={`Solo ${m.name}`}
                            aria-pressed={soloed === m.id}
                          >
                            S
                          </button>
                        </Tooltip>
                        <button
                          type="button"
                          className="grid h-6 w-6 place-items-center rounded-[var(--radius-sm)] text-ink-3 hover:bg-paper-4 hover:text-ink"
                          onClick={() => setVisible(m.id, !on)}
                          aria-label={on ? `Hide ${m.name}` : `Show ${m.name}`}
                        >
                          {on ? <Eye size={13} /> : <EyeOff size={13} />}
                        </button>
                      </li>
                    );
                  })}
                </ul>
              )}
            </div>
          );
        })}
        {!anyShown && <p className="px-2 py-6 text-center text-[12px] text-ink-3">{q ? `No part matches “${search.trim()}”.` : filter === "playing" ? "Nothing is playing here." : "No hidden parts."}</p>}
      </div>
      <p className="shrink-0 border-t border-line px-4 py-2.5 text-[10.5px] leading-relaxed text-ink-3">Hiding a part changes the visual only. The audio is unchanged.</p>
    </aside>
  );
}
