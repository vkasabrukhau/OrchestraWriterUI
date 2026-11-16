"use client";

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { ChevronLeft, ChevronRight, Locate, Maximize2, Minimize2, Minus, Plus, Repeat, X } from "lucide-react";
import type { OpenSheetMusicDisplay } from "opensheetmusicdisplay";
import type { InfoMap } from "@/shared/info-map";
import { confidenceBand } from "@/shared/sync";
import { playbackBarFor, writtenCount, writtenIndices } from "@/lib/score/written";
import { barAtScoreTime, fractionInBar, playheadX } from "@/lib/score/playhead";
import { canonicalPosition, musicalToTimeFraction, timeToMusicalFraction } from "@/lib/score/stamps";
import { engraveScore, pickInBar, xAtStamp, type BarGeometry, type Engraving } from "@/lib/score/engrave";
import { buildSheet, chunkGrid, chunkGridAt, chunkOf, pageAt, rowOfBar, type PageFormat } from "@/lib/score/sheet";
import type { LayoutHints } from "@/lib/score/slice";
import { makeSlicer } from "@/lib/score/slice";
import { systemAt, systemsInView } from "@/lib/score/systems";
import { beatIn, beatsOf, resolveGoTo, type GoTo } from "@/lib/score/navigation";
import { cx } from "@/lib/utils/format";
import { Toggle } from "@/components/ui/Toggle";
import { Tooltip } from "@/components/ui/Tooltip";
import { barNumber } from "./bars";
import { ScoreRuler } from "./ScoreRuler";

/**
 * The page, in layout pixels (A4 portrait proportions). The score is set on
 * pages of this size once; zooming and resizing only scale the pages.
 */
const PAGE: PageFormat = { width: 1000, height: 1414, margin: 44, gap: 28 };
/**
 * OSMD's usual staff size. Decided once per set of parts, as a printed full
 * score is: a system too tall for a page is made smaller, and a system that
 * can only go one to a page is made larger to fill it; scores whose systems
 * fit two or more to a page keep this size.
 */
const STAFF_SIZE = 0.6;
const STAFF_MIN = 0.25;
const STAFF_MAX = 1;
/** view zoom, relative to the page filling the panel's width */
const VIEW_MIN = 0.3;
const VIEW_MAX = 3;
/** space around the pages inside the panel, screen pixels */
const DESK = 12;
/** written bars laid out at a time; a chunk always ends a page, so chunks can be laid out in any order */
const CHUNK_BARS = 24;
/** the overlay and playhead reach this far above and below a bar's staves */
const PAD_Y = 6;
/** room kept above a system for its bar numbers and tempo text when it is scrolled to (sheet pixels) */
const HEADROOM = 34;
/** systems drawn beyond the ones in view, each way */
const OVERSCAN = 1;
/** a clock jump larger than this (seconds of score time) is a seek: follow playback again */
const SEEK_JUMP = 1.5;

/** A note in the score: playback bar (1-based) and where in it (fraction of the bar in score time). */
export interface NoteSpot {
  measure: number;
  position: number;
}

export type Picked = NoteSpot & { scoreTime: number };

/** A marker drawn on Sync: applied (filled), pending (dashed outline) or a pending deletion (crossed out). */
export interface ScoreMarker extends NoteSpot {
  id: string;
  state: "applied" | "pending" | "deleted";
  /** accessible name: "Marker ‘Horn entry’, bar 12 beat 3 at 1:23.456, pending: recompute to apply" */
  name: string;
}

export interface EngravedScoreProps {
  xml: string;
  infoMap: InfoMap;
  /** playback bar being played (1-based) */
  currentMeasure: number;
  /** score-time clock (seconds); enables the playhead and following */
  clock?: () => number;
  /** step the playhead from note to note and scroll without animation */
  reducedMotion?: boolean;
  visibleParts?: Set<string>;
  /** Sync: confidence per playback bar */
  confidence?: Map<number, number>;
  /** "sync": clicks select a note for a marker, and markers are drawn */
  mode?: "play" | "sync";
  markers?: ScoreMarker[];
  /** Sync: a marker pin was pressed (opens its details) */
  onMarkerPress?: (id: string, el: HTMLElement) => void;
  /** Sync: a note was right-clicked (or long-pressed); the caller opens its menu */
  onSpotContextMenu?: (spot: Picked, at: { x: number; y: number }) => void;
  /** the start point (and, on Sync, the note being edited) */
  cue?: NoteSpot | null;
  /** passage being repeated, score seconds */
  range?: { start: number; end: number } | null;
  onRange?: (range: { start: number; end: number } | null) => void;
  /** a note was clicked: it becomes the start point (playback does not move) */
  onPick: (spot: Picked) => void;
  /** a note was double-clicked: play from it */
  onPlayFrom: (spot: Picked) => void;
  /** Go to resolved a place: make it the start point; returns the playback bar to show */
  onGoTo: (place: Exclude<GoTo, { kind: "error" }>) => number | null;
  /** transport length, for Go to times */
  durationSec?: number;
  /** OSMD could not load or draw this file; the caller shows the schematic instead */
  onError: (message: string) => void;
  /** fill the parent's height (Sync's resizable section) instead of a fixed panel height */
  fill?: boolean;
  className?: string;
}

/**
 * Engraved notation from the uploaded MusicXML (OpenSheetMusicDisplay) in
 * page view, as MuseScore, Sibelius and Dorico show a score: systems are set
 * on fixed pages once, with the staff size lowered when a full system would
 * not fit a page, and zooming or resizing only magnifies the pages (ADR
 * 0016). Pages are laid out in chunks around the reader, the rest as they
 * come into view; each system is kept as markup and attached only near the
 * view. Following playback scrolls; it never redraws.
 *
 * Clicking a note makes it the start point without moving playback; Play
 * resumes from the playhead and "Play from …" starts at the start point. A
 * double click plays from the note at once. Shift-click a second note to
 * repeat the passage between the start point and it.
 */
