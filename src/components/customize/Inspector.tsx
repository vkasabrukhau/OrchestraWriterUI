"use client";

import { useState } from "react";
import { Eye, EyeOff, RotateCcw } from "lucide-react";
import type { InfoMap } from "@/shared/info-map";
import type { DisplaySettings } from "@/shared/project-file";
import { SECTIONS, SECTION_ORDER, type Section } from "@/shared/sections";
import { partColor } from "@/lib/visualizer";
import { useEditor } from "@/lib/store/editor";
import { useProject } from "@/lib/store/project";
import { clampPosition } from "@/lib/editor/commands";
import { cx } from "@/lib/utils/format";
import { Toggle } from "@/components/ui/Toggle";
import { Segmented } from "@/components/ui/Segmented";
import { Slider } from "@/components/ui/Slider";
import { Tooltip } from "@/components/ui/Tooltip";
import { DynamicLegend } from "@/components/music/DynamicLegend";
import { EditorButton, FieldBox, PanelHeader, PropLabel, PropSection, bareInput } from "@/components/editor/parts";
import { ColorSwatch } from "./ColorSwatch";
import { normalizeHex, sectionTints } from "./color";
import { PALETTES } from "./palettes";

/**
 * Right panel. With a part selected it edits that part (color, section,
 * position, visibility); with nothing selected it edits the stage (section
 * colors, glow size, labels, motion) and explains the brightness ladder.
 */
export function Inspector({ infoMap, display }: { infoMap: InfoMap; display: DisplaySettings }) {
  const selectedId = useEditor((s) => s.selectedId);
  const sel = selectedId ? (infoMap.instruments.find((i) => i.id === selectedId) ?? null) : null;
  return (
    <aside className="flex min-h-0 flex-col bg-paper" aria-labelledby="properties-title">
      <PanelHeader id="properties-title" title="Properties" meta={sel ? "Part" : "Stage"} />
      <div className="scroll-thin min-h-0 flex-1 overflow-y-auto">{sel ? <PartProperties infoMap={infoMap} display={display} id={sel.id} /> : <StageProperties infoMap={infoMap} display={display} />}</div>
    </aside>
  );
}

/* ------------------------------------------------------------------ */
/* Selected part                                                        */
/* ------------------------------------------------------------------ */

