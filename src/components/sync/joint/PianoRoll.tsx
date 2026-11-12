"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { InfoMap } from "@/shared/info-map";
import type { DisplaySettings } from "@/shared/project-file";
import { appliedOf, markerBounds, markerPosition, sameMarkerSpot, type ManualMarker, type MeasureAlignment } from "@/shared/sync";
import { useProject } from "@/lib/store/project";
import { usePlayback } from "@/lib/store/playback";
import { useSyncUi } from "@/lib/store/sync-ui";
import { levelFor, type PeakPyramid } from "@/lib/audio/peaks";
import { buildRollIndex, nearestOnset, onsetsInWindow, pitchTicks, queryWindow, zoomAt, type RollOnset } from "@/lib/sync/roll";
import { formatTime } from "@/lib/utils/format";
import { spotText } from "@/components/music/bars";
import { markerAccessibleName, type MarkerState } from "../markers/markerName";
import { useMarkerCommands } from "../markers/useMarkerCommands";
import { RUN_LOCK_REASON, useSyncActions } from "../workspace/SyncActions";

const GUTTER = 40;
const HANDLES = 20;
const DRAG_PX = 4;
const MIN_SPAN = 1;

interface Pin {
  id: string;
  measure: number;
  position: number;
  /** where it is drawn (intended time; the applied time for a pending deletion) */
  at: number;
  state: MarkerState;
  marker: ManualMarker;
}

type Drag =
  | { kind: "pin"; pin: Pin; startX: number; startAt: number; at: number; low: number; high: number; moved: boolean }
  | { kind: "onset"; onset: RollOnset; startX: number; startAt: number; at: number; low: number; high: number; moved: boolean };

/**
 * Joint playback (owner: "note time playback / section follower"): the
 * score's notes by sounding pitch over the recording's clock, colored by
 * section, over the recording's waveform. Each onset has a handle at the top;
 * dragging it to where the note really sounds places a pending marker
 * (nothing audible changes until a recompute). The dotted line from the
 * selected note runs down through the waveform to where it plays now.
 */