export function EngravedScore({
  xml,
  infoMap,
  currentMeasure,
  clock,
  reducedMotion,
  visibleParts,
  confidence,
  mode = "play",
  markers,
  onMarkerPress,
  onSpotContextMenu,
  cue,
  range,
  onRange,
  onPick,
  onPlayFrom,
  onGoTo,
  durationSec,
  onError,
  fill = false,
  className,
}: EngravedScoreProps) {
  const written = useMemo(() => writtenIndices(infoMap), [infoMap]);
  const count = Math.max(1, writtenCount(written));
  const currentWritten = written[currentMeasure - 1] ?? 0;
  const beats = beatsOf(infoMap.timeSignature);
  // Large scores are laid out from slices of the file (only the bars of a chunk), so a chunk's
  // cost does not grow with the whole score; a file that cannot be sliced is loaded once whole.
  const slicer = useMemo(() => makeSlicer(xml), [xml]);
  /** where the file breaks lines and pages, if it says */
  const fileBreaks = !!slicer && (slicer.hints.newSystem.size > 0 || slicer.hints.newPage.size > 0);
  const visibleKey = visibleParts ? [...visibleParts].sort().join(",") : "*";
  /** bars per line seen in the decided layout, per set of visible parts (shapes where chunks end) */
  const [lineBarsFor, setLineBarsFor] = useState<Record<string, number>>({});
  const lineBars = lineBarsFor[visibleKey] ?? 0;
  const grid = useMemo(
    () => (slicer ? chunkGridAt(count, CHUNK_BARS, slicer.hints, slicer.hints.newPage.size > 0 ? 0 : lineBars) : chunkGrid(count, CHUNK_BARS)),
    [count, slicer, lineBars],
  );
  const gridKey = grid.map(([, b]) => b).join(",");


  const [follow, setFollow] = useState(true);
  const [viewZoom, setViewZoom] = useState(1);
  const [expanded, setExpanded] = useState(false);
  const [panel, setPanel] = useState({ w: 0, h: 0 });
  /** staff size per set of visible parts; `decided` once a layout has passed the checks in the layout job */
  const [staffFor, setStaffFor] = useState<Record<string, { size: number; decided: boolean; tries: number }>>({});
  const staff = staffFor[visibleKey]?.size ?? STAFF_SIZE;
  const layoutKey = `${staff}|${visibleKey}|${gridKey}`;
  /** screen pixels per sheet pixel */
  const scale = panel.w > 0 ? Math.max(0.05, ((panel.w - 2 * DESK) / PAGE.width) * viewZoom) : 1;
  const scaleRef = useRef(scale);
  useEffect(() => {
    scaleRef.current = scale;
  }, [scale]);

  const hostRef = useRef<HTMLDivElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const playheadRef = useRef<HTMLDivElement>(null);
  const rulerHeadRef = useRef<HTMLDivElement>(null);
  const gotoRef = useRef<HTMLInputElement>(null);
  const osmdRef = useRef<OpenSheetMusicDisplay | null>(null);
  const onErrorRef = useRef(onError);
  useEffect(() => {
    onErrorRef.current = onError;
  });
  const [loaded, setLoaded] = useState(false);
  /** chunks laid out for one layout key; the previous key's chunks stay up until the new one has its first */
  const [layout, setLayout] = useState<{ key: string; chunks: Map<number, Engraving> }>({ key: "", chunks: new Map() });
  const sheet = useMemo(() => (layout.chunks.size > 0 ? buildSheet(grid, layout.chunks, PAGE, slicer?.hints.newPage) : null), [grid, layout.chunks, slicer]);
  /** a new set of parts (or staff size) is being laid out; the old pages stay up meanwhile */
  const busy = loaded && layout.key !== layoutKey;
  /** rows overlapping the view, the one at its top, and the page at its top */
  const [view, setView] = useState<{ first: number; last: number; top: number; page: number }>({ first: 0, last: 0, top: 0, page: 0 });

  const prefersReduced = usePrefersReducedMotion();
  const stepped = reducedMotion || prefersReduced;

  /** sheet y ↔ the panel's scrollTop */
  const toScroll = (y: number, s = scaleRef.current) => y * s + DESK;
  const fromScroll = (top: number, s = scaleRef.current) => (top - DESK) / s;

  const osmdClassRef = useRef<OsmdClass | null>(null);
  useEffect(() => {
    let cancelled = false;
    (async () => {
      const host = hostRef.current;
      if (!host) return;
      const { OpenSheetMusicDisplay } = await import("opensheetmusicdisplay");
      osmdClassRef.current = OpenSheetMusicDisplay;
      if (!slicer) {
        const osmd = newOsmd(OpenSheetMusicDisplay, host);
        await osmd.load(xml);
        if (cancelled) return;
        osmdRef.current = osmd;
      }
      if (!cancelled) setLoaded(true);
    })().catch((err: unknown) => {
      if (!cancelled) onErrorRef.current(err instanceof Error ? err.message : String(err));
    });
    return () => {
      cancelled = true;
      osmdRef.current = null;
    };
  }, [xml, slicer]);

  // the panel's size only sets the scale: nothing is laid out again
  useEffect(() => {
    const el = scrollRef.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(() => setPanel({ w: el.clientWidth, h: el.clientHeight }));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  /* ---------------- laying out chunks on demand ---------------- */

  // where the reader is: the playing bar when following, else the bar at the top of the view
  const followRef = useRef(follow);
  useEffect(() => {
    followRef.current = follow;
  }, [follow]);
  const topBar = sheet?.rows[view.top]?.firstBar ?? 0;
  const anchorChunk = chunkOf(grid, follow ? currentWritten : topBar);
  const wanted = useMemo(() => {
    const list = [anchorChunk];
    if (sheet) for (let r = Math.max(0, view.first - OVERSCAN); r <= Math.min(sheet.rows.length - 1, view.last + OVERSCAN); r++) list.push(sheet.rows[r].chunk);
    list.push(anchorChunk + 1);
    return [...new Set(list)].filter((k) => k >= 0 && k < grid.length);
  }, [anchorChunk, sheet, view.first, view.last, grid]);
  const wantedKey = wanted.join(",");

  // one chunk at a time, on the hidden host: a finished job bumps `jobs` so the next one is picked
  const runningRef = useRef(false);
  const layoutKeyRef = useRef(layoutKey);
  useEffect(() => {
    layoutKeyRef.current = layoutKey;
  }, [layoutKey]);
  const [jobs, setJobs] = useState(0);
  useEffect(() => {
    const host = hostRef.current;
    const Osmd = osmdClassRef.current;
    if (!loaded || !host || !Osmd || runningRef.current) return;
    const fresh = layout.key !== layoutKey;
    const next = fresh ? wanted[0] : wanted.find((k) => !layout.chunks.has(k));
    if (next === undefined) return;
    const jobKey = layoutKey;
    const jobParts = visibleKey;
    const deciding = !staffFor[visibleKey]?.decided;
    const lastChunk = next === grid.length - 1;
    let started = false;
    runningRef.current = true;
    // a short pause lets the page paint before the main thread is busy
    const timer = setTimeout(
      async () => {
        started = true;
        try {
          host.style.width = `${PAGE.width}px`;
          const [from, to] = grid[next];
          let e: Engraving;
          if (slicer) {
            const osmd = newOsmd(Osmd, host);
            await osmd.load(slicer.slice(from, to));
            if (layoutKeyRef.current !== jobKey) return;
            // a chunk's last line is only the score's last line in the last chunk: stretch the others like any line
            osmd.setOptions({ stretchLastSystemLine: !lastChunk });
            e = engraveScore(osmd, host, { zoom: staff, visibleParts, indexOffset: from });
          } else {
            const osmd = osmdRef.current;
            if (!osmd) return;
            osmd.setOptions({ stretchLastSystemLine: !lastChunk });
            e = engraveScore(osmd, host, { zoom: staff, visibleParts, from, to });
          }
          if (deciding) {
            // the first layout for these parts decides the staff size (see STAFF_SIZE)
            const fitted = fitStaff(e, staff, from, fileBreaks ? slicer!.hints : null);
            const tries = (staffFor[jobParts]?.tries ?? 0) + 1;
            // fitting the file's lines may take a few smaller sizes; the page-fill rule is one adjustment
            const decided = !fileBreaks || fitted === staff || tries >= 5;
            setStaffFor((m) => ({ ...m, [jobParts]: { size: fitted, decided, tries } }));
            if (fitted !== staff) return; // lay out again at the new size
          }
          if (slicer && !fileBreaks && lineBarsFor[jobParts] === undefined && e.systems.length > 1) {
            // how many bars a line holds at this size (the chunk's last line may be short, so it is left out);
            // chunk ends then avoid short last lines (chunkGridAt)
            const full = e.systems.slice(0, -1);
            const per = Math.max(1, Math.round(full.reduce((n, sys) => n + sys.lastBar - sys.firstBar + 1, 0) / full.length));
            setLineBarsFor((m) => ({ ...m, [jobParts]: per }));
            const ends = chunkGridAt(count, CHUNK_BARS, slicer.hints, per).map(([, b]) => b).join(",");
            if (ends !== gridKey) return; // chunk ends move: lay out again
          }
          setLayout((l) => {
            // a result for a set of parts that is no longer wanted is dropped
            if (layoutKeyRef.current !== jobKey) return l;
            const chunks = l.key === jobKey ? new Map(l.chunks) : new Map<number, Engraving>();
            chunks.set(next, e);
            return { key: jobKey, chunks };
          });
        } catch (err) {
          onErrorRef.current(err instanceof Error ? err.message : String(err));
        } finally {
          runningRef.current = false;
          setJobs((j) => j + 1);
        }
      },
      fresh ? 30 : 60,
    );
    return () => {
      if (!started) {
        clearTimeout(timer);
        runningRef.current = false;
      }
    };
    // wantedKey stands in for wanted, visibleKey for visibleParts
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loaded, layoutKey, layout, wantedKey, grid, jobs]);

  /* ---------------- view bookkeeping ---------------- */

  /** the bar at the top of the view and how far into its row, to keep the place when rows move or the scale changes */
  const placeRef = useRef<{ bar: number; frac: number } | null>(null);
  /** a bar to scroll to once its chunk is laid out */
  const targetRef = useRef<number | null>(null);
  /** the system (or page, when a whole page fits) the playhead was last scrolled to */
  const lastFollowRef = useRef<string>("");

  const measureView = useCallback(() => {
    const el = scrollRef.current;
    if (!el || !sheet) return;
    const y0 = fromScroll(el.scrollTop);
    const y1 = fromScroll(el.scrollTop + el.clientHeight);
    const span = systemsInView(sheet.cuts, y0, y1) ?? [0, 0];
    let top = systemAt(sheet.cuts, y0 + HEADROOM);
    // a row owns the gap below it (to the next page): past its music, the next row is the one at the top
    const r0 = sheet.rows[top];
    if (r0 && r0.top + r0.height < y0 + HEADROOM && top + 1 < sheet.rows.length) top += 1;
    const page = pageAt(sheet.pages, y0 + PAGE.height * 0.25);
    const row = sheet.rows[top];
    if (row) placeRef.current = { bar: row.firstBar, frac: row.height > 0 ? (y0 - row.top) / row.height : 0 };
    setView((v) => (v.first === span[0] && v.last === span[1] && v.top === top && v.page === page ? v : { first: span[0], last: span[1], top, page }));
     
  }, [sheet]);

  // when rows move (a chunk was laid out) or the scale changes, keep the reader's place
  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (!el || !sheet) return;
    const target = targetRef.current;
    if (target !== null && sheet.bars.has(target)) {
      targetRef.current = null;
      el.scrollTop = toScroll(Math.max(0, sheet.cuts[rowOfBar(sheet, target)] - HEADROOM), scale);
    } else if (followRef.current) {
      lastFollowRef.current = ""; // the playhead loop scrolls to the playing system on its next frame
    } else if (placeRef.current) {
      const r = rowOfBar(sheet, placeRef.current.bar);
      el.scrollTop = toScroll(Math.max(0, sheet.cuts[r] + placeRef.current.frac * (sheet.cuts[r + 1] - sheet.cuts[r])), scale);
    }
    measureView();
     
  }, [sheet, scale, measureView]);

  /* ---------------- playhead and following ---------------- */

  /** where the reader sits inside a tall system (fraction of its height), kept across system changes */
  const offsetRef = useRef<number | null>(null);
  useEffect(() => {
    const line = playheadRef.current;
    const head = rulerHeadRef.current;
    if (!clock || !sheet) return;
    const measures = infoMap.measures;
    const total = infoMap.duration || 1;
    let raf = 0;
    let lastKey = "";
    let lastT = Number.NaN;
    let lastSystem = -1;
    const step = () => {
      raf = requestAnimationFrame(step);
      const t = clock();
      if (head) head.style.left = `${Math.max(0, Math.min(100, (t / total) * 100))}%`;
      // a seek (Play from, transport, keyboard) means "take me there": follow again
      if (Number.isFinite(lastT) && Math.abs(t - lastT) > SEEK_JUMP && !followRef.current) {
        followRef.current = true;
        setFollow(true);
      }
      lastT = t;
      const n = barAtScoreTime(measures, t);
      const m = measures[n - 1];
      const idx = written[n - 1];
      const bar = idx === undefined ? undefined : sheet.bars.get(idx);

      const scroller = scrollRef.current;
      if (scroller && idx !== undefined) {
        const s = scaleRef.current;
        const k = bar ? bar.system : rowOfBar(sheet, idx);
        const sysTop = sheet.cuts[k];
        const sysHeight = sheet.rows[k]?.height ?? sheet.cuts[k + 1] - sysTop;
        const p = sheet.pages[pageAt(sheet.pages, sysTop)];
        const wholePage = !!p && p.height * s <= scroller.clientHeight;
        const tall = !!bar && sysHeight * s > scroller.clientHeight;
        // a page that fits turns as a whole; otherwise each system is brought to the top
        const unit = wholePage ? `p${p.top}` : `s${k}`;
        const y = fromScroll(scroller.scrollTop, s);
        if (k === lastSystem && tall && y >= sysTop - HEADROOM && y <= sysTop + sysHeight) {
          // same tall system: remember where the reader is inside it (someone watching the brass stays on the brass)
          offsetRef.current = Math.max(0, Math.min(1, (y - sysTop) / sysHeight));
        }
        if (unit !== lastFollowRef.current) {
          if (followRef.current) {
            const targetY = wholePage ? p.top : tall && offsetRef.current !== null ? sysTop + offsetRef.current * sysHeight : sysTop - HEADROOM;
            const target = Math.max(0, wholePage ? toScroll(targetY, s) - DESK : toScroll(targetY, s));
            if (Math.abs(scroller.scrollTop - target) > 2) scroller.scrollTo({ top: target, behavior: stepped || lastFollowRef.current === "" ? "auto" : "smooth" });
          }
          lastFollowRef.current = unit;
        }
        lastSystem = k;
      }

      if (!line) return;
      if (!m || !bar) {
        if (lastKey !== "hidden") line.style.opacity = "0";
        lastKey = "hidden";
        return;
      }
      // onsets are musical fractions; the clock gives a time fraction (ADR 0018)
      const x = playheadX(bar.onsets, bar.box.left, bar.box.left + bar.box.width, timeToMusicalFraction(infoMap, m.number, fractionInBar(m, t)), stepped);
      const key = `${x.toFixed(1)}:${bar.box.top}:${bar.box.height}`;
      if (key === lastKey) return;
      lastKey = key;
      line.style.opacity = "1";
      line.style.transform = `translate3d(${x}px, ${bar.box.top - PAD_Y}px, 0)`;
      line.style.height = `${bar.box.height + PAD_Y * 2}px`;
    };
    raf = requestAnimationFrame(step);
    return () => cancelAnimationFrame(raf);
     
  }, [clock, infoMap, written, sheet, stepped]);

  /* ---------------- browsing ---------------- */

  const stopFollowing = () => {
    setFollow(false);
    followRef.current = false;
  };
  const scrollToY = (y: number, far: boolean) => {
    const el = scrollRef.current;
    if (!el) return;
    stopFollowing();
    // far or not laid out yet: jump, so what lies between is not laid out on the way
    el.scrollTo({ top: Math.max(0, toScroll(y) - DESK), behavior: stepped || far ? "auto" : "smooth" });
  };
  const browseToPage = (k: number) => {
    if (!sheet || sheet.pages.length === 0) return;
    const p = sheet.pages[Math.max(0, Math.min(sheet.pages.length - 1, k))];
    scrollToY(p.top, Math.abs(k - view.page) > 2);
  };
  const browseToBar = (writtenIdx: number) => {
    if (!sheet) return;
    const r = rowOfBar(sheet, writtenIdx);
    if (!sheet.bars.has(writtenIdx)) targetRef.current = writtenIdx;
    scrollToY(Math.max(0, sheet.cuts[r] - HEADROOM), !sheet.rows[r].markup || Math.abs(r - view.top) > 3);
  };
  const backToPlayhead = () => {
    setFollow(true);
    followRef.current = true;
    lastFollowRef.current = ""; // the next frame scrolls to the playhead
  };

  const topRow = sheet?.rows[view.top];
  const barLabel = (idx: number) => {
    const n = playbackBarFor(written, idx, currentMeasure);
    return n === null ? String(idx + 1) : (infoMap.measures[n - 1]?.label ?? String(n));
  };
  const lastLabel = infoMap.measures[infoMap.measures.length - 1]?.label ?? String(count);
  const pageCount = sheet?.pages.length ?? 0;
  const allLaidOut = layout.chunks.size === grid.length;

  /* ---------------- zoom (magnifies the pages; nothing is laid out again) ---------------- */

  const changeZoom = (z: number) => setViewZoom(Math.max(VIEW_MIN, Math.min(VIEW_MAX, Math.round(z * 20) / 20)));
  const fitPage = () => {
    const el = scrollRef.current;
    if (!el || panel.w <= 0) return;
    const widthScale = (panel.w - 2 * DESK) / PAGE.width;
    // pages end below their music, so fit the page being read (or a full one before any is laid out)
    const height = sheet?.pages[view.page]?.height ?? PAGE.height;
    // exact, not rounded to a zoom step: the whole page must fit
    setViewZoom(Math.max(VIEW_MIN, Math.min(VIEW_MAX, (el.clientHeight - 2 * DESK) / height / widthScale)));
  };
  const zoomPct = Math.round(viewZoom * 100);

  /* ---------------- Go to ---------------- */

  const [gotoText, setGotoText] = useState("");
  const [gotoError, setGotoError] = useState<string | null>(null);
  const submitGoto = () => {
    const r = resolveGoTo(gotoText, infoMap, currentMeasure, durationSec ?? Infinity);
    if (r.kind === "error") return setGotoError(r.message);
    setGotoError(null);
    setGotoText("");
    const n = onGoTo(r);
    const idx = n === null ? undefined : written[n - 1];
    if (idx !== undefined) browseToBar(idx);
  };

  // keyboard: Cmd/Ctrl+G focuses Go to; PgUp/PgDn turn pages while the pointer or focus is in the panel
  const rootRef = useRef<HTMLDivElement>(null);
  const hotRef = useRef(false);
  const keysRef = useRef<{ browse: (d: number) => void }>({ browse: () => {} });
  useEffect(() => {
    keysRef.current.browse = (d: number) => browseToPage(view.page + d);
  });
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && (e.key === "g" || e.key === "G")) {
        e.preventDefault();
        gotoRef.current?.focus();
        gotoRef.current?.select();
        return;
      }
      const el = e.target as HTMLElement | null;
      if (el && (el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.isContentEditable)) return;
      const inside = hotRef.current || (el !== null && rootRef.current?.contains(el));
      if (!inside) return;
      if (e.key === "PageDown" || e.key === "PageUp") {
        e.preventDefault();
        keysRef.current.browse(e.key === "PageDown" ? 1 : -1);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  /* ---------------- pointing at notes ---------------- */

  const [hover, setHover] = useState<{ idx: number; x: number; stamp: number } | null>(null);

  const spotAt = (bar: BarGeometry, e: React.MouseEvent<HTMLElement>) => {
    // the sheet is scaled: pointer positions go back to sheet pixels
    const sheetEl = e.currentTarget.offsetParent as HTMLElement | null;
    const rect = sheetEl?.getBoundingClientRect();
    return pickInBar(bar, (e.clientX - (rect?.left ?? 0)) / scale, (e.clientY - (rect?.top ?? 0)) / scale);
  };
  /** `stamp` is OSMD's musical fraction of the bar */
  const describe = (n: number, stamp: number) => {
    const m = infoMap.measures[n - 1];
    const beat = m ? beatIn(m, m.startTime + musicalToTimeFraction(infoMap, n, stamp) * m.duration, beats) : 1;
    return `bar ${barNumber(infoMap, n)}${beat > 1 ? `, beat ${beat}` : ""}`;
  };
  const pickedAt = (idx: number, bar: BarGeometry, e: React.MouseEvent<HTMLElement>): Picked | null => {
    const n = playbackBarFor(written, idx, currentMeasure);
    const m = n === null ? undefined : infoMap.measures[n - 1];
    if (n === null || !m) return null;
    const { stamp } = spotAt(bar, e);
    // OSMD's musical fraction → the time fraction markers and clocks use, on the info map's onset
    const position = canonicalPosition(infoMap, n, musicalToTimeFraction(infoMap, n, stamp));
    return { measure: n, position, scoreTime: m.startTime + position * m.duration };
  };
  const scoreTimeOf = (spot: NoteSpot) => {
    const m = infoMap.measures[spot.measure - 1];
    return m ? m.startTime + spot.position * m.duration : 0;
  };

  const click = (idx: number, bar: BarGeometry, e: React.MouseEvent<HTMLElement>) => {
    const p = pickedAt(idx, bar, e);
    if (!p) return;
    if (e.shiftKey && onRange) {
      // a passage from the start point (or the playing bar) to the end of the clicked note's bar
      const fromT = cue ? scoreTimeOf(cue) : (infoMap.measures[currentMeasure - 1]?.startTime ?? 0);
      const m = infoMap.measures[p.measure - 1];
      const a = Math.min(fromT, p.scoreTime);
      const later = p.scoreTime >= fromT ? m : infoMap.measures[barAtScoreTime(infoMap.measures, fromT) - 1];
      onRange({ start: a, end: later ? later.startTime + later.duration : Math.max(fromT, p.scoreTime) });
      return;
    }
    onPick(p);
  };

  /* ---------------- what is drawn ---------------- */

  const first = Math.max(0, view.first - OVERSCAN);
  const last = sheet ? Math.min(sheet.rows.length - 1, view.last + OVERSCAN) : -1;
  const shownBars = useMemo(() => {
    if (!sheet) return [] as Array<[number, BarGeometry]>;
    const out: Array<[number, BarGeometry]> = [];
    for (const [idx, bar] of sheet.bars) if (bar.system >= first && bar.system <= last) out.push([idx, bar]);
    return out;
  }, [sheet, first, last]);

  const spotX = (spot: NoteSpot): { bar: BarGeometry; x: number } | null => {
    const idx = written[spot.measure - 1];
    const bar = idx === undefined ? undefined : sheet?.bars.get(idx);
    if (!bar || bar.system < first || bar.system > last) return null;
    return { bar, x: xAtStamp(bar, timeToMusicalFraction(infoMap, spot.measure, spot.position)) };
  };
  const rangeSpans = useMemo(() => {
    if (!range || !sheet) return [];
    const out: Array<{ key: string; left: number; top: number; width: number; height: number }> = [];
    infoMap.measures.forEach((m, k) => {
      const a = Math.max(range.start, m.startTime);
      const b = Math.min(range.end, m.startTime + m.duration);
      if (b - a <= 1e-6) return;
      const bar = sheet.bars.get(written[k]);
      if (!bar || bar.system < first || bar.system > last) return;
      const x0 = a <= m.startTime + 1e-6 ? bar.box.left : xAtStamp(bar, timeToMusicalFraction(infoMap, k + 1, (a - m.startTime) / m.duration));
      const x1 = b >= m.startTime + m.duration - 1e-6 ? bar.box.left + bar.box.width : xAtStamp(bar, timeToMusicalFraction(infoMap, k + 1, (b - m.startTime) / m.duration));
      out.push({ key: `${k}`, left: x0, top: bar.box.top - PAD_Y, width: Math.max(2, x1 - x0), height: bar.box.height + PAD_Y * 2 });
    });
    return out;
  }, [range, sheet, infoMap, written, first, last]);
  const rangeLabel = range
    ? `${barNumber(infoMap, barAtScoreTime(infoMap.measures, range.start))}–${barNumber(infoMap, barAtScoreTime(infoMap.measures, Math.max(range.start, range.end - 1e-3)))}`
    : "";

  // the ruler's box: written bars on the rows in view
  const inView = useMemo(() => {
    if (!sheet) return null;
    const a = sheet.rows[view.first];
    const b = sheet.rows[view.last];
    return a && b ? { firstWritten: a.firstBar, lastWritten: b.lastBar } : null;
  }, [sheet, view.first, view.last]);

  const playingBar = barNumber(infoMap, currentMeasure);
  const cueAt = cue ? spotX(cue) : null;
  /** lines and labels keep their on-screen size whatever the zoom */
  const px = (n: number) => n / scale;

  return (
    <div
      ref={rootRef}
      className={cx("flex min-w-0 flex-col", fill && "relative h-full min-h-0 w-full overflow-hidden", className)}
      onPointerEnter={() => {
        hotRef.current = true;
      }}
      onPointerLeave={() => {
        hotRef.current = false;
      }}
    >
      <div
        className={cx(
          "flex flex-wrap items-center justify-between gap-x-3 gap-y-2",
          // on Sync the controls float over the top of the score window (owner: no buffer rows)
          fill ? "absolute left-2 right-5 top-1.5 z-20 rounded-md bg-paper/90 px-1.5 py-0.5 shadow-sm backdrop-blur-sm" : "px-1 pb-2",
        )}
        data-score-toolbar
      >
        <div className="flex items-center gap-1">
          <Tooltip label="Previous page (Page Up)">
            <button
              type="button"
              className="rounded-full p-1 text-ink-3 hover:bg-paper-3 hover:text-ink disabled:opacity-30"
              onClick={() => browseToPage(view.page - 1)}
              disabled={!sheet || view.page === 0}
              aria-label="Previous page"
            >
              <ChevronLeft size={15} />
            </button>
          </Tooltip>
          <span className="tnum min-w-[12em] text-center text-[12.5px] text-ink-2" aria-live="polite">
            {sheet && topRow ? (
              <>
                Page {view.page + 1}
                {allLaidOut ? <span className="text-ink-3"> of {pageCount}</span> : null}
                <span className="text-ink-3">
                  {" · "}
                  {topRow.lastBar > topRow.firstBar ? `bars ${barLabel(topRow.firstBar)}–${barLabel(topRow.lastBar)}` : `bar ${barLabel(topRow.firstBar)}`} of {lastLabel}
                </span>
              </>
            ) : (
              "—"
            )}
          </span>
          <Tooltip label="Next page (Page Down)">
            <button
              type="button"
              className="rounded-full p-1 text-ink-3 hover:bg-paper-3 hover:text-ink disabled:opacity-30"
              onClick={() => browseToPage(view.page + 1)}
              disabled={!sheet || view.page >= pageCount - 1}
              aria-label="Next page"
            >
              <ChevronRight size={15} />
            </button>
          </Tooltip>
          <form
            className="ml-2"
            onSubmit={(e) => {
              e.preventDefault();
              submitGoto();
            }}
          >
            <input
              ref={gotoRef}
              value={gotoText}
              onChange={(e) => {
                setGotoText(e.target.value);
                if (gotoError) setGotoError(null);
              }}
              onKeyDown={(e) => {
                if (e.key === "Escape") {
                  setGotoText("");
                  setGotoError(null);
                  e.currentTarget.blur();
                }
              }}
              placeholder="Go to bar, letter, 1:23"
              aria-label="Go to a bar, rehearsal mark or time (Ctrl or Cmd + G)"
              aria-invalid={gotoError ? true : undefined}
              className="h-7 w-[13.5em] rounded-full border border-line bg-paper-2 px-3 text-[12px] text-ink placeholder:text-ink-4 focus:border-brass focus:outline-none"
            />
          </form>
        </div>
        <div className="flex items-center gap-3 text-[12px] text-ink-3">
          {busy && <span className="text-ink-3">Laying out…</span>}
          <div className="flex items-center gap-1">
            <button type="button" className="rounded-full p-1 hover:bg-paper-3 hover:text-ink disabled:opacity-30" onClick={() => changeZoom(viewZoom - 0.1)} disabled={viewZoom <= VIEW_MIN} aria-label="Zoom out">
              <Minus size={13} />
            </button>
            <span className="tnum min-w-[3em] text-center text-ink-2" aria-live="polite" aria-label={`Zoom ${zoomPct}%`}>
              {zoomPct}%
            </span>
            <button type="button" className="rounded-full p-1 hover:bg-paper-3 hover:text-ink disabled:opacity-30" onClick={() => changeZoom(viewZoom + 0.1)} disabled={viewZoom >= VIEW_MAX} aria-label="Zoom in">
              <Plus size={13} />
            </button>
            <button type="button" className={cx("rounded px-1.5 py-0.5 hover:bg-paper-3 hover:text-ink", viewZoom === 1 && "text-ink-2")} onClick={() => setViewZoom(1)}>
              Fit width
            </button>
            <button type="button" className="rounded px-1.5 py-0.5 hover:bg-paper-3 hover:text-ink" onClick={fitPage}>
              Fit page
            </button>
            {!fill && (
            <Tooltip label={expanded ? "Shorter panel" : "Taller panel"}>
              <button type="button" className="rounded-full p-1 hover:bg-paper-3 hover:text-ink" onClick={() => setExpanded((v) => !v)} aria-label={expanded ? "Shorter score panel" : "Taller score panel"} aria-pressed={expanded}>
                {expanded ? <Minimize2 size={13} /> : <Maximize2 size={13} />}
              </button>
            </Tooltip>
            )}
          </div>
          <div className="flex items-center gap-2">
            <span aria-hidden>Follow</span>
            <Toggle size="sm" ariaLabel="Follow playback" checked={follow} onChange={(v) => (v ? backToPlayhead() : stopFollowing())} />
          </div>
        </div>
      </div>
      {gotoError && (
        <p className={cx("text-[12px] text-danger", fill ? "absolute left-3 top-11 z-20 rounded bg-paper/95 px-2 py-1 shadow-sm" : "px-2 pb-2")} role="alert">
          {gotoError}
        </p>
      )}

      {!fill && <ScoreRuler
        infoMap={infoMap}
        written={written}
        inView={inView}
        markers={mode === "sync" ? markers?.map((m) => ({ measure: m.measure, position: m.position })) : undefined}
        cue={cue ?? null}
        range={range ?? null}
        headRef={rulerHeadRef}
        showHead={!!clock}
        onBrowse={(n) => {
          const idx = written[n - 1];
          if (idx !== undefined) browseToBar(idx);
        }}
        onCue={(n) => {
          const m = infoMap.measures[n - 1];
          if (m) onPick({ measure: n, position: 0, scoreTime: m.startTime });
        }}
        onPlay={(n) => {
          const m = infoMap.measures[n - 1];
          if (m) onPlayFrom({ measure: n, position: 0, scoreTime: m.startTime });
        }}
      />}

      <div className={cx("relative", fill && "min-h-0 flex-1")}>
        <div
          ref={scrollRef}
          onScroll={() => requestAnimationFrame(measureView)}
          className={cx(
            "scroll-thin relative overflow-auto bg-paper-3",
            !fill && "rounded-[var(--radius)] border border-line",
            fill ? "h-full" : expanded ? "h-[calc(100vh-180px)] min-h-[460px]" : "h-[460px]",
          )}
        >
          {!sheet && <p className="px-3 py-6 text-[12px] text-ink-3">Laying out the score…</p>}
          {/* the scaled sheet: its box is the scaled size, so the panel scrolls over the pages as they look */}
          <div className="relative mx-auto" style={{ width: PAGE.width * scale, height: (sheet?.height ?? 0) * scale, marginTop: DESK, marginBottom: DESK }}>
            <div
              className="absolute left-0 top-0 origin-top-left"
              style={{ width: PAGE.width, height: sheet?.height ?? 0, transform: `scale(${scale})` }}
              onMouseLeave={() => setHover(null)}
            >
              {sheet?.pages.map((p, k) => (
                <div key={k} className="score-page absolute left-0" style={{ top: p.top, height: p.height, width: PAGE.width }} aria-hidden />
              ))}
              {sheet &&
                sheet.rows.slice(first, last + 1).map((r, j) =>
                  r.markup ? (
                    <SystemSlot key={`${layout.key}:${first + j}`} markup={r.markup} top={r.top} height={r.height} />
                  ) : (
                    <div key={`pending:${r.chunk}`} className="absolute inset-x-0 px-12 pt-12 text-ink-3" style={{ top: r.top, height: r.height, fontSize: px(12) }} aria-hidden>
                      Laying out bars {barLabel(r.firstBar)}–{barLabel(r.lastBar)}…
                    </div>
                  ),
                )}

              {rangeSpans.map((r) => (
                <div key={r.key} className="pointer-events-none absolute rounded-[3px] bg-[var(--score-range)]" style={{ left: r.left, top: r.top, width: r.width, height: r.height }} aria-hidden />
              ))}

              {shownBars.map(([idx, bar]) => {
                const n = playbackBarFor(written, idx, currentMeasure);
                if (n === null) return null;
                const active = idx === currentWritten;
                const conf = confidence?.get(n);
                return (
                  <button
                    key={idx}
                    type="button"
                    onClick={(e) => click(idx, bar, e)}
                    onContextMenu={
                      onSpotContextMenu
                        ? (e) => {
                            const p = pickedAt(idx, bar, e);
                            if (!p) return;
                            e.preventDefault();
                            onPick(p);
                            onSpotContextMenu(p, { x: e.clientX, y: e.clientY });
                          }
                        : undefined
                    }
                    onDoubleClick={(e) => {
                      const p = pickedAt(idx, bar, e);
                      if (p) onPlayFrom(p);
                    }}
                    onMouseMove={(e) => {
                      const p = spotAt(bar, e);
                      setHover((h) => (h && h.idx === idx && Math.abs(h.x - p.x) < 0.5 ? h : { idx, x: p.x, stamp: p.stamp }));
                    }}
                    className={cx("score-bar absolute rounded-[3px]", active && "score-bar-current")}
                    style={{ left: bar.box.left, top: bar.box.top - PAD_Y, width: bar.box.width, height: bar.box.height + PAD_Y * 2, ["--strip" as string]: `${px(3)}px` }}
                    aria-label={`${mode === "sync" ? "Select" : "Start from"} bar ${barNumber(infoMap, n)}`}
                    aria-current={active ? "true" : undefined}
                  >
                    {conf !== undefined && <span className="absolute inset-x-1 rounded-full" style={{ bottom: -px(4), height: px(3), background: confidenceBand(conf).token }} aria-hidden />}
                  </button>
                );
              })}

              {mode === "sync" &&
                markers?.map((mk) => {
                  const s = spotX(mk);
                  if (!s) return null;
                  const style = { left: s.x, top: s.bar.box.top - PAD_Y - 2, height: s.bar.box.height + PAD_Y * 2 + 2, ["--k" as string]: 1 / scale };
                  const cls = cx("score-marker absolute", mk.state === "pending" && "score-marker-pending", mk.state === "deleted" && "score-marker-deleted");
                  return onMarkerPress ? (
                    <button
                      key={`${mk.id}:${mk.state}`}
                      type="button"
                      className={cx(cls, "score-marker-button")}
                      style={style}
                      data-marker-id={mk.id}
                      data-state={mk.state}
                      aria-label={mk.name}
                      onClick={(e) => {
                        e.stopPropagation();
                        onMarkerPress(mk.id, e.currentTarget);
                      }}
                    />
                  ) : (
                    <div key={`${mk.id}:${mk.state}`} className={cx(cls, "pointer-events-none")} style={style} aria-hidden />
                  );
                })}
              {cueAt && (
                <div
                  className="score-cue pointer-events-none absolute"
                  style={{ left: cueAt.x, top: cueAt.bar.box.top - PAD_Y - 2, height: cueAt.bar.box.height + PAD_Y * 2 + 2, ["--k" as string]: 1 / scale }}
                  data-testid="score-cue"
                  aria-hidden
                />
              )}

              {hover &&
                (() => {
                  const bar = sheet?.bars.get(hover.idx);
                  const n = playbackBarFor(written, hover.idx, currentMeasure);
                  if (!bar || n === null) return null;
                  return (
                    <>
                      <div className="score-hover-line pointer-events-none absolute" style={{ left: hover.x, top: bar.box.top - PAD_Y, height: bar.box.height + PAD_Y * 2, borderLeftWidth: px(1.5) }} aria-hidden />
                      <div
                        className="score-hover-label pointer-events-none absolute origin-bottom-left whitespace-nowrap"
                        style={{ left: hover.x + px(6), top: bar.box.top - PAD_Y - px(22), transform: `scale(${1 / scale})` }}
                        aria-hidden
                      >
                        {mode === "sync" ? "Select " : "Start from "}
                        {describe(n, hover.stamp)}
                      </div>
                    </>
                  );
                })()}

              {clock && <div ref={playheadRef} className="score-playhead pointer-events-none absolute left-0 top-0 rounded-full opacity-0" style={{ width: px(2) }} data-testid="score-playhead" aria-hidden />}
            </div>
          </div>
          {/* laid out off screen; engraveScore turns the drawing into markup for the rows above */}
          <div ref={hostRef} className="engraved-score pointer-events-none absolute left-[-100000px] top-0 invisible" aria-hidden />
        </div>

        {!follow && clock && (
          <div className="pointer-events-none absolute inset-x-0 bottom-3 flex justify-center">
            <button
              type="button"
              onClick={backToPlayhead}
              className="pointer-events-auto flex items-center gap-1.5 rounded-full bg-ink px-3 py-1.5 text-[12px] text-paper shadow-lg hover:bg-ink-2"
            >
              <Locate size={13} aria-hidden /> Playing bar {playingBar} · Back
            </button>
          </div>
        )}
      </div>
      <div className={cx("flex flex-wrap items-center justify-between gap-2", fill ? "pointer-events-none absolute bottom-2 left-2 z-20 [&>*]:pointer-events-auto" : "min-h-7 px-1 pt-1.5")}>
        {!fill && (
          <p className="text-[11px] text-ink-3">
            Click a note to set the start point; double-click to play from it. Shift-click a second note to repeat the passage.
          </p>
        )}
        {range && onRange && (
          <span className="flex items-center gap-1.5 rounded-full bg-brass-soft px-2.5 py-1 text-[12px] text-brass-3">
            <Repeat size={12} aria-hidden /> Repeating bars {rangeLabel}
            <button type="button" className="-mr-1 rounded-full p-0.5 hover:bg-brass/20" onClick={() => onRange(null)} aria-label="Stop repeating">
              <X size={12} />
            </button>
          </span>
        )}
      </div>
    </div>
  );
}