function PartProperties({ infoMap, display, id }: { infoMap: InfoMap; display: DisplaySettings; id: string }) {
  const { setPartColor, setPartSection, setPosition, setVisible, soloPart, resetPart } = useProject.getState();
  const index = infoMap.instruments.findIndex((i) => i.id === id);
  const inst = infoMap.instruments[index];
  const section: Section = display.sections[id] ?? inst.section;
  const color = partColor(infoMap, display, id);
  const custom = Boolean(display.colors[id]);
  const on = display.visibleParts.includes(id);
  const soloed = display.visibleParts.length === 1 && display.visibleParts[0] === id;
  const pos = display.positions[id] ?? { x: 0.5, y: 0.5 };
  const tints = sectionTints(display.sectionColors[section]);

  return (
    <section aria-label="Selected part">
      <div className="flex items-center gap-3 border-b border-line px-4 py-4">
        <span className="grid h-9.5 w-9.5 shrink-0 place-items-center rounded-full" style={{ background: `color-mix(in srgb, ${color} 22%, transparent)` }} aria-hidden>
          <span className="h-5.5 w-5.5 rounded-full ring-2 ring-paper" style={{ background: color }} />
        </span>
        <div className="min-w-0 flex-1">
          <h2 className="truncate text-[14px] font-semibold text-ink">{inst.name}</h2>
          <p className="tnum mt-0.5 text-[11px] text-ink-3">
            {section} · Part {String(index + 1).padStart(2, "0")}
          </p>
        </div>
        <Tooltip label={on ? "Hide this part" : "Show this part"}>
          <button
            type="button"
            className="grid h-7 w-7 place-items-center rounded-[var(--radius-sm)] text-brass hover:bg-paper-3"
            onClick={() => setVisible(id, !on)}
            aria-label={on ? `Hide ${inst.name}` : `Show ${inst.name}`}
          >
            {on ? <Eye size={15} /> : <EyeOff size={15} className="text-ink-3" />}
          </button>
        </Tooltip>
      </div>

      <PropSection title="Color" detail={custom ? "Custom" : "Section color"} labelledBy="prop-color">
        <div>
          <PropLabel htmlFor="part-hex">Part color</PropLabel>
          <FieldBox>
            <ColorSwatch shape="square" value={color} onChange={(c) => setPartColor(id, c, { merge: `color:${id}` })} label={`${inst.name} color`} />
            <HexInput id="part-hex" value={color} onCommit={(hex) => setPartColor(id, hex)} />
          </FieldBox>
        </div>
        <div className="flex flex-wrap items-center gap-2" role="group" aria-label={`${section} tints`}>
          {tints.map((t) => (
            <button
              key={t}
              type="button"
              onClick={() => setPartColor(id, t)}
              aria-label={`Use ${t}`}
              aria-pressed={color.toLowerCase() === t}
              className={cx("h-4.5 w-4.5 rounded-full ring-1 ring-black/10", color.toLowerCase() === t && "outline-2 outline-offset-2 outline-ink")}
              style={{ background: t }}
            />
          ))}
        </div>
        <p className="text-[10.5px] leading-relaxed text-ink-3">Tints stay close to the section’s color, so the section still reads at a glance and brightness still means the written dynamic.</p>
        <EditorButton onClick={() => setPartColor(id, null)} disabled={!custom} className="w-full">
          Use section color
        </EditorButton>
      </PropSection>

      <PropSection title="Section" labelledBy="prop-section">
        <div>
          <PropLabel htmlFor="part-section">Belongs to</PropLabel>
          <FieldBox className="pr-1.5">
            <select id="part-section" value={section} onChange={(e) => setPartSection(id, e.target.value as Section)} className={cx(bareInput, "cursor-pointer")}>
              {SECTIONS.map((s) => (
                <option key={s}>{s}</option>
              ))}
            </select>
          </FieldBox>
        </div>
      </PropSection>

      <PropSection
        title="Position"
        detail={
          <button type="button" onClick={() => resetPart(id)} className="inline-flex items-center gap-1 text-brass-3 hover:underline">
            <RotateCcw size={10} aria-hidden />
            Default seat
          </button>
        }
        labelledBy="prop-position"
      >
        <div className="grid grid-cols-2 gap-2.5">
          <PercentField id="pos-x" label="Position X" value={pos.x} onCommit={(x) => setPosition(id, clampPosition({ x, y: pos.y }))} />
          <PercentField id="pos-y" label="Position Y" value={pos.y} onCommit={(y) => setPosition(id, clampPosition({ x: pos.x, y }))} />
        </div>
        <p className="text-[10.5px] leading-relaxed text-ink-3">X runs left to right, Y from the back of the stage to the conductor. Drag on the stage, or focus it and use the arrow keys.</p>
      </PropSection>

      <PropSection title="Visibility" labelledBy="prop-visibility">
        <div className="flex gap-2">
          <EditorButton className="flex-1" onClick={() => setVisible(id, !on)}>
            {on ? "Hide" : "Show"}
          </EditorButton>
          <EditorButton className="flex-1" onClick={() => soloPart(id)} aria-pressed={soloed}>
            {soloed ? "Show all" : "Solo"}
          </EditorButton>
        </div>
        <p className="text-[10.5px] leading-relaxed text-ink-3">Glow size is set for the whole stage, so a bigger glow never reads as a louder part.</p>
      </PropSection>
    </section>
  );
}

