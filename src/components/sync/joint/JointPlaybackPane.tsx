"use client";

import { useEffect, useMemo, useState } from "react";
import { Popover } from "radix-ui";
import { Info, SlidersHorizontal } from "lucide-react";
import type { InfoMap } from "@/shared/info-map";
import { DEFAULT_SECTION_COLORS, SECTIONS, type Section } from "@/shared/sections";
import { api } from "@/lib/api";
import { useProject } from "@/lib/store/project";
import { usePlayback } from "@/lib/store/playback";
import { useSyncUi } from "@/lib/store/sync-ui";
import { useProjectTiming } from "@/lib/store/useProjectTiming";
import type { PeakPyramid } from "@/lib/audio/peaks";
import { cx } from "@/lib/utils/format";
import { Toggle } from "@/components/ui/Toggle";
import { Transport } from "@/components/music/Transport";
import { barBeatText } from "@/components/music/bars";
import { MarkerGlyph } from "../markers/MarkerIcon";
import { PianoRoll } from "./PianoRoll";

/**
 * Joint playback: section filters (the chips are the color legend), the
 * piano roll over the waveform, and the transport (play/pause, listening
 * speed of the recording).
 */
export function JointPlaybackPane({ projectId, infoMap }: { projectId: string; infoMap: InfoMap }) {
  const display = useProject((s) => s.display);
  const storePeaks = useProject((s) => s.peaks);
  const duration = usePlayback((s) => s.duration);
  const { aligned, toScore } = useProjectTiming();
  const hiddenSections = useSyncUi((s) => s.hiddenSections);
  const hiddenParts = useSyncUi((s) => s.hiddenParts);
  const onlyVisible = useSyncUi((s) => s.onlyVisible);
  const follow = useSyncUi((s) => s.follow);
  const setUi = useSyncUi((s) => s.set);
  const [pyramid, setPyramid] = useState<{ id: string; p: PeakPyramid | null } | null>(null);
  const [waveError, setWaveError] = useState(false);

  useEffect(() => {
    const ac = new AbortController();
    api
      .loadRecordingPeaks(projectId, ac.signal)
      .then((p) => setPyramid({ id: projectId, p }))
      .catch((err: unknown) => {
        if (err instanceof Error && err.name === "AbortError") return;
        setWaveError(true);
      });
    return () => ac.abort();
  }, [projectId]);

  const sectionsPresent = useMemo(() => {
    const set = new Set<Section>();
    for (const inst of infoMap.instruments) set.add((display?.sections?.[inst.id] ?? inst.section) as Section);
    return SECTIONS.filter((s) => set.has(s));
  }, [infoMap, display]);
  const colors = { ...DEFAULT_SECTION_COLORS, ...(display?.sectionColors ?? {}) };
  const effectiveHiddenParts = useMemo(() => {
    if (!onlyVisible || !display) return hiddenParts;
    const visible = new Set(display.visibleParts);
    const out = new Set(hiddenParts);
    for (const inst of infoMap.instruments) if (!visible.has(inst.id)) out.add(inst.id);
    return out;
  }, [onlyVisible, display, hiddenParts, infoMap]);

  const toggleSection = (s: Section) => {
    const next = new Set(hiddenSections);
    if (next.has(s)) next.delete(s);
    else next.add(s);
    setUi({ hiddenSections: next });
  };

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex shrink-0 flex-wrap items-center gap-1.5 border-b border-line py-1 pl-2 pr-7">
        <span className="text-[11px] text-ink-3" id="roll-sections">
          Sections
        </span>
        <div role="group" aria-labelledby="roll-sections" className="flex flex-wrap gap-1">
          {sectionsPresent.map((s) => {
            const on = !hiddenSections.has(s);
            return (
              <button
                key={s}
                type="button"
                aria-pressed={on}
                onClick={() => toggleSection(s)}
                className={cx("inline-flex items-center gap-1.5 rounded-full border px-2 py-0.5 text-[11px]", on ? "border-line text-ink-2" : "border-dashed border-line text-ink-4 line-through")}
                data-section-chip={s}
              >
                <span className="h-2 w-2 rounded-full" style={{ background: colors[s] }} aria-hidden />
                {s}
              </button>
            );
          })}
        </div>
        <PartsFilter infoMap={infoMap} />
        <label className="ml-1 inline-flex items-center gap-1.5 text-[11px] text-ink-3">
          <Toggle size="sm" ariaLabel="Only parts shown in Customize" checked={onlyVisible} onChange={(v) => setUi({ onlyVisible: v })} />
          Only parts shown in Customize
        </label>
        <div className="ml-auto flex items-center gap-2">
          <label className="inline-flex items-center gap-1.5 text-[11px] text-ink-3">
            <Toggle size="sm" ariaLabel="Follow playback in the roll" checked={follow} onChange={(v) => setUi({ follow: v })} />
            Follow
          </label>
          <RollKey />
        </div>
      </div>
      <div className="min-h-0 flex-1">
        <PianoRoll
          infoMap={infoMap}
          aligned={aligned}
          display={display}
          durationSec={duration}
          pyramid={pyramid?.id === projectId ? pyramid.p : null}
          peaks={storePeaks}
          hiddenSections={hiddenSections}
          hiddenParts={effectiveHiddenParts}
        />
      </div>
      {waveError && <p className="px-2 text-[11px] text-ink-3">Zoomed waveform unavailable; showing the overview.</p>}
      <div className="shrink-0 border-t border-line px-2 py-1">
        <Transport peaks={storePeaks ?? []} scrubber={false} positionLabel={(t) => barBeatText(infoMap, toScore(t))} />
      </div>
    </div>
  );
}

