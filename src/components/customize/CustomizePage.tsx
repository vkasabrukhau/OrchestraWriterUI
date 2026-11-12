"use client";

import { useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { ArrowDown, ArrowLeft, ArrowRight, ArrowUp, ChevronDown, Eye, EyeOff, RotateCcw } from "lucide-react";
import { DEFAULT_SECTION_COLORS, SECTION_ORDER, SECTIONS, type Section } from "@/shared/sections";
import type { DisplaySettings } from "@/shared/project-file";
import type { InfoMap } from "@/shared/info-map";
import { useProject } from "@/lib/store/project";
import { usePlayback } from "@/lib/store/playback";
import { useProjectTiming } from "@/lib/store/useProjectTiming";
import { partColor } from "@/lib/visualizer";
import { cx } from "@/lib/utils/format";
import { Stage } from "@/components/visualizer/Stage";
import { useWaveform } from "@/components/visualizer/useWaveform";
import { Transport } from "@/components/music/Transport";
import { NeedsScore } from "@/components/music/NeedsScore";
import { barBeatText } from "@/components/music/bars";
import { Button } from "@/components/ui/Button";
import { Toggle } from "@/components/ui/Toggle";
import { Segmented } from "@/components/ui/Segmented";
import { Select } from "@/components/ui/Field";
import { Slider } from "@/components/ui/Slider";
import { Tooltip } from "@/components/ui/Tooltip";
import { PageHeader, Dot } from "@/components/shell/PageHeader";
import { ColorSwatch } from "./ColorSwatch";

/** Section palettes the user can apply in one click; the choice is saved in the project's display settings. */
export const PALETTES: Array<{ id: string; name: string; colors: Record<Section, string> }> = [
  { id: "concert", name: "Concert", colors: { ...DEFAULT_SECTION_COLORS } },
  { id: "aurora", name: "Aurora", colors: { Strings: "#7fd4c1", Woodwinds: "#8fb7ff", Brass: "#ffa26b", Percussion: "#d79bff", Other: "#ffd27a" } },
  { id: "ember", name: "Ember", colors: { Strings: "#f2b544", Woodwinds: "#f08a4b", Brass: "#e8545f", Percussion: "#b86cd8", Other: "#8bd3dd" } },
  { id: "tints", name: "Brass tints", colors: { Strings: "#e9c67a", Woodwinds: "#c8a24f", Brass: "#f1dca0", Percussion: "#a3833b", Other: "#d9b35f" } },
];

const NUDGE: Array<{ label: string; icon: React.ReactNode; dx: number; dy: number }> = [
  { label: "Move left", icon: <ArrowLeft size={14} />, dx: -0.02, dy: 0 },
  { label: "Move right", icon: <ArrowRight size={14} />, dx: 0.02, dy: 0 },
  { label: "Move back", icon: <ArrowUp size={14} />, dx: 0, dy: -0.03 },
  { label: "Move forward", icon: <ArrowDown size={14} />, dx: 0, dy: 0.03 },
];

export function CustomizePage({ projectId }: { projectId: string }) {
  const summary = useProject((s) => s.summary);
  const infoMap = useProject((s) => s.infoMap);
  const display = useProject((s) => s.display);
  if (!summary || !infoMap || !display) return <NeedsScore projectId={projectId} title="Customize the display" />;
  return <CustomizeEditor projectId={projectId} infoMap={infoMap} display={display} />;
}

function CustomizeEditor({ projectId, infoMap, display }: { projectId: string; infoMap: InfoMap; display: DisplaySettings }) {
  const router = useRouter();
  const storePeaks = useProject((s) => s.peaks);
  const setStage = useProject((s) => s.setStage);
  const {
    setVisible,
    setSectionVisible,
    soloPart,
    setPartColor,
    setSectionColor,
    setPartSection,
    setPosition,
    resetPositions,
    resetColors,
    setShowLabels,
    setLabelMode,
    setReducedMotion,
    setGlowScale,
  } = useProject.getState();
  const playing = usePlayback((s) => s.playing);
  const { clock, toScore } = useProjectTiming();
  const peaks = useWaveform({ peaks: storePeaks, infoMap });
  const [selected, setSelected] = useState<string | null>(null);
  const [collapsed, setCollapsed] = useState<Partial<Record<Section, boolean>>>({});

  const visible = useMemo(() => new Set(display.visibleParts), [display.visibleParts]);
  const sectionOf = (id: string): Section => display.sections[id] ?? infoMap.instruments.find((i) => i.id === id)?.section ?? "Other";
  const grouped = useMemo(
    () =>
      SECTION_ORDER.map((section) => ({
        section,
        members: infoMap.instruments.filter((i) => (display.sections[i.id] ?? i.section) === section),
      })).filter((g) => g.members.length > 0),
    [infoMap, display.sections],
  );
  const sel = selected ? (infoMap.instruments.find((i) => i.id === selected) ?? null) : null;
  const soloed = display.visibleParts.length === 1 ? display.visibleParts[0] : null;

  const goPreview = () => {
    setStage("preview");
    router.push(`/projects/${projectId}/preview`);
  };

  return (
    <div className="space-y-6">
      <PageHeader
        title="Customize the display"
        meta={
          <>
            <span className="tnum">
              {display.visibleParts.length} of {infoMap.instruments.length} parts shown
            </span>
            <Dot />
            <span className="tnum">
              {grouped.length} {grouped.length === 1 ? "section" : "sections"}
            </span>
          </>
        }
        actions={
          <>
            <Button variant="ghost" size="sm" leading={<RotateCcw size={14} />} onClick={resetPositions}>
              Reset positions
            </Button>
            <Button size="sm" onClick={goPreview} trailing={<ArrowRight size={14} />}>
              Continue to Preview
            </Button>
          </>
        }
      />

      <div className="grid gap-5 lg:grid-cols-[248px_minmax(0,1fr)] xl:grid-cols-[272px_minmax(0,1fr)_304px]">
        {/* parts list: also the section color legend */}
        <aside className="card scroll-thin max-h-[calc(100vh-7rem)] self-start overflow-y-auto p-3 lg:sticky lg:top-24" aria-labelledby="parts-title">
          <div className="flex items-center justify-between px-2 pb-2 pt-1">
            <h2 id="parts-title" className="text-[13px] font-medium text-ink-2">
              Parts
            </h2>
            <span className="tnum text-[11px] text-ink-3">{infoMap.instruments.length} / 64</span>
          </div>
          {grouped.map(({ section, members }) => {
            const shown = members.filter((m) => visible.has(m.id)).length;
            const open = !collapsed[section];
            const allShown = shown === members.length;
            return (
              <div key={section} className="mb-1">
                <div className="flex items-center gap-2 rounded-[var(--radius-sm)] px-2 py-1.5 hover:bg-paper-3">
                  <ColorSwatch size="sm" value={display.sectionColors[section]} onChange={(c) => setSectionColor(section, c)} label={`${section} color`} />
                  <button
                    type="button"
                    className="flex flex-1 items-center gap-1 text-left text-[13px] font-medium text-ink"
                    onClick={() => setCollapsed((c) => ({ ...c, [section]: open }))}
                    aria-expanded={open}
                  >
                    {section}
                    <ChevronDown size={13} className={cx("text-ink-3 transition-transform", !open && "-rotate-90")} aria-hidden />
                  </button>
                  <span className="tnum text-[11px] text-ink-3">
                    {shown}/{members.length}
                  </span>
                  <Tooltip label={allShown ? `Hide ${section}` : `Show ${section}`}>
                    <button
                      type="button"
                      className="rounded-full p-1 text-ink-3 hover:text-ink"
                      onClick={() => setSectionVisible(section, !allShown)}
                      aria-label={allShown ? `Hide ${section}` : `Show ${section}`}
                    >
                      {allShown ? <Eye size={14} /> : <EyeOff size={14} />}
                    </button>
                  </Tooltip>
                </div>
                {open &&
                  members.map((m) => {
                    const on = visible.has(m.id);
                    const isSel = selected === m.id;
                    return (
                      <div
                        key={m.id}
                        className={cx("group flex items-center gap-2 rounded-[var(--radius-sm)] py-1 pl-6 pr-2", isSel ? "bg-brass-soft" : "hover:bg-paper-3", !on && "opacity-50")}
                      >
                        <span className="h-2.5 w-2.5 shrink-0 rounded-full ring-1 ring-black/10" style={{ background: partColor(infoMap, display, m.id) }} aria-hidden />
                        <button
                          type="button"
                          className={cx("min-w-0 flex-1 truncate py-0.5 text-left text-[13px]", isSel ? "text-ink" : "text-ink-2")}
                          onClick={() => setSelected(isSel ? null : m.id)}
                          aria-pressed={isSel}
                        >
                          {m.name}
                        </button>
                        <Tooltip label={soloed === m.id ? "Show all parts" : "Solo"}>
                          <button
                            type="button"
                            className={cx(
                              "rounded px-1 text-[10px] font-semibold text-ink-3 hover:text-ink focus:opacity-100 group-hover:opacity-100",
                              soloed === m.id ? "text-brass-3 opacity-100" : "opacity-0",
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
                          className="rounded-full p-1 text-ink-3 hover:text-ink"
                          onClick={() => setVisible(m.id, !on)}
                          aria-label={on ? `Hide ${m.name}` : `Show ${m.name}`}
                        >
                          {on ? <Eye size={13} /> : <EyeOff size={13} />}
                        </button>
                      </div>
                    );
                  })}
              </div>
            );
          })}
          <p className="px-2 pt-2 text-[11px] leading-relaxed text-ink-4">Hiding a part changes the visual only. The audio is unchanged.</p>
        </aside>

        {/* stage */}
        <div className="min-w-0 space-y-4">
          <Stage
            infoMap={infoMap}
            display={display}
            clock={clock}
            interactive
            selectedId={selected}
            onSelect={setSelected}
            onMove={setPosition}
            previewAll={!playing}
            showLegend
          />
          <Transport peaks={peaks} positionLabel={(t) => barBeatText(infoMap, toScore(t))} />
          <p className="text-[12px] text-ink-3">
            {playing ? "Playing: glows follow the written dynamics." : "Paused: every visible part is lit at a middle level so you can place it. Drag a glow to move it."}
          </p>
        </div>

        {/* settings */}
        <aside className="space-y-4 self-start lg:col-span-2 xl:sticky xl:top-24 xl:col-span-1">
          <section className="card p-4" aria-label="Selected part">
            {sel ? (
              <div className="space-y-3">
                <div className="flex items-center justify-between gap-3">
                  <h2 className="font-serif text-[20px] text-ink">{sel.name}</h2>
                  <ColorSwatch size="lg" value={partColor(infoMap, display, sel.id)} onChange={(c) => setPartColor(sel.id, c)} label={`${sel.name} color`} />
                </div>
                <div className="grid grid-cols-2 gap-2">
                  <div>
                    <label className="text-[12px] text-ink-3" htmlFor="part-section">
                      Section
                    </label>
                    <Select id="part-section" value={sectionOf(sel.id)} onChange={(e) => setPartSection(sel.id, e.target.value as Section)} className="h-9 text-[13px]">
                      {SECTIONS.map((s) => (
                        <option key={s}>{s}</option>
                      ))}
                    </Select>
                  </div>
                  <div>
                    <span className="text-[12px] text-ink-3">Color</span>
                    <Button variant="outline" size="sm" className="h-9 w-full" onClick={() => setPartColor(sel.id, null)} disabled={!display.colors[sel.id]}>
                      Use section color
                    </Button>
                  </div>
                </div>
                <div>
                  <span className="text-[12px] text-ink-3" id="position-label">
                    Position
                  </span>
                  <div className="mt-1 grid grid-cols-4 gap-1.5" role="group" aria-labelledby="position-label">
                    {NUDGE.map(({ label, icon, dx, dy }) => (
                      <Tooltip key={label} label={label}>
                        <Button
                          variant="secondary"
                          size="sm"
                          className="h-8"
                          aria-label={label}
                          onClick={() => {
                            const p = display.positions[sel.id] ?? { x: 0.5, y: 0.5 };
                            setPosition(sel.id, { x: Math.min(0.97, Math.max(0.03, p.x + dx)), y: Math.min(0.9, Math.max(0.05, p.y + dy)) });
                          }}
                        >
                          {icon}
                        </Button>
                      </Tooltip>
                    ))}
                  </div>
                </div>
                <div className="flex gap-2 pt-1">
                  <Button variant="outline" size="sm" className="flex-1" onClick={() => setVisible(sel.id, !visible.has(sel.id))}>
                    {visible.has(sel.id) ? "Hide" : "Show"}
                  </Button>
                  <Button variant="outline" size="sm" className="flex-1" onClick={() => soloPart(sel.id)} aria-pressed={soloed === sel.id}>
                    {soloed === sel.id ? "Show all" : "Solo"}
                  </Button>
                </div>
              </div>
            ) : (
              <p className="text-[13px] leading-relaxed text-ink-3">Select a glow on the stage or a part in the list to recolor, reassign or move it.</p>
            )}
          </section>

          <section className="card p-4" aria-labelledby="section-colors-title">
            <div className="mb-3 flex items-center justify-between">
              <h2 id="section-colors-title" className="text-[13px] font-medium text-ink-2">
                Section colors
              </h2>
              <button type="button" className="text-[12px] text-ink-3 hover:text-ink" onClick={resetColors}>
                Reset
              </button>
            </div>
            <div className="mb-3 flex flex-wrap gap-1.5">
              {PALETTES.map((p) => (
                <button
                  key={p.id}
                  type="button"
                  onClick={() => SECTIONS.forEach((s) => setSectionColor(s, p.colors[s]))}
                  className="flex items-center gap-1.5 rounded-full border border-line bg-paper-2 py-1 pl-1.5 pr-2.5 text-[12px] text-ink-2 hover:border-line-strong"
                >
                  <span className="flex -space-x-1" aria-hidden>
                    {SECTION_ORDER.slice(0, 4).map((s) => (
                      <span key={s} className="h-3.5 w-3.5 rounded-full ring-1 ring-paper-2" style={{ background: p.colors[s] }} />
                    ))}
                  </span>
                  {p.name}
                </button>
              ))}
            </div>
            <ul className="space-y-2">
              {grouped.map(({ section, members }) => (
                <li key={section} className="flex items-center justify-between text-[13px]">
                  <span className="flex items-center gap-2 text-ink-2">
                    <ColorSwatch value={display.sectionColors[section]} onChange={(c) => setSectionColor(section, c)} label={`${section} color`} />
                    {section}
                  </span>
                  <span className="tnum text-[11px] text-ink-3">
                    {members.length} {members.length === 1 ? "part" : "parts"}
                  </span>
                </li>
              ))}
            </ul>
            <p className="mt-3 text-[11px] leading-relaxed text-ink-4">About 8–10 distinct hues read well. Beyond that, parts within a section use tints and labels.</p>
          </section>

          <section className="card space-y-3 p-4" aria-labelledby="display-title">
            <h2 id="display-title" className="text-[13px] font-medium text-ink-2">
              Display
            </h2>
            <Toggle label="Show part labels" checked={display.showLabels} onChange={setShowLabels} />
            <div className="flex items-center justify-between">
              <span className="text-sm text-ink">Label by</span>
              <Segmented
                size="sm"
                ariaLabel="Label by"
                value={display.labelMode}
                onChange={setLabelMode}
                options={[
                  { value: "sections", label: "Sections" },
                  { value: "parts", label: "Parts" },
                ]}
              />
            </div>
            <Toggle label="Reduced motion" description="Fades become instant switches." checked={display.reducedMotion} onChange={setReducedMotion} />
            <div>
              <div className="flex items-center justify-between text-[13px]">
                <span className="text-ink">Glow size</span>
                <span className="tnum text-ink-3">{Math.round(display.glowScale * 100)}%</span>
              </div>
              <Slider
                value={display.glowScale}
                onChange={setGlowScale}
                min={0.6}
                max={1.4}
                step={0.05}
                ariaLabel="Glow size"
                formatValue={(v) => `${Math.round(v * 100)}%`}
              />
            </div>
            <p className="border-t border-line pt-3 text-[12px] leading-relaxed text-ink-4">Pitch, articulation and custom mappings come in a later phase.</p>
          </section>
        </aside>
      </div>
    </div>
  );
}