function HexInput({ id, value, onCommit }: { id: string; value: string; onCommit: (hex: string) => void }) {
  // null while not editing, so the field always shows the stored color
  const [draft, setDraft] = useState<string | null>(null);
  const shown = draft ?? value.replace("#", "").toUpperCase();
  const commit = () => {
    const hex = draft === null ? null : normalizeHex(draft);
    if (hex && hex !== value.toLowerCase()) onCommit(hex);
    setDraft(null);
  };
  return (
    <>
      <span className="text-[11px] text-ink-3" aria-hidden>
        #
      </span>
      <input
        id={id}
        value={shown}
        onChange={(e) => setDraft(e.target.value.replace(/[^0-9a-f#]/gi, "").slice(0, 7))}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === "Enter") commit();
          if (e.key === "Escape") setDraft(null);
        }}
        aria-label="Hex color"
        spellCheck={false}
        className={cx(bareInput, "tnum uppercase")}
      />
    </>
  );
}

/** A 0–1 value edited as a percentage with one decimal; commits on Enter or blur, arrows step 1 %. */
function PercentField({ id, label, value, onCommit }: { id: string; label: string; value: number; onCommit: (v: number) => void }) {
  const fmt = (v: number) => (v * 100).toFixed(1);
  // null while not editing, so drags on the stage show up here live
  const [draft, setDraft] = useState<string | null>(null);
  const shown = draft ?? fmt(value);
  const commit = (text = shown) => {
    const n = Number(text);
    if (text.trim() !== "" && Number.isFinite(n)) onCommit(n / 100);
    setDraft(null);
  };
  return (
    <div>
      <PropLabel htmlFor={id}>{label}</PropLabel>
      <FieldBox>
        <input
          id={id}
          inputMode="decimal"
          value={shown}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={() => commit()}
          onKeyDown={(e) => {
            if (e.key === "Enter") commit();
            if (e.key === "Escape") setDraft(null);
            if (e.key === "ArrowUp" || e.key === "ArrowDown") {
              e.preventDefault();
              const step = (e.shiftKey ? 10 : 1) * (e.key === "ArrowUp" ? 1 : -1);
              commit(String((Number(shown) || 0) + step));
            }
          }}
          className={cx(bareInput, "tnum")}
        />
        <span className="text-[11px] text-ink-3" aria-hidden>
          %
        </span>
      </FieldBox>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Stage (nothing selected)                                             */
/* ------------------------------------------------------------------ */

function StageProperties({ infoMap, display }: { infoMap: InfoMap; display: DisplaySettings }) {
  const { setSectionColor, resetColors, setShowLabels, setLabelMode, setReducedMotion, setGlowScale, beginGesture, endGesture } = useProject.getState();
  const counts = SECTION_ORDER.map((section) => ({
    section,
    parts: infoMap.instruments.filter((i) => (display.sections[i.id] ?? i.section) === section).length,
  })).filter((s) => s.parts > 0);

  return (
    <div aria-label="Stage settings" role="group">
      <p className="border-b border-line px-4 py-3 text-[11.5px] leading-relaxed text-ink-3">Select a glow on the stage or a part in the list to edit it. These settings apply to the whole stage.</p>

      <PropSection
        title="Section colors"
        labelledBy="section-colors-title"
        detail={
          <button type="button" className="text-brass-3 hover:underline" onClick={resetColors}>
            Reset
          </button>
        }
      >
        <div className="flex flex-wrap gap-1.5">
          {PALETTES.map((p) => (
            <button
              key={p.id}
              type="button"
              onClick={() => {
                beginGesture();
                SECTIONS.forEach((s) => setSectionColor(s, p.colors[s]));
                endGesture();
              }}
              className="flex h-6.5 items-center gap-1.5 rounded-[var(--radius-sm)] border border-line bg-paper-2 pl-1.5 pr-2 text-[11px] text-ink-2 hover:border-line-strong hover:text-ink"
            >
              <span className="flex -space-x-1" aria-hidden>
                {SECTION_ORDER.slice(0, 4).map((s) => (
                  <span key={s} className="h-3 w-3 rounded-full ring-1 ring-paper-2" style={{ background: p.colors[s] }} />
                ))}
              </span>
              {p.name}
            </button>
          ))}
        </div>
        <ul className="space-y-1.5">
          {counts.map(({ section, parts }) => (
            <li key={section} className="flex items-center justify-between text-[12px]">
              <span className="flex items-center gap-2.5 text-ink">
                <ColorSwatch shape="square" value={display.sectionColors[section]} onChange={(c) => setSectionColor(section, c, { merge: `section-color:${section}` })} label={`${section} color`} />
                {section}
              </span>
              <span className="tnum text-[10.5px] text-ink-3">
                {parts} {parts === 1 ? "part" : "parts"}
              </span>
            </li>
          ))}
        </ul>
        <p className="text-[10.5px] leading-relaxed text-ink-3">About 8–10 distinct hues read well. Beyond that, parts within a section use tints and labels.</p>
      </PropSection>

      <PropSection title="Glow" detail={`${Math.round(display.glowScale * 100)}%`} labelledBy="prop-glow">
        <div>
          <PropLabel id="glow-size-label">Glow size</PropLabel>
          <Slider
            value={display.glowScale}
            // a drag (or a run of arrow presses) is one undo step
            onChange={(v) => setGlowScale(v, { merge: "glow" })}
            min={0.6}
            max={1.4}
            step={0.05}
            ariaLabel="Glow size"
            formatValue={(v) => `${Math.round(v * 100)}%`}
            className="h-5"
          />
        </div>
      </PropSection>

      <PropSection title="Labels" labelledBy="prop-labels">
        <Toggle size="sm" label="Show part labels" checked={display.showLabels} onChange={setShowLabels} />
        <div className="flex items-center justify-between gap-3">
          <span className="text-[12px] text-ink-2">Label by</span>
          <Segmented
            size="sm"
            ariaLabel="Label by"
            value={display.labelMode}
            onChange={setLabelMode}
            options={[
              { value: "sections", label: "Sections", disabled: !display.showLabels },
              { value: "parts", label: "Parts", disabled: !display.showLabels },
            ]}
          />
        </div>
      </PropSection>

      <PropSection title="Brightness" detail="From the score" labelledBy="prop-brightness">
        <DynamicLegend compact />
        <p className="text-[10.5px] leading-relaxed text-ink-3">Brightness follows the written dynamic. Notes light up; rests fade out. The recording’s loudness is never used.</p>
        <Toggle size="sm" label="Reduced motion" description="Fades become instant switches." checked={display.reducedMotion} onChange={setReducedMotion} />
      </PropSection>
    </div>
  );
}
