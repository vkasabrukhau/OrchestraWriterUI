"use client";

import { useEffect, useMemo, useState } from "react";
import type { InfoMap } from "@/shared/info-map";
import { api } from "@/lib/api";
import { usePlayback } from "@/lib/store/playback";
import { useProjectTiming } from "@/lib/store/useProjectTiming";
import { EngravedScore, type NoteSpot, type ScoreMarker } from "./EngravedScore";
import { spotText } from "./bars";
import { ScoreStrip } from "./ScoreStrip";

type XmlState = { status: "loading" } | { status: "ready"; xml: string } | { status: "unavailable" };

/**
 * The score panel: engraved notation from the uploaded MusicXML when it can
 * be loaded and drawn, otherwise the schematic ScoreStrip (no score file,
 * the mock API, or a file OSMD cannot read). Clicking a note makes it the
 * start point (the playback store's `cue`) without moving playback; on Sync
 * it also selects the note for a marker (`onPick`). A double click plays from
 * the note. The passage being repeated lives in the playback store
 * (transport time) and is shown here in score time.
 */
export function ScoreView({
  projectId,
  infoMap,
  currentMeasure,
  onSeekMeasure,
  reducedMotion,
  visibleParts,
  confidence,
  maxParts,
  mode = "play",
  markers,
  onMarkerPress,
  onSpotContextMenu,
  onPick,
  fill,
  className,
}: {
  projectId: string;
  infoMap: InfoMap;
  currentMeasure: number;
  /** bar clicks in the schematic fallback */
  onSeekMeasure: (measure: number) => void;
  reducedMotion?: boolean;
  visibleParts?: Set<string>;
  confidence?: Map<number, number>;
  /** rows in the schematic fallback */
  maxParts?: number;
  mode?: "play" | "sync";
  markers?: ScoreMarker[];
  onMarkerPress?: (id: string, el: HTMLElement) => void;
  onSpotContextMenu?: (spot: NoteSpot, at: { x: number; y: number }) => void;
  /** called when a note becomes the start point (Sync selects it) */
  onPick?: (spot: NoteSpot) => void;
  /** fill the parent's height */
  fill?: boolean;
  className?: string;
}) {
  const [state, setState] = useState<XmlState>({ status: "loading" });
  const [engraveError, setEngraveError] = useState<string | null>(null);
  const { clock, toTransport, toScore } = useProjectTiming();
  const cue = usePlayback((s) => s.cue);
  const cueSpot = useMemo(() => (cue ? { measure: cue.measure, position: cue.position } : null), [cue]);
  const duration = usePlayback((s) => s.duration);
  const transportRange = usePlayback((s) => s.range);
  const range = useMemo(
    () => (transportRange ? { start: toScore(transportRange.start), end: toScore(transportRange.end) } : null),
    [transportRange, toScore],
  );

  // one score per mount: callers key this component by project
  useEffect(() => {
    let cancelled = false;
    api
      .fetchScoreXml(projectId)
      .then((xml) => !cancelled && setState(xml ? { status: "ready", xml } : { status: "unavailable" }))
      .catch((err: unknown) => {
        if (cancelled) return;
        console.warn("[score] could not load the score file:", err instanceof Error ? err.message : err);
        setState({ status: "unavailable" });
      });
    return () => {
      cancelled = true;
    };
  }, [projectId]);

  const setCue = (measure: number, position: number, at: number) =>
    usePlayback.getState().setCue({ at, measure, position, label: spotText(infoMap, measure, position) });

  if (state.status === "loading") return <p className="px-1 py-6 text-[12px] text-ink-3">Loading the score…</p>;

  if (state.status === "ready" && !engraveError) {
    return (
      <EngravedScore
        key={projectId}
        xml={state.xml}
        infoMap={infoMap}
        currentMeasure={currentMeasure}
        clock={clock}
        reducedMotion={reducedMotion}
        visibleParts={visibleParts}
        confidence={confidence}
        mode={mode}
        markers={markers}
        onMarkerPress={onMarkerPress}
        onSpotContextMenu={onSpotContextMenu ? (spot, at) => onSpotContextMenu({ measure: spot.measure, position: spot.position }, at) : undefined}
        cue={cueSpot}
        range={range}
        durationSec={duration}
        onPick={({ measure, position, scoreTime }) => {
          setCue(measure, position, toTransport(scoreTime));
          onPick?.({ measure, position });
        }}
        onPlayFrom={({ measure, position, scoreTime }) => {
          setCue(measure, position, toTransport(scoreTime));
          onPick?.({ measure, position });
          usePlayback.getState().playFromCue();
        }}
        onGoTo={(place) => {
          const scoreTime = place.kind === "bar" ? place.scoreTime : toScore(place.sec);
          const m = infoMap.measures.find((mm, k) => scoreTime < mm.startTime + mm.duration || k === infoMap.measures.length - 1);
          if (!m) return null;
          const position = m.duration > 0 ? Math.max(0, Math.min(0.9999, (scoreTime - m.startTime) / m.duration)) : 0;
          setCue(m.number, position, place.kind === "bar" ? toTransport(scoreTime) : place.sec);
          onPick?.({ measure: m.number, position });
          return m.number;
        }}
        onRange={(r) => usePlayback.getState().setRange(r ? { start: toTransport(r.start), end: toTransport(r.end) } : null)}
        className={className}
        fill={fill}
        onError={(message) => {
          console.warn("[score] engraving failed, showing the schematic view:", message);
          setEngraveError(message);
        }}
      />
    );
  }

  return (
    <div className={className}>
      <ScoreStrip infoMap={infoMap} currentMeasure={currentMeasure} onSeekMeasure={onSeekMeasure} visibleParts={visibleParts} confidence={confidence} maxParts={maxParts} />
      {engraveError && <p className="px-1 pt-2 text-[11px] text-ink-3">This file could not be engraved, so a simplified view is shown.</p>}
    </div>
  );
}
