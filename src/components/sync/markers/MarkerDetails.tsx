"use client";

import { useState } from "react";
import { Crosshair, RotateCcw, Trash2, Navigation, ChevronLeft, ChevronRight } from "lucide-react";
import type { InfoMap } from "@/shared/info-map";
import { appliedOf, confidenceBand, markerBounds, markerPosition, pendingOf, type ManualMarker } from "@/shared/sync";
import { barOnsets } from "@/lib/score/stamps";
import { resolveGoTo } from "@/lib/score/navigation";
import { useProject } from "@/lib/store/project";
import { usePlayback } from "@/lib/store/playback";
import { mergedAlignment } from "@/lib/store/useProjectTiming";
import { formatTime } from "@/lib/utils/format";
import { Button } from "@/components/ui/Button";
import { Input } from "@/components/ui/Field";
import { Collapsible } from "@/components/ui/Collapsible";
import { spotText } from "@/components/music/bars";
import { useMarkerCommands } from "./useMarkerCommands";
import { markerTitle, pendingRanges, recomputeLabel } from "./markerName";
import { RUN_LOCK_REASON, useSyncActions } from "../workspace/SyncActions";

const NUDGES_MS = [-100, -10, 10, 100];

/** Parse "83456", "83.456 s" is not supported; "1:23.456" or plain milliseconds. */
export function parseTimeField(text: string): number | null {
  const t = text.trim();
  if (!t) return null;
  const m = /^(\d+):(\d{1,2}(?:\.\d+)?)$/.exec(t);
  if (m) return Number(m[1]) * 60 + Number(m[2]);
  const ms = Number(t);
  return Number.isFinite(ms) ? ms / 1000 : null;
}

/**
 * Everything about one marker: its name, time, note, status (applied or
 * pending) and actions. Edits make it pending; nothing audible changes until
 * a recompute (ADR 0018).
 */