/** One system's SVG, parsed into the page while it is near the view. */
function SystemSlot({ markup, top, height }: { markup: string; top: number; height: number }) {
  const ref = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    // markup made by engraveScore from OSMD's own drawing of the uploaded score (VexFlow paths and text)
    el.innerHTML = markup;
    return () => {
      el.innerHTML = "";
    };
  }, [markup]);
  return <div ref={ref} className="engraved-score absolute left-0" style={{ top, height }} />;
}

type OsmdClass = typeof import("opensheetmusicdisplay").OpenSheetMusicDisplay;

/** An OpenSheetMusicDisplay drawing into `host` with the panel's options. */
function newOsmd(Osmd: OsmdClass, host: HTMLElement): OpenSheetMusicDisplay {
  host.innerHTML = "";
  return new Osmd(host, {
    autoResize: false,
    backend: "svg",
    drawTitle: false,
    drawSubtitle: false,
    drawComposer: false,
    drawLyricist: false,
    drawCredits: false,
    drawPartNames: true,
    drawPartAbbreviations: true,
    drawMeasureNumbers: true,
    drawMeasureNumbersOnlyAtSystemStart: false,
    disableCursor: true,
    // the engraver's own line and page breaks, as MuseScore shows them (fitStaff makes sure the lines fit)
    newSystemFromXML: true,
    newSystemFromNewPageInXML: true,
  });
}

