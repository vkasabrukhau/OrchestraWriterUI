"use client";

import { useEffect, useMemo, useRef } from "react";
import { AlertCircle, Pause, Play, Repeat, SkipBack, SkipForward, Volume2, VolumeX, X } from "lucide-react";
import { usePlayback } from "@/lib/store/playback";
import { useProject } from "@/lib/store/project";
import { useProjectTiming } from "@/lib/store/useProjectTiming";
import { noteOnsets, stepBar, stepOnset } from "@/lib/score/navigation";
import { formatTime, cx } from "@/lib/utils/format";
import { Button } from "@/components/ui/Button";
import { Tooltip } from "@/components/ui/Tooltip";
import { Waveform } from "./Waveform";

/** Drives the playback clock. Mount once per page that plays. */
export function PlaybackClock() {
  useEffect(() => {
    let raf = 0;
    let last = performance.now();
    const loop = (now: number) => {
      const dt = (now - last) / 1000;
      last = now;
      usePlayback.getState().tick(Math.min(dt, 0.25));
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
  }, []);
  return null;
}

/**
 * Keyboard shortcuts shared by Sync, Customize and Preview. With a score,
 * arrows move note by note (the onsets of the visible parts) and Cmd/Ctrl +
 * arrows bar by bar, like Soundslice and MuseScore; Shift + arrows skip 5 s.
 * Space plays or pauses at the playhead; Enter plays from the start point.
 */
export function PlaybackShortcuts() {
  const infoMap = useProject((s) => s.infoMap);
  const visible = useProject((s) => s.display?.visibleParts);
  const { toScore, toTransport } = useProjectTiming();
  const onsets = useMemo(() => (infoMap ? noteOnsets(infoMap, visible && visible.length > 0 ? new Set(visible) : undefined) : []), [infoMap, visible]);
  const nav = useRef({ infoMap, onsets, toScore, toTransport });
  useEffect(() => {
    nav.current = { infoMap, onsets, toScore, toTransport };
  });

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const el = e.target as HTMLElement | null;
      if (el && (el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.tagName === "SELECT" || el.isContentEditable)) return;
      // the score overview handles its own arrows
      if (el?.getAttribute("role") === "slider") return;
      const p = usePlayback.getState();
      const { infoMap: map, onsets: list, toScore: ts, toTransport: tt } = nav.current;
      if (e.code === "Space") {
        e.preventDefault();
        p.toggle();
      } else if (e.key === "ArrowLeft" || e.key === "ArrowRight") {
        const dir = e.key === "ArrowRight" ? 1 : -1;
        e.preventDefault();
        if (e.shiftKey || !map) {
          p.skip(dir * 5);
          return;
        }
        const now = ts(p.time);
        const target = e.metaKey || e.ctrlKey ? stepBar(map.measures, now, dir) : stepOnset(list, now, dir, p.playing ? 0.25 : 0.02);
        p.seek(tt(target));
      } else if (e.key === "Enter" && p.cue && !(el && (el.tagName === "BUTTON" || el.tagName === "A" || el.getAttribute("role") === "button"))) {
        e.preventDefault();
        p.playFromCue();
      } else if (e.key === "Home") {
        p.seek(p.range?.start ?? 0);
      } else if (e.key === "m" || e.key === "M") {
        p.toggleMute();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);
  return null;
}

export function Transport({
  peaks,
  onStage,
  className,
  compact,
  measureLabel,
  positionLabel,
  markers,
  scrubber,
}: {
  peaks: number[];
  onStage?: boolean;
  className?: string;
  compact?: boolean;
  /** "Bar 42 / 502" */
  measureLabel?: string;
  /** a live readout from the transport time ("Bar 42 · beat 3 / 502"); wins over measureLabel */
  positionLabel?: (time: number) => string;
  markers?: Array<{ at: number; color?: string; strong?: boolean }>;
  /** false: no waveform scrubber (the Sync page draws its own, zoomable) */
  scrubber?: boolean;
}) {
  const playing = usePlayback((s) => s.playing);
  const time = usePlayback((s) => s.time);
  const duration = usePlayback((s) => s.duration);
  const rate = usePlayback((s) => s.rate);
  const muted = usePlayback((s) => s.muted);
  const loop = usePlayback((s) => s.loop);
  const range = usePlayback((s) => s.range);
  const cue = usePlayback((s) => s.cue);
  const hasEngine = usePlayback((s) => s.engine !== null);
  const ready = usePlayback((s) => s.ready);
  const error = usePlayback((s) => s.error);
  // speed is for listening to the real recording only (never generated playback, alignment or export)
  const recording = usePlayback((s) => s.engine?.kind === "recording");
  const { toggle, seek, skip, setRate, toggleMute, toggleLoop, setRange, setCue, playFromCue } = usePlayback.getState();
  // offer the start point when playing from it would not just continue from here
  const offerCue = cue !== null && Math.abs(cue.at - time) > 0.05;
  const readout = positionLabel ? positionLabel(time) : measureLabel;
  const loading = hasEngine && !ready && !error;
  const unavailable = hasEngine && !ready && !!error;
  const text = onStage ? "text-stage-text" : "text-ink";
  const muted2 = onStage ? "text-stage-text-2" : "text-ink-3";

  return (
    <div className={cx("@container", className)}>
    <div className="flex flex-wrap items-center gap-x-3 gap-y-3 md:gap-x-4">
      <PlaybackClock />
      <PlaybackShortcuts />
      {!compact && (
        <Tooltip label="Back 5 s (Shift ←). ← and → step note by note">
          <Button variant={onStage ? "stage" : "ghost"} size="icon-sm" aria-label="Back 5 seconds" onClick={() => skip(-5)}>
            <SkipBack size={15} />
          </Button>
        </Tooltip>
      )}
      <Tooltip label={playing ? "Pause (space)" : "Play from the playhead (space)"}>
        <button
          type="button"
          onClick={toggle}
          disabled={unavailable}
          aria-label={playing ? "Pause" : "Play"}
          aria-busy={loading || undefined}
          className={cx(
            "grid h-11 w-11 shrink-0 place-items-center rounded-full shadow-md transition-transform active:scale-95 disabled:opacity-40 disabled:active:scale-100",
            onStage ? "bg-stage-text text-stage" : "bg-ink text-paper",
          )}
        >
          {playing ? <Pause size={17} fill="currentColor" /> : <Play size={17} fill="currentColor" className="translate-x-[1px]" />}
        </button>
      </Tooltip>
      {!compact && (
        <Tooltip label="Forward 5 s (Shift →). Cmd/Ctrl + arrows step by bar">
          <Button variant={onStage ? "stage" : "ghost"} size="icon-sm" aria-label="Forward 5 seconds" onClick={() => skip(5)}>
            <SkipForward size={15} />
          </Button>
        </Tooltip>
      )}
      <span className={cx("tnum text-[13px] w-11 shrink-0", text)}>{formatTime(time)}</span>
      {offerCue && cue && (
        <span className={cx("flex shrink-0 items-center rounded-full text-[12px]", onStage ? "bg-white/10 text-stage-text" : "bg-paper-3 text-ink-2")}>
          <Tooltip label="Play from the start point (Enter)">
            <button type="button" onClick={playFromCue} className="flex items-center gap-1.5 rounded-full py-1 pl-2.5 pr-1.5 hover:text-ink" aria-label={`Play from ${cue.label}`}>
              <Play size={11} fill="currentColor" aria-hidden />
              <span className="tnum">From {cue.label}</span>
            </button>
          </Tooltip>
          <button type="button" onClick={() => setCue(null)} className="mr-1 rounded-full p-0.5 opacity-60 hover:opacity-100" aria-label="Clear the start point">
            <X size={11} />
          </button>
        </span>
      )}
      {scrubber === false ? <span className="flex-1" /> : <Waveform peaks={peaks} progress={duration ? time / duration : 0} onSeek={(f) => seek(f * duration)} onStage={onStage} className="min-w-[200px] flex-1 @max-3xl:order-last @max-3xl:basis-full" markers={markers} />}
      <span className={cx("tnum text-[13px] w-11 shrink-0 text-right", muted2)}>{formatTime(duration)}</span>
      {readout && <span className={cx("hidden tnum text-[12.5px] shrink-0 @xl:inline", muted2)}>{readout}</span>}
      {!compact && (
        <div className="hidden md:flex items-center gap-1">
          {recording && (
            <Tooltip label="Listening speed of the recording (does not change the sync or the export)">
              <button
                type="button"
                onClick={() => setRate(rate === 1 ? 0.75 : rate === 0.75 ? 0.5 : 1)}
                className={cx("tnum h-8 rounded-full px-2.5 text-[12px] font-medium", onStage ? "text-stage-text-2 hover:bg-white/10" : "text-ink-3 hover:bg-paper-3")}
                aria-label={`Playback speed ${rate}×`}
              >
                {rate}×
              </button>
            </Tooltip>
          )}
          <Tooltip label={muted ? "Unmute (m)" : "Mute (m)"}>
            <Button variant={onStage ? "stage" : "ghost"} size="icon-sm" aria-label={muted ? "Unmute" : "Mute"} onClick={toggleMute}>
              {muted ? <VolumeX size={15} /> : <Volume2 size={15} />}
            </Button>
          </Tooltip>
          <Tooltip label={range ? "Stop repeating the passage" : "Loop the piece (Shift-click two notes in the score to repeat a passage)"}>
            <Button
              variant={onStage ? "stage" : "ghost"}
              size="icon-sm"
              aria-label={range ? "Stop repeating the passage" : "Loop"}
              aria-pressed={loop || !!range}
              onClick={() => (range ? setRange(null) : toggleLoop())}
              className={loop || range ? "text-brass" : ""}
            >
              <Repeat size={15} />
            </Button>
          </Tooltip>
        </div>
      )}
    </div>
    {(loading || error) && (
      <p
        role={error ? "alert" : "status"}
        className={cx("mt-2 flex items-center gap-1.5 text-[12px]", error ? "text-danger" : muted2)}
      >
        {error && <AlertCircle size={13} aria-hidden className="shrink-0" />}
        {error ?? "Loading audio…"}
      </p>
    )}
    </div>
  );
}