export function MarkerDetails({ infoMap, marker, onClose }: { infoMap: InfoMap; marker: ManualMarker; onClose?: () => void }) {
  const sync = useProject((s) => s.sync)!;
  const cmd = useMarkerCommands();
  const { recompute, running, jumpTo, durationSec } = useSyncActions();
  const [name, setName] = useState(marker.label ?? "");
  const [nameFor, setNameFor] = useState(marker.id);
  const [timeField, setTimeField] = useState("");
  const [barField, setBarField] = useState("");
  const [advanced, setAdvanced] = useState(false);
  const [error, setError] = useState<string | null>(null);
  if (nameFor !== marker.id) {
    setNameFor(marker.id);
    setName(marker.label ?? "");
    setError(null);
  }

  const applied = appliedOf(sync);
  const pendingItem = pendingOf(sync.manual, applied).find((p) => p.id === marker.id);
  const merged = mergedAlignment(sync);
  const unhonoured = merged.unhonoured.includes(marker.id);
  const position = markerPosition(marker);
  const auto = sync.auto.find((a) => a.n === marker.measure);
  const conf = auto?.confidence ?? 0;
  const band = confidenceBand(conf);
  const where = spotText(infoMap, marker.measure, position, true);
  const landing = (() => {
    const a = merged.aligned[marker.measure - 1];
    if (!a) return null;
    const next = merged.aligned[marker.measure];
    return a.startSec + position * ((next?.startSec ?? a.startSec) - a.startSec);
  })();
  const ranges = pendingItem ? pendingRanges([pendingItem], infoMap.measures.length) : [];

  const report = (r: ReturnType<typeof cmd.update>) => setError(r && !r.ok ? r.message : null);
  const moveTo = (startSec: number) => report(cmd.update(marker.id, { startSec }, "Marker moved"));
  const bounds = markerBounds(sync.auto, sync.manual, { measure: marker.measure, position }, { excludeId: marker.id, durationSec: durationSec || Infinity });

  const stepNote = (dir: -1 | 1) => {
    const onsets = barOnsets(infoMap, marker.measure);
    const i = onsets.findIndex((o) => Math.abs(o - position) < 1e-6);
    let measure = marker.measure;
    let pos: number | undefined;
    if (dir > 0 && i + 1 < onsets.length) pos = onsets[i + 1];
    else if (dir < 0 && i > 0) pos = onsets[i - 1];
    else {
      measure = marker.measure + dir;
      if (measure < 1 || measure > infoMap.measures.length) return;
      const list = barOnsets(infoMap, measure);
      pos = dir > 0 ? list[0] : list[list.length - 1];
    }
    report(cmd.update(marker.id, { measure, position: pos ?? 0 }, "Marker moved to another note"));
  };

  const disabled = running;
  return (
    <div className="w-[300px] space-y-3 text-[13px]" aria-label={`Marker details: ${markerTitle(infoMap, marker)}`}>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          if ((marker.label ?? "") !== name.trim()) cmd.rename(marker.id, name);
        }}
      >
        <label className="mb-1 block text-[11px] text-ink-3" htmlFor={`mk-name-${marker.id}`}>
          Name
        </label>
        <Input
          id={`mk-name-${marker.id}`}
          value={name}
          placeholder={where}
          maxLength={120}
          disabled={disabled}
          onChange={(e) => setName(e.target.value)}
          onBlur={() => {
            if ((marker.label ?? "") !== name.trim()) cmd.rename(marker.id, name);
          }}
          onKeyDown={(e) => {
            if (e.key === "Escape" && name !== (marker.label ?? "")) {
              e.stopPropagation();
              setName(marker.label ?? "");
            }
          }}
          className="h-8"
        />
      </form>

      <div>
        <p className="text-[11px] text-ink-3">Note</p>
        <div className="mt-1 flex items-center gap-1.5">
          <Button variant="ghost" size="icon-sm" aria-label="Previous note" onClick={() => stepNote(-1)} disabled={disabled}>
            <ChevronLeft size={14} />
          </Button>
          <span className="tnum flex-1 text-ink">{where}</span>
          <Button variant="ghost" size="icon-sm" aria-label="Next note" onClick={() => stepNote(1)} disabled={disabled}>
            <ChevronRight size={14} />
          </Button>
        </div>
        <form
          className="mt-1.5 flex gap-1.5"
          onSubmit={(e) => {
            e.preventDefault();
            const g = resolveGoTo(barField, infoMap, marker.measure, durationSec);
            if (g.kind !== "bar") {
              setError(g.kind === "error" ? g.message : "Enter a bar number or a rehearsal mark.");
              return;
            }
            report(cmd.update(marker.id, { measure: g.measure, position: 0 }, "Marker moved to another bar"));
            setBarField("");
          }}
        >
          <Input value={barField} onChange={(e) => setBarField(e.target.value)} placeholder="Move to bar…" className="h-8" aria-label="Move the marker to bar" disabled={disabled} />
          <Button type="submit" variant="outline" size="sm" className="h-8" disabled={disabled}>
            Move
          </Button>
        </form>
      </div>

      <div>
        <p className="text-[11px] text-ink-3">
          Time in the recording <span className="tnum text-ink">{formatTime(marker.startSec, true)}</span>
        </p>
        <div className="mt-1 grid grid-cols-4 gap-1" role="group" aria-label="Nudge the marker">
          {NUDGES_MS.map((ms) => (
            <Button key={ms} variant="secondary" size="sm" className="tnum h-8" onClick={() => moveTo(marker.startSec + ms / 1000)} disabled={disabled}>
              {ms > 0 ? `+${ms}` : ms} ms
            </Button>
          ))}
        </div>
        <Button variant="outline" size="sm" className="mt-1.5 w-full" leading={<Crosshair size={13} />} onClick={() => moveTo(usePlayback.getState().time)} disabled={disabled}>
          Set to playhead
        </Button>
        <Collapsible open={advanced} onOpenChange={setAdvanced} trigger="Advanced" className="mt-2" triggerClassName="text-[12px] text-ink-3">
          <form
            className="mt-1.5 flex gap-1.5"
            onSubmit={(e) => {
              e.preventDefault();
              const t = parseTimeField(timeField);
              if (t === null) return setError("Enter a time as milliseconds or m:ss.mmm.");
              moveTo(t);
              setTimeField("");
            }}
          >
            <Input value={timeField} onChange={(e) => setTimeField(e.target.value)} placeholder={String(Math.round(marker.startSec * 1000))} className="tnum h-8" aria-label="Time in the recording (ms or m:ss.mmm)" disabled={disabled} />
            <Button type="submit" variant="outline" size="sm" className="h-8" disabled={disabled}>
              Set
            </Button>
          </form>
          {Number.isFinite(bounds.high) && bounds.high >= bounds.low && (
            <p className="mt-1 text-[11px] text-ink-3">
              Between {formatTime(bounds.low, true)} and {formatTime(bounds.high, true)}
            </p>
          )}
        </Collapsible>
      </div>

      <div className="rounded-md bg-paper-2 px-2.5 py-2 text-[12px]" aria-live="polite">
        {pendingItem ? (
          <>
            <p className="text-ink">
              <span className="font-medium text-brass-3">Pending:</span> recompute to apply
              {landing !== null && <span className="text-ink-3"> (now plays at {formatTime(landing, true)})</span>}
            </p>
            {ranges.length > 0 && (
              <Button size="sm" className="mt-1.5" onClick={() => recompute(ranges)} disabled={disabled}>
                {recomputeLabel(ranges, 1).replace(/ to apply .*/, "")}
              </Button>
            )}
          </>
        ) : (
          <p className="text-ink">Applied.</p>
        )}
        <p className="mt-1 text-ink-3">
          Confidence {conf}% · {band.label} (from the last sync)
        </p>
        {unhonoured && <p className="mt-1 text-danger">This marker is too close to its neighbour to keep exactly. Move one of them.</p>}
      </div>

      {error && (
        <p className="text-[12px] text-danger" role="alert">
          {error}
        </p>
      )}
      {running && <p className="text-[12px] text-ink-3">{RUN_LOCK_REASON}</p>}

      <div className="flex flex-wrap gap-1.5">
        <Button variant="outline" size="sm" leading={<Navigation size={13} />} onClick={() => jumpTo({ measure: marker.measure, position })}>
          Jump to
        </Button>
        {pendingItem && (
          <Button variant="outline" size="sm" leading={<RotateCcw size={13} />} onClick={() => cmd.revert(marker.id)} disabled={disabled}>
            Revert
          </Button>
        )}
        <Button
          variant="ghost"
          size="sm"
          className="text-danger"
          leading={<Trash2 size={13} />}
          onClick={() => {
            cmd.remove(marker.id);
            onClose?.();
          }}
          disabled={disabled}
        >
          Delete
        </Button>
      </div>
    </div>
  );
}
