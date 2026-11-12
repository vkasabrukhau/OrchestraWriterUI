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

/** Widgets that use Space, the arrow keys and Home themselves (menus, sliders, lists, tabs, dialogs). */
const WIDGETS =
  '[role="menu"], [role="menubar"], [role="dialog"], [role="alertdialog"], [role="slider"], [role="listbox"], [role="radiogroup"], [role="tablist"], [role="spinbutton"], [role="combobox"], [role="tree"], [role="grid"]';
/** Controls that Space activates. */
const SPACE_CONTROLS = 'button, [role="button"], [role="switch"], [role="checkbox"], summary';

function focusVisible(el: Element): boolean {
  try {
    return el.matches(":focus-visible");
  } catch {
    return false;
  }
}

/**
 * Does the focused element handle this key itself? Then the playback
 * shortcut must not also run (Space on Playback > Play would toggle twice).
 */
export function elementOwnsKey(el: Element | null, e: Pick<KeyboardEvent, "key" | "code">): boolean {
  if (!el || el === document.body) return false;
  const h = el as HTMLElement;
  if (h.tagName === "INPUT" || h.tagName === "TEXTAREA" || h.tagName === "SELECT" || h.isContentEditable) return true;
  if (el.closest(WIDGETS)) return true;
  // A button reached with the keyboard keeps its Space. After a mouse click
  // the button keeps focus too, but Space still means play/pause there.
  if (e.code === "Space" && el.closest(SPACE_CONTROLS) && focusVisible(el)) return true;
  return false;
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
      if (e.defaultPrevented || e.isComposing || e.altKey) return;
      // Cmd/Ctrl only with the arrows (bar steps); other combinations belong to the editor and the browser
      if ((e.metaKey || e.ctrlKey) && e.key !== "ArrowLeft" && e.key !== "ArrowRight") return;
      const el = e.target instanceof HTMLElement ? e.target : null;
      // focused widgets (inputs, menus, sliders such as the score overview, …) handle their own keys
      if (elementOwnsKey(el, e)) return;
      const p = usePlayback.getState();
      const { infoMap: map, onsets: list, toScore: ts, toTransport: tt } = nav.current;
      if (e.code === "Space") {
        e.preventDefault();
        if (!e.repeat) p.toggle();
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
        e.preventDefault();
        p.seek(p.range?.start ?? 0);
      } else if ((e.key === "m" || e.key === "M") && !e.repeat) {
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

/** 1:05.230 */
export function formatPrecise(sec: number): string {
  const s = Math.max(0, sec);
  const m = Math.floor(s / 60);
  const rest = s - m * 60;
  return `${m}:${rest.toFixed(3).padStart(6, "0")}`;
}

/**
 * The transport in the editor chrome (ADR 0022): one compact row with square
 * tool buttons, precise time, a slim scrubber and the audio source. Same
 * clock and keyboard shortcuts as `Transport`; mount one or the other.
 */
export function EditorTransport({
  peaks,
  className,
  measureLabel,
  sourceLabel,
}: {
  peaks: number[];
  className?: string;
  /** "Bar 18 / 56" */
  measureLabel?: string;
  /** "Uploaded recording" / "Generated from score" */
  sourceLabel?: string;
}) {
  const playing = usePlayback((s) => s.playing);
  const time = usePlayback((s) => s.time);
  const duration = usePlayback((s) => s.duration);
  const rate = usePlayback((s) => s.rate);
  const muted = usePlayback((s) => s.muted);
  const loop = usePlayback((s) => s.loop);
  const hasEngine = usePlayback((s) => s.engine !== null);
  const ready = usePlayback((s) => s.ready);
  const error = usePlayback((s) => s.error);
  const { toggle, seek, skip, setRate, toggleMute, toggleLoop } = usePlayback.getState();
  const loading = hasEngine && !ready && !error;
  const unavailable = hasEngine && !ready && !!error;
  const icon = "grid h-7 w-7 shrink-0 place-items-center rounded-[var(--radius-sm)] text-ink-2 hover:bg-paper-3 hover:text-ink";

  return (
    // narrow windows: the scrubber gets its own row under the buttons
    <div className={cx("flex flex-wrap items-center gap-x-1.5 gap-y-1 px-4 py-1.5 sm:h-12 sm:flex-nowrap sm:py-0", className)}>
      <PlaybackClock />
      <PlaybackShortcuts />
      <Tooltip label="Back 5 s (←)">
        <button type="button" className={icon} aria-label="Back 5 seconds" onClick={() => skip(-5)}>
          <SkipBack size={14} />
        </button>
      </Tooltip>
      <Tooltip label={playing ? "Pause (space)" : "Play (space)"}>
        <button
          type="button"
          onClick={toggle}
          disabled={unavailable}
          aria-label={playing ? "Pause" : "Play"}
          aria-busy={loading || undefined}
          className="mx-0.5 grid h-8 w-8 shrink-0 place-items-center rounded-full bg-brass text-white transition-transform hover:bg-brass-3 active:scale-95 disabled:opacity-40"
        >
          {playing ? <Pause size={14} fill="currentColor" /> : <Play size={14} fill="currentColor" className="translate-x-[1px]" />}
        </button>
      </Tooltip>
      <Tooltip label="Forward 5 s (→)">
        <button type="button" className={icon} aria-label="Forward 5 seconds" onClick={() => skip(5)}>
          <SkipForward size={14} />
        </button>
      </Tooltip>
      <Tooltip label="Loop">
        <button type="button" className={cx(icon, loop && "bg-brass-soft text-brass-3")} aria-label="Loop" aria-pressed={loop} onClick={toggleLoop}>
          <Repeat size={14} />
        </button>
      </Tooltip>
      <span className="mx-2 hidden h-5 w-px shrink-0 bg-line sm:block" aria-hidden />
      <span className="tnum w-[4.6rem] shrink-0 text-[13px] font-semibold text-ink">{formatPrecise(time)}</span>
      <span className="tnum shrink-0 text-[11px] text-ink-3">/ {formatPrecise(duration)}</span>
      <Waveform peaks={peaks} progress={duration ? time / duration : 0} onSeek={(f) => seek(f * duration)} height={26} className="order-last min-w-[120px] flex-1 basis-full sm:order-none sm:mx-3 sm:basis-auto" />
      {measureLabel && <span className="tnum hidden shrink-0 text-[11.5px] text-ink-2 md:inline">{measureLabel}</span>}
      <Tooltip label="Playback speed">
        <button
          type="button"
          onClick={() => setRate(rate === 1 ? 0.75 : rate === 0.75 ? 0.5 : 1)}
          className="tnum h-7 shrink-0 rounded-[var(--radius-sm)] px-2 text-[11.5px] font-medium text-ink-2 hover:bg-paper-3"
        >
          {rate}×
        </button>
      </Tooltip>
      <Tooltip label={muted ? "Unmute (m)" : "Mute (m)"}>
        <button type="button" className={icon} aria-label={muted ? "Unmute" : "Mute"} onClick={toggleMute}>
          {muted ? <VolumeX size={14} /> : <Volume2 size={14} />}
        </button>
      </Tooltip>
      {(loading || error) ? (
        <span role={error ? "alert" : "status"} title={error ?? undefined} className={cx("flex min-w-0 max-w-[16rem] items-center gap-1 text-[11.5px]", error ? "text-danger" : "text-ink-3")}>
          {error && <AlertCircle size={12} aria-hidden className="shrink-0" />}
          <span className="truncate">{error ?? "Loading audio…"}</span>
        </span>
      ) : (
        sourceLabel && <span className="hidden shrink-0 text-[11.5px] text-ink-3 lg:inline">{sourceLabel}</span>
      )}
    </div>
  );
}