export function PianoRoll({
  infoMap,
  aligned,
  display,
  durationSec,
  pyramid,
  peaks,
  hiddenSections,
  hiddenParts,
}: {
  infoMap: InfoMap;
  aligned: MeasureAlignment[];
  display: DisplaySettings | null;
  durationSec: number;
  pyramid: PeakPyramid | null;
  /** overview peaks (0–1) when the detailed ones are not available */
  peaks: number[] | null;
  hiddenSections: Set<string>;
  hiddenParts: Set<string>;
}) {
  const sync = useProject((s) => s.sync)!;
  const selected = useSyncUi((s) => s.selected);
  const follow = useSyncUi((s) => s.follow);
  const cmd = useMarkerCommands();
  const { running, select, durationSec: dur } = useSyncActions();
  const wrapRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const headRef = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState({ w: 600, h: 240 });
  const [view, setView] = useState(() => {
    const t = usePlayback.getState().time;
    return { t0: Math.max(0, t - 4), t1: Math.max(0, t - 4) + 20 };
  });
  const [pitchView, setPitchView] = useState<{ lo: number; hi: number } | null>(null);
  /** the waveform's height (the line above it is draggable) and its vertical zoom */
  const [waveH, setWaveH] = useState(56);
  const [gain, setGain] = useState(1);
  const WAVE = Math.max(24, Math.min(waveH, size.h - HANDLES - 40));
  const dragRef = useRef<Drag | null>(null);
  const [dragTick, setDragTick] = useState(0);
  const [boundMsg, setBoundMsg] = useState<string | null>(null);

  const index = useMemo(() => buildRollIndex(infoMap, aligned, display), [infoMap, aligned, display]);
  const pins = useMemo<Pin[]>(() => {
    const applied = appliedOf(sync);
    const byId = new Map(applied.map((m) => [m.id, m]));
    const out: Pin[] = sync.manual.map((m) => {
      const a = byId.get(m.id);
      const same = a && a.measure === m.measure && markerPosition(a) === markerPosition(m) && Math.abs(a.startSec - m.startSec) < 1e-9;
      return { id: m.id, measure: m.measure, position: markerPosition(m), at: m.startSec, state: same ? "applied" : "pending", marker: m };
    });
    const ids = new Set(sync.manual.map((m) => m.id));
    for (const a of applied) if (!ids.has(a.id)) out.push({ id: a.id, measure: a.measure, position: markerPosition(a), at: a.startSec, state: "deleted", marker: a });
    return out;
  }, [sync]);

  const pitchLo = pitchView?.lo ?? index.minPitch - 1;
  const pitchHi = pitchView?.hi ?? index.maxPitch + 1;
  const rollTop = HANDLES;
  const rollH = Math.max(40, size.h - HANDLES - WAVE);
  const waveTop = rollTop + rollH;
  const plotW = Math.max(10, size.w - GUTTER);
  const xOf = useCallback((t: number) => GUTTER + ((t - view.t0) / Math.max(1e-6, view.t1 - view.t0)) * plotW, [view, plotW]);
  const tOf = useCallback((x: number) => view.t0 + ((x - GUTTER) / plotW) * (view.t1 - view.t0), [view, plotW]);
  const yOf = (pitch: number) => rollTop + ((pitchHi - pitch) / Math.max(1, pitchHi - pitchLo)) * rollH;

  const landingOf = useCallback((measure: number, position: number) => {
    const a = aligned[measure - 1];
    if (!a) return null;
    const m = infoMap.measures[measure - 1];
    const onset = index.onsets.find((o) => o.measure === measure && Math.abs(o.position - position) < 1e-6);
    if (onset) return onset.at;
    const next = aligned[measure];
    return m ? a.startSec + position * ((next?.startSec ?? a.startSec + m.duration) - a.startSec) : a.startSec;
  }, [aligned, infoMap, index]);

  // size
  useEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setSize({ w: el.clientWidth, h: el.clientHeight }));
    ro.observe(el);
    setSize({ w: el.clientWidth, h: el.clientHeight });
    return () => ro.disconnect();
  }, []);

  // draw
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    canvas.width = Math.round(size.w * dpr);
    canvas.height = Math.round(size.h * dpr);
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    const css = getComputedStyle(canvas);
    const token = (name: string, fallback: string) => css.getPropertyValue(name).trim() || fallback;
    const ink3 = token("--ink-3", "#777");
    const line = token("--line", "#ddd");
    const paper2 = token("--paper-2", "#f4f1ea");
    const marker = token("--score-marker", "#8e6620");
    const pending = token("--marker-pending", "#7a5a1c");
    ctx.clearRect(0, 0, size.w, size.h);

    // pitch gutter and grid
    ctx.fillStyle = paper2;
    ctx.fillRect(0, 0, GUTTER, size.h);
    const pxPerSemi = rollH / Math.max(1, pitchHi - pitchLo);
    ctx.font = "10px Inter, system-ui, sans-serif";
    ctx.textBaseline = "middle";
    let lastLabelY = Infinity;
    for (const tick of pitchTicks(pitchLo, pitchHi, pxPerSemi)) {
      const y = yOf(tick.pitch);
      if (Math.abs(lastLabelY - y) < 11) continue;
      lastLabelY = y;
      ctx.fillStyle = ink3;
      ctx.fillText(tick.label, 4, y);
      ctx.strokeStyle = line;
      ctx.globalAlpha = 0.6;
      ctx.beginPath();
      ctx.moveTo(GUTTER, y + 0.5);
      ctx.lineTo(size.w, y + 0.5);
      ctx.stroke();
      ctx.globalAlpha = 1;
    }
    // bar lines
    ctx.strokeStyle = line;
    for (const a of aligned) {
      if (a.startSec < view.t0 || a.startSec > view.t1) continue;
      const x = Math.round(xOf(a.startSec)) + 0.5;
      ctx.beginPath();
      ctx.moveTo(x, rollTop);
      ctx.lineTo(x, waveTop);
      ctx.stroke();
    }

    // notes, colored by section
    const colors = display?.sectionColors ?? {};
    const h = Math.max(2, Math.min(10, pxPerSemi - 1));
    const notes = queryWindow(index, view.t0, view.t1);
    const dense = notes.length > plotW * 4;
    ctx.save();
    ctx.beginPath();
    ctx.rect(GUTTER, rollTop, plotW, rollH);
    ctx.clip();
    for (const n of notes) {
      if (hiddenSections.has(n.section) || hiddenParts.has(index.parts[n.part])) continue;
      if (n.pitch < pitchLo || n.pitch > pitchHi) continue;
      const x0 = xOf(n.start);
      const x1 = xOf(n.end);
      ctx.fillStyle = (colors as Record<string, string>)[n.section] ?? ink3;
      ctx.globalAlpha = dense ? 0.55 : 0.85;
      ctx.fillRect(x0, yOf(n.pitch) - h / 2, Math.max(1, x1 - x0 - (dense ? 0 : 1)), h);
    }
    ctx.globalAlpha = 1;
    ctx.restore();

    // handle lane: one tick per onset (when there is room)
    ctx.fillStyle = paper2;
    ctx.fillRect(GUTTER, 0, plotW, HANDLES);
    const onsets = onsetsInWindow(index, view.t0, view.t1);
    if (onsets.length < plotW / 5) {
      ctx.fillStyle = ink3;
      for (const o of onsets) ctx.fillRect(Math.round(xOf(o.at)) - 1, HANDLES - 8, 3, 6);
    }

    // waveform lane, below a dividing line
    ctx.fillStyle = paper2;
    ctx.fillRect(GUTTER, waveTop, plotW, WAVE);
    ctx.fillStyle = line;
    ctx.fillRect(0, waveTop, size.w, 1);
    ctx.fillRect(0, HANDLES, size.w, 1);
    ctx.fillStyle = ink3;
    const mid = waveTop + WAVE / 2;
    if (pyramid) {
      const { level, secPerBucket } = levelFor(pyramid, view.t0, view.t1, plotW);
      for (let x = 0; x < plotW; x++) {
        const a = Math.floor(tOf(GUTTER + x) / secPerBucket);
        const b = Math.max(a + 1, Math.floor(tOf(GUTTER + x + 1) / secPerBucket));
        let lo = 0;
        let hi = 0;
        for (let k = Math.max(0, a); k < b && k * 2 + 1 < level.length; k++) {
          if (level[k * 2] < lo) lo = level[k * 2];
          if (level[k * 2 + 1] > hi) hi = level[k * 2 + 1];
        }
        const g = WAVE / 2 - 2;
        const top = Math.max(-1, Math.min(1, hi * gain));
        const bot = Math.max(-1, Math.min(1, lo * gain));
        ctx.fillRect(GUTTER + x, mid - top * g, 1, Math.max(1, (top - bot) * g));
      }
    } else if (peaks && peaks.length > 0 && durationSec > 0) {
      for (let x = 0; x < plotW; x++) {
        const t = tOf(GUTTER + x);
        const v = peaks[Math.max(0, Math.min(peaks.length - 1, Math.floor((t / durationSec) * peaks.length)))] ?? 0;
        const a = Math.min(1, v * gain);
        ctx.fillRect(GUTTER + x, mid - a * (WAVE / 2 - 2), 1, Math.max(1, a * (WAVE - 4)));
      }
    }

    // landing line of the selected note: from its onset down through the waveform, where it plays now
    if (selected) {
      const at = landingOf(selected.measure, selected.position);
      if (at !== null && at >= view.t0 && at <= view.t1) {
        const x = Math.round(xOf(at)) + 0.5;
        ctx.strokeStyle = token("--ink", "#222");
        ctx.setLineDash([3, 3]);
        ctx.beginPath();
        ctx.moveTo(x, 0);
        ctx.lineTo(x, size.h);
        ctx.stroke();
        ctx.setLineDash([]);
      }
    }

    // marker pins in the handle lane (and their line down to the waveform)
    const drag = dragRef.current;
    for (const p of pins) {
      const at = drag?.kind === "pin" && drag.pin.id === p.id ? drag.at : p.at;
      if (at < view.t0 - 1 || at > view.t1 + 1) continue;
      const x = Math.round(xOf(at)) + 0.5;
      const color = p.state === "applied" ? marker : p.state === "pending" ? pending : ink3;
      ctx.strokeStyle = color;
      ctx.globalAlpha = p.state === "deleted" ? 0.5 : 0.9;
      ctx.setLineDash(p.state === "applied" ? [] : [2, 2]);
      ctx.beginPath();
      ctx.moveTo(x, HANDLES);
      ctx.lineTo(x, size.h);
      ctx.stroke();
      ctx.setLineDash([]);
      ctx.beginPath();
      ctx.moveTo(x - 5, 2);
      ctx.lineTo(x + 5, 2);
      ctx.lineTo(x, HANDLES - 2);
      ctx.closePath();
      if (p.state === "applied") {
        ctx.fillStyle = marker;
        ctx.fill();
      } else {
        ctx.fillStyle = paper2;
        ctx.fill();
        ctx.stroke();
      }
      ctx.globalAlpha = 1;
    }
    if (drag?.kind === "onset") {
      const x = Math.round(xOf(drag.at)) + 0.5;
      ctx.strokeStyle = pending;
      ctx.setLineDash([2, 2]);
      ctx.beginPath();
      ctx.moveTo(x, HANDLES);
      ctx.lineTo(x, size.h);
      ctx.stroke();
      ctx.setLineDash([]);
      ctx.fillStyle = pending;
      ctx.fillRect(x - 3, 2, 6, HANDLES - 4);
    }
  }, [size, view, index, pins, selected, display, pyramid, peaks, durationSec, hiddenSections, hiddenParts, aligned, pitchLo, pitchHi, rollH, waveTop, plotW, xOf, tOf, landingOf, dragTick, rollTop, gain, WAVE]); // eslint-disable-line react-hooks/exhaustive-deps

  // playhead (by ref) and following
  useEffect(() => {
    let raf = 0;
    const loop = () => {
      const t = usePlayback.getState().time;
      const head = headRef.current;
      if (head) {
        const inView = t >= view.t0 && t <= view.t1;
        head.style.opacity = inView ? "1" : "0";
        if (inView) head.style.transform = `translateX(${xOf(t)}px)`;
      }
      if (follow && !dragRef.current && usePlayback.getState().playing) {
        const span = view.t1 - view.t0;
        if (t > view.t1 - span * 0.1 || t < view.t0) setView({ t0: t - span * 0.1, t1: t - span * 0.1 + span });
      }
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
  }, [view, follow, xOf]);

  const limits = { min: MIN_SPAN, max: Math.max(MIN_SPAN * 2, durationSec || 60) };
  const zoom = (factor: number, anchor?: number) => setView((v) => zoomAt(v, anchor ?? (v.t0 + v.t1) / 2, factor, limits));
  const zoomPitch = (factor: number) => {
    const c = (pitchLo + pitchHi) / 2;
    const half = Math.max(3, Math.min(64, ((pitchHi - pitchLo) / 2) * factor));
    setPitchView({ lo: c - half, hi: c + half });
  };
  const zoomGain = (factor: number) => setGain((g) => Math.max(0.5, Math.min(32, g * factor)));
  const pan = (frac: number) => setView((v) => ({ t0: v.t0 + (v.t1 - v.t0) * frac, t1: v.t1 + (v.t1 - v.t0) * frac }));

  const boundsFor = (measure: number, position: number, excludeId?: string) =>
    markerBounds(sync.auto, sync.manual, { measure, position }, { excludeId, durationSec: dur || durationSec || Infinity });
  const barLabel = (t: number) => {
    const a = aligned.find((x, i) => x.startSec <= t && (aligned[i + 1]?.startSec ?? Infinity) > t);
    return a ? `bar ${a.n}` : "a neighbour";
  };

  const selectOnset = (o: RollOnset, seek = false) => {
    select({ measure: o.measure, position: o.position });
    useSyncUi.getState().announce(describeSpot(o.measure, o.position));
    if (seek) usePlayback.getState().seek(o.at);
  };
  const describeSpot = (measure: number, position: number) => {
    const mk = sync.manual.find((m) => sameMarkerSpot(m, measure, position));
    const where = spotText(infoMap, measure, position, true);
    if (!mk) return `${where} · no marker`;
    const state = pins.find((p) => p.id === mk.id)?.state ?? "applied";
    return `${where} · ${state === "pending" ? "pending marker" : "marker"}${mk.label ? ` ‘${mk.label}’` : ""} at ${formatTime(mk.startSec, true)}`;
  };

  const hitPin = (x: number, y: number) => (y <= HANDLES + 4 ? pins.find((p) => Math.abs(xOf(p.at) - x) <= 6) : undefined);
  const hitOnset = (x: number, y: number) => {
    if (y > HANDLES + 4) return undefined;
    const o = nearestOnset(index, tOf(x));
    return o && Math.abs(xOf(o.at) - x) <= 5 ? o : undefined;
  };

  const onPointerDown = (e: React.PointerEvent<HTMLCanvasElement>) => {
    if (e.button !== 0) return;
    const r = e.currentTarget.getBoundingClientRect();
    const x = e.clientX - r.left;
    const y = e.clientY - r.top;
    const pin = hitPin(x, y);
    const onset = pin ? undefined : hitOnset(x, y);
    if (pin) {
      const b = pin.state === "deleted" ? { low: -Infinity, high: Infinity } : boundsFor(pin.measure, pin.position, pin.id);
      dragRef.current = { kind: "pin", pin, startX: e.clientX, startAt: pin.at, at: pin.at, low: b.low, high: b.high, moved: false };
    } else if (onset) {
      const b = boundsFor(onset.measure, onset.position);
      dragRef.current = { kind: "onset", onset, startX: e.clientX, startAt: onset.at, at: onset.at, low: b.low, high: b.high, moved: false };
    } else if (y >= HANDLES && y < waveTop) {
      // a note: select its onset (the start point) without moving playback
      const o = nearestOnset(index, tOf(x));
      if (o) selectOnset(o);
      return;
    } else if (y >= waveTop) {
      usePlayback.getState().seek(Math.max(0, tOf(x)));
      return;
    } else return;
    e.currentTarget.setPointerCapture(e.pointerId);
  };
  const onPointerMove = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const d = dragRef.current;
    if (!d) return;
    const dx = e.clientX - d.startX;
    if (!d.moved && Math.abs(dx) < DRAG_PX) return;
    if (running || (d.kind === "pin" && d.pin.state === "deleted")) {
      setBoundMsg(running ? RUN_LOCK_REASON : null);
      return;
    }
    d.moved = true;
    const want = d.startAt + (dx / plotW) * (view.t1 - view.t0);
    d.at = Math.max(d.low, Math.min(d.high, want));
    setBoundMsg(want < d.low ? `Can't pass ${barLabel(d.low - 0.01)} (${formatTime(d.low, true)})` : want > d.high ? `Can't pass ${barLabel(d.high + 0.01)} (${formatTime(d.high, true)})` : null);
    setDragTick((k) => k + 1);
  };
  const finish = (commit: boolean, e?: React.PointerEvent<HTMLCanvasElement>) => {
    const d = dragRef.current;
    dragRef.current = null;
    setBoundMsg(null);
    setDragTick((k) => k + 1);
    if (!d) return;
    if (!d.moved) {
      if (d.kind === "pin" && e) {
        const r = e.currentTarget.getBoundingClientRect();
        const x = r.left + xOf(d.pin.at);
        useSyncUi.getState().openPopover(d.pin.id, { getBoundingClientRect: () => new DOMRect(x - 6, r.top, 12, HANDLES) });
        select({ measure: d.pin.measure, position: d.pin.position });
      } else if (d.kind === "onset") selectOnset(d.onset);
      return;
    }
    if (!commit) return;
    if (d.kind === "pin") cmd.update(d.pin.id, { startSec: d.at }, "Marker moved");
    else {
      cmd.add(d.onset.measure, d.at, d.onset.position);
      select({ measure: d.onset.measure, position: d.onset.position });
    }
  };

  const selOnset = selected ? (index.onsets.find((o) => o.measure === selected.measure && Math.abs(o.position - selected.position) < 1e-6) ?? null) : null;
  const selMarker = selected ? sync.manual.find((m) => sameMarkerSpot(m, selected.measure, selected.position)) : undefined;
  const nudge = (deltaMs: number) => {
    if (!selected || running) return;
    if (selMarker) cmd.update(selMarker.id, { startSec: selMarker.startSec + deltaMs / 1000 }, "Marker nudged");
    else if (selOnset) cmd.add(selected.measure, selOnset.at + deltaMs / 1000, selected.position);
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    const k = e.key;
    let handled = true;
    if (k === "ArrowLeft" || k === "ArrowRight") {
      if (e.shiftKey || e.metaKey || e.ctrlKey) return; // the transport's skips
      const list = index.onsets;
      const cur = selOnset ? list.indexOf(selOnset) : list.indexOf(nearestOnset(index, usePlayback.getState().time) ?? list[0]);
      const next = list[Math.max(0, Math.min(list.length - 1, cur + (k === "ArrowRight" ? 1 : -1)))];
      if (next) {
        selectOnset(next, true);
        if (next.at < view.t0 || next.at > view.t1) setView((v) => ({ t0: next.at - (v.t1 - v.t0) / 2, t1: next.at + (v.t1 - v.t0) / 2 }));
      }
    } else if (k === "ArrowUp" || k === "ArrowDown") {
      const d = k === "ArrowUp" ? 2 : -2;
      setPitchView({ lo: pitchLo + d, hi: pitchHi + d });
    } else if (k === "Enter") {
      if (selMarker) {
        const r = canvasRef.current!.getBoundingClientRect();
        const x = r.left + xOf(selMarker.startSec);
        useSyncUi.getState().openPopover(selMarker.id, { getBoundingClientRect: () => new DOMRect(x - 6, r.top, 12, HANDLES) });
      } else handled = false;
    } else if (k === "[" || k === "]") nudge((k === "]" ? 1 : -1) * (e.shiftKey ? 100 : 10));
    else if (k === "{" || k === "}") nudge((k === "}" ? 1 : -1) * 100);
    else if ((k === "a" || k === "A") && !e.metaKey && !e.ctrlKey) {
      if (!selected || !selOnset) useSyncUi.getState().announce("Select a note first.");
      else if (!selMarker) cmd.add(selected.measure, selOnset.at, selected.position);
    } else if ((k === "p" || k === "P") && !e.metaKey && !e.ctrlKey) {
      const t = usePlayback.getState().time;
      if (selMarker) cmd.update(selMarker.id, { startSec: t }, "Marker set to the playhead");
      else if (selected) cmd.add(selected.measure, t, selected.position);
    } else if (k === "-" || k === "_") zoom(1.5);
    else if (k === "=" || k === "+") zoom(1 / 1.5);
    else if (k === ",") pan(-0.25);
    else if (k === ".") pan(0.25);
    else if (k === "Escape" && dragRef.current) finish(false);
    else handled = false;
    if (handled) {
      e.preventDefault();
      e.stopPropagation();
    }
  };

  const markerCount = pins.length;
  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex shrink-0 flex-wrap items-center gap-2 border-b border-line px-2 py-0.5 text-[11px] text-ink-3">
        <span>{formatTime(Math.max(0, view.t0))}–{formatTime(view.t1)}</span>
        <button type="button" className="rounded px-1.5 hover:bg-paper-3 hover:text-ink" onClick={() => zoom(1.5)} aria-label="Zoom out the roll and waveform">
          −
        </button>
        <button type="button" className="rounded px-1.5 hover:bg-paper-3 hover:text-ink" onClick={() => zoom(1 / 1.5)} aria-label="Zoom in the roll and waveform">
          +
        </button>
        <button type="button" className="rounded px-1.5 hover:bg-paper-3 hover:text-ink" onClick={() => setView({ t0: 0, t1: Math.max(10, durationSec) })}>
          Whole piece
        </button>
        <span className="h-3 w-px bg-line" aria-hidden />
        <span>Pitch</span>
        <button type="button" className="rounded px-1.5 hover:bg-paper-3 hover:text-ink" onClick={() => zoomPitch(1.3)} aria-label="Show a wider pitch range">
          −
        </button>
        <button type="button" className="rounded px-1.5 hover:bg-paper-3 hover:text-ink" onClick={() => zoomPitch(1 / 1.3)} aria-label="Show a narrower pitch range (taller notes)">
          +
        </button>
        <button type="button" className="rounded px-1.5 hover:bg-paper-3 hover:text-ink" onClick={() => setPitchView(fitPitch(index, view))}>
          Fit
        </button>
        <span className="h-3 w-px bg-line" aria-hidden />
        <span>Peaks</span>
        <button type="button" className="rounded px-1.5 hover:bg-paper-3 hover:text-ink" onClick={() => zoomGain(1 / 1.5)} aria-label="Lower waveform peaks">
          −
        </button>
        <button type="button" className="rounded px-1.5 hover:bg-paper-3 hover:text-ink" onClick={() => zoomGain(1.5)} aria-label="Higher waveform peaks">
          +
        </button>
        <span className="tnum">{gain.toFixed(gain < 10 ? 1 : 0)}×</span>
        {boundMsg && (
          <span className="text-danger" role="status">
            {boundMsg}
          </span>
        )}
      </div>
      <div
        ref={wrapRef}
        className="relative min-h-0 flex-1 outline-none focus-visible:ring-2 focus-visible:ring-brass"
        tabIndex={0}
        role="group"
        aria-roledescription="piano roll"
        aria-label={`Notes over the recording. ${markerCount} markers. Arrow keys step through notes, A adds a marker, [ and ] nudge it, Enter opens it, minus and equals zoom.`}
        data-local-keys="ArrowLeft ArrowRight ArrowUp ArrowDown Enter"
        onKeyDown={onKeyDown}
        onWheel={(e) => {
          if (e.ctrlKey || e.metaKey) {
            e.preventDefault();
            const r = e.currentTarget.getBoundingClientRect();
            zoom(e.deltaY > 0 ? 1.25 : 0.8, tOf(e.clientX - r.left));
          } else if (e.altKey) {
            e.preventDefault();
            zoomPitch(e.deltaY > 0 ? 1.15 : 1 / 1.15);
          } else if (e.shiftKey) {
            const r = e.currentTarget.getBoundingClientRect();
            if (e.clientY - r.top >= waveTop) zoomGain(e.deltaY > 0 ? 1 / 1.2 : 1.2);
            else {
              const d = e.deltaY > 0 ? -1 : 1;
              setPitchView({ lo: pitchLo + d, hi: pitchHi + d });
            }
          } else {
            const d = Math.abs(e.deltaX) > Math.abs(e.deltaY) ? e.deltaX : e.deltaY;
            pan((d / Math.max(1, plotW)) * 1.5);
          }
        }}
      >
        <canvas
          ref={canvasRef}
          className="absolute inset-0 h-full w-full touch-none"
          style={{ cursor: running ? "not-allowed" : "default" }}
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={(e) => finish(true, e)}
          onPointerCancel={() => finish(false)}
          onContextMenu={(e) => {
            const r = e.currentTarget.getBoundingClientRect();
            const o = nearestOnset(index, tOf(e.clientX - r.left));
            if (!o) return;
            e.preventDefault();
            selectOnset(o);
            useSyncUi.getState().openMenu({ measure: o.measure, position: o.position }, e.clientX, e.clientY);
          }}
          data-testid="piano-roll"
        />
        <div
          role="separator"
          aria-orientation="horizontal"
          aria-label="Resize the piano roll and the waveform"
          aria-valuenow={Math.round(WAVE)}
          tabIndex={0}
          className="absolute inset-x-0 z-10 cursor-row-resize outline-none hover:bg-brass/25 focus-visible:bg-brass/40"
          style={{ top: waveTop - 3, height: 7 }}
          onPointerDown={(e) => {
            e.preventDefault();
            e.stopPropagation();
            const start = e.clientY;
            const base = WAVE;
            const move = (ev: PointerEvent) => setWaveH(Math.max(24, Math.min(size.h - HANDLES - 40, base - (ev.clientY - start))));
            const up = () => {
              window.removeEventListener("pointermove", move);
              window.removeEventListener("pointerup", up);
            };
            window.addEventListener("pointermove", move);
            window.addEventListener("pointerup", up);
          }}
          onKeyDown={(e) => {
            if (e.key !== "ArrowUp" && e.key !== "ArrowDown") return;
            e.preventDefault();
            e.stopPropagation();
            setWaveH(Math.max(24, Math.min(size.h - HANDLES - 40, WAVE + (e.key === "ArrowUp" ? 12 : -12))));
          }}
        />
        <div ref={headRef} className="score-playhead pointer-events-none absolute left-0 top-0 h-full w-[2px] rounded-full opacity-0" aria-hidden />
        <ul className="sr-only">
          {pins.map((p) => (
            <li key={`${p.id}:${p.state}`}>{markerAccessibleName(infoMap, p.marker, p.state)}</li>
          ))}
        </ul>
      </div>
    </div>
  );
}

function fitPitch(index: ReturnType<typeof buildRollIndex>, view: { t0: number; t1: number }) {
  let lo = 127;
  let hi = 0;
  for (const n of queryWindow(index, view.t0, view.t1)) {
    if (n.pitch < lo) lo = n.pitch;
    if (n.pitch > hi) hi = n.pitch;
  }
  return lo > hi ? null : { lo: lo - 1, hi: hi + 1 };
}