/**
 * The staff size a first layout says to use (equal to `staff` when it is right):
 * - with the file's own breaks: every line must start where the file breaks
 *   (OSMD adds a break, and leaves a short line, when the file's line does not
 *   fit our page width), and every file page must fit on a page;
 * - otherwise: a system too tall for a page shrinks, and a system that can
 *   only go one to a page grows to fill it.
 */
function fitStaff(e: Engraving, staff: number, chunkStart: number, hints: LayoutHints | null): number {
  const room = PAGE.height - 2 * PAGE.margin;
  const heights = e.systems.map((_, j) => e.cuts[j + 1] - e.cuts[j]);
  const clamp = (z: number) => Math.max(STAFF_MIN, Math.min(STAFF_MAX, Math.floor(z * 100) / 100));
  if (hints) {
    const extra = e.systems.some((s) => s.firstBar !== chunkStart && !hints.newSystem.has(s.firstBar));
    if (extra && staff > STAFF_MIN) return clamp(staff * 0.88);
    let tallestPage = 0;
    let pageH = 0;
    e.systems.forEach((s, j) => {
      if (hints.newPage.has(s.firstBar)) pageH = 0;
      pageH += heights[j];
      tallestPage = Math.max(tallestPage, pageH);
    });
    return tallestPage > room ? clamp((staff * room) / tallestPage) : staff;
  }
  const tallest = Math.max(0, ...heights);
  if (tallest > 0 && tallest > room / 2) return clamp((staff * room * 0.96) / tallest);
  return staff;
}

const REDUCED_QUERY = "(prefers-reduced-motion: reduce)";

function subscribeReducedMotion(onChange: () => void): () => void {
  if (typeof window === "undefined" || !window.matchMedia) return () => {};
  const mq = window.matchMedia(REDUCED_QUERY);
  mq.addEventListener("change", onChange);
  return () => mq.removeEventListener("change", onChange);
}

function usePrefersReducedMotion(): boolean {
  return useSyncExternalStore(
    subscribeReducedMotion,
    () => typeof window !== "undefined" && !!window.matchMedia && window.matchMedia(REDUCED_QUERY).matches,
    () => false,
  );
}