function PartsFilter({ infoMap }: { infoMap: InfoMap }) {
  const hiddenParts = useSyncUi((s) => s.hiddenParts);
  const setUi = useSyncUi((s) => s.set);
  const [q, setQ] = useState("");
  const list = infoMap.instruments.filter((i) => i.name.toLowerCase().includes(q.trim().toLowerCase()));
  return (
    <Popover.Root>
      <Popover.Trigger asChild>
        <button type="button" className="inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[11px] text-ink-3 hover:bg-paper-3 hover:text-ink">
          <SlidersHorizontal size={12} aria-hidden /> Parts{hiddenParts.size > 0 ? ` (${infoMap.instruments.length - hiddenParts.size}/${infoMap.instruments.length})` : ""}
        </button>
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Content className="card z-50 w-64 p-2 text-[12px]" sideOffset={6} align="start">
          <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Find a part" className="mb-1.5 h-7 w-full rounded border border-line bg-paper px-2" aria-label="Find a part" />
          <div className="mb-1 flex gap-2">
            <button type="button" className="text-brass-3 hover:underline" onClick={() => setUi({ hiddenParts: new Set() })}>
              Show all
            </button>
            <button type="button" className="text-brass-3 hover:underline" onClick={() => setUi({ hiddenParts: new Set(infoMap.instruments.map((i) => i.id)) })}>
              Hide all
            </button>
          </div>
          <ul className="scroll-thin max-h-60 overflow-y-auto">
            {list.map((i) => (
              <li key={i.id}>
                <label className="flex items-center gap-2 rounded px-1 py-0.5 hover:bg-paper-3">
                  <input
                    type="checkbox"
                    checked={!hiddenParts.has(i.id)}
                    onChange={(e) => {
                      const next = new Set(hiddenParts);
                      if (e.target.checked) next.delete(i.id);
                      else next.add(i.id);
                      setUi({ hiddenParts: next });
                    }}
                  />
                  {i.name}
                </label>
              </li>
            ))}
          </ul>
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}

/** The roll's legend. */
function RollKey() {
  return (
    <Popover.Root>
      <Popover.Trigger asChild>
        <button type="button" className="inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[11px] text-ink-3 hover:bg-paper-3 hover:text-ink">
          <Info size={12} aria-hidden /> Key
        </button>
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Content className="card z-50 w-72 space-y-1.5 p-3 text-[12px] text-ink-2" sideOffset={6} align="end">
          <p>Notes sit at their sounding pitch (note names on the left) and are colored by section.</p>
          <p className="flex items-center gap-2">
            <span className="h-3 w-0 border-l border-dashed border-ink" aria-hidden /> Dotted line: where the selected note plays now.
          </p>
          <p className="flex items-center gap-2">
            <span className="h-2 w-[3px] bg-ink-3" aria-hidden /> Tick at the top: a note&apos;s handle. Drag it to where you hear the note to place a marker.
          </p>
          <p className="flex items-center gap-2">
            <MarkerGlyph state="applied" /> Applied marker (timing uses it).
          </p>
          <p className="flex items-center gap-2">
            <MarkerGlyph state="pending" /> Pending marker: recompute to apply.
          </p>
          <p className="flex items-center gap-2">
            <MarkerGlyph state="deleted" /> Deleted marker: still used until a recompute.
          </p>
          <p className="text-ink-3">Ctrl/Cmd + wheel or − / = zoom; wheel or , / . pan; Shift + wheel or ↑ / ↓ scroll pitch.</p>
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}
