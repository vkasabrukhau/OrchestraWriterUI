import type { OpenSheetMusicDisplay } from "opensheetmusicdisplay";
import { normalizeOnsets, type Onset } from "./playhead";
import { systemAt, systemCuts, type Band } from "./systems";

/**
 * Lay the whole score out once with OpenSheetMusicDisplay and cut the sheet
 * into one SVG per system (ADR 0016). Line breaks are fixed for a given
 * width, zoom and set of visible parts, so a bar is always in the same place,
 * and turning a page is a scroll, never a redraw. Only the systems near the
 * view are attached to the document (see EngravedScore).
 *
 * Browser only: reads OSMD's graphical model and SVG bounding boxes. The
 * graphical model is not public API; an OSMD upgrade should re-check this in
 * Chromium.
 */

/** OSMD layout units → CSS pixels at zoom 1 (VexFlowMusicSheetDrawer.unitInPixels) */
const UNIT_PX = 10;

export interface Box {
  left: number;
  top: number;
  width: number;
  height: number;
}

/** One staff of one bar: where it is, and its note onsets. */
export interface StaffColumn {
  top: number;
  bottom: number;
  onsets: Onset[];
}

export interface BarGeometry {
  /** the bar's column across its visible staves, CSS px on the sheet */
  box: Box;
  /** onsets merged across staves (for the playhead) */
  onsets: Onset[];
  /** per staff, top to bottom (for clicks: snap to the staff that was clicked) */
  staves: StaffColumn[];
  /** system index */
  system: number;
}

export interface EngravedSystem {
  /**
   * the system's SVG as markup: kept as a string, not as DOM, because a large
   * score has hundreds of thousands of nodes and holding them detached makes
   * garbage collection pause playback; it is parsed when the system comes
   * into view (about 20 ms for a 40-staff system)
   */
  markup: string;
  /** written indices (0-based) of the first and last bar on the system */
  firstBar: number;
  lastBar: number;
}

export interface Engraving {
  width: number;
  height: number;
  /** system k owns the band [cuts[k], cuts[k + 1]) of the sheet, CSS px */
  cuts: number[];
  systems: EngravedSystem[];
  /** by written index */
  bars: Map<number, BarGeometry>;
  /** milliseconds spent laying out and drawing */
  renderMs: number;
}

type GMeasure = OpenSheetMusicDisplay["GraphicSheet"]["MeasureList"][number][number];

/**
 * Lay out and draw a range of bars (every bar by default) into `host` (which must be in the document and
 * laid out, though it may be invisible), then move the drawing into one SVG
 * per system. `host` is left empty.
 */
export function engraveScore(
  osmd: OpenSheetMusicDisplay,
  host: HTMLElement,
  opts: {
    zoom: number;
    visibleParts?: Set<string>;
    /** written bars to draw (0-based, inclusive, in the loaded file); all when omitted */
    from?: number;
    to?: number;
    /** the loaded file is a slice starting at this written bar of the whole score (see slice.ts) */
    indexOffset?: number;
  },
): Engraving {
  const t0 = performance.now();
  const from = opts.from ?? 0;
  const to = opts.to ?? Number.MAX_SAFE_INTEGER - 1;
  const offset = opts.indexOffset ?? 0;
  for (const inst of osmd.Sheet.Instruments) inst.Visible = !opts.visibleParts || opts.visibleParts.size === 0 || opts.visibleParts.has(inst.IdString);
  osmd.setOptions({ drawFromMeasureNumber: from + 1, drawUpToMeasureNumber: to + 1 });
  osmd.zoom = opts.zoom;
  osmd.render();
  const renderMs = performance.now() - t0;

  const scale = UNIT_PX * osmd.zoom;
  const systemsList = osmd.GraphicSheet.MusicPages.flatMap((p) => p.MusicSystems);
  const systemIndex = new Map(systemsList.map((s, k) => [s, k]));

  // per bar: the column over its staves, per-staff onsets
  const bars = new Map<number, BarGeometry>();
  const bands: Band[] = systemsList.map(() => ({ top: Infinity, bottom: -Infinity }));
  const firstBar = systemsList.map(() => Infinity);
  const lastBar = systemsList.map(() => -Infinity);
  // the list also keeps bars outside the draw range, with stale positions
  const visible = (gm: GMeasure) =>
    !!gm &&
    !!gm.parentSourceMeasure &&
    gm.parentSourceMeasure.measureListIndex >= from &&
    gm.parentSourceMeasure.measureListIndex <= to &&
    !(gm.ParentStaff?.ParentInstrument && !gm.ParentStaff.ParentInstrument.Visible);

  for (const row of osmd.GraphicSheet.MeasureList) {
    for (const gm of row) {
      if (!visible(gm)) continue;
      const k = systemIndex.get(gm.ParentMusicSystem);
      if (k === undefined) continue;
      const idx = gm.parentSourceMeasure.measureListIndex + offset;
      const pos = gm.PositionAndShape.AbsolutePosition;
      const size = gm.PositionAndShape.Size;
      const box: Box = { left: pos.x * scale, top: pos.y * scale, width: size.width * scale, height: Math.max(size.height, 4) * scale };
      bands[k].top = Math.min(bands[k].top, box.top);
      bands[k].bottom = Math.max(bands[k].bottom, box.top + box.height);
      firstBar[k] = Math.min(firstBar[k], idx);
      lastBar[k] = Math.max(lastBar[k], idx);

      const length = gm.parentSourceMeasure.Duration?.RealValue ?? 0;
      let onsets: Onset[] = [];
      if (gm.hasOnlyRests) {
        // a whole-bar rest is engraved centered: the bar's music starts after the clef/key/time
        onsets = [{ stamp: 0, x: (pos.x + (gm.beginInstructionsWidth ?? 0) + 1) * scale }];
      } else if (length > 0) {
        for (const se of gm.staffEntries ?? []) {
          const stamp = se.relInMeasureTimestamp?.RealValue;
          const x = se.PositionAndShape?.AbsolutePosition?.x;
          if (stamp !== undefined && x !== undefined) onsets.push({ stamp: stamp / length, x: x * scale });
        }
        onsets = normalizeOnsets(onsets);
      }
      const staff: StaffColumn & { rests: boolean } = { top: box.top, bottom: box.top + box.height, onsets, rests: !!gm.hasOnlyRests };

      const prev = bars.get(idx);
      if (!prev) {
        bars.set(idx, { box, onsets: [], staves: [staff], system: k });
      } else {
        const top = Math.min(prev.box.top, box.top);
        const bottom = Math.max(prev.box.top + prev.box.height, box.top + box.height);
        prev.box = { left: Math.min(prev.box.left, box.left), top, width: Math.max(prev.box.width, box.width), height: bottom - top };
        prev.staves.push(staff);
      }
    }
  }
  for (const bar of bars.values()) {
    bar.staves.sort((a, b) => a.top - b.top);
    const playing = bar.staves.filter((s) => !(s as { rests?: boolean }).rests).flatMap((s) => s.onsets);
    // bars where every visible part rests sweep from the start of the music to the barline
    bar.onsets = playing.length ? normalizeOnsets(playing) : (bar.staves[0]?.onsets ?? []);
  }

  const svg = host.querySelector("svg");
  if (!svg) throw new Error("The score drew nothing.");
  const cssWidth = svg.width.baseVal.value || svg.getBoundingClientRect().width;
  const cssHeight = svg.height.baseVal.value || svg.getBoundingClientRect().height;
  const vb = svg.viewBox.baseVal;
  const hasViewBox = vb && vb.width > 0 && vb.height > 0;
  /** CSS px per SVG user unit */
  const k = hasViewBox ? cssWidth / vb.width : 1;
  const vbX = hasViewBox ? vb.x : 0;
  const vbY = hasViewBox ? vb.y : 0;

  const usedBands = bands.map((b) => (Number.isFinite(b.top) ? b : { top: 0, bottom: 0 }));
  const cuts = systemCuts(usedBands, cssHeight);

  // assign each drawn element to the system its middle falls in
  const shared: Element[] = [];
  const owned: Element[][] = systemsList.map(() => []);
  for (const el of Array.from(svg.children)) {
    const tag = el.tagName.toLowerCase();
    if (tag === "defs" || tag === "style") {
      shared.push(el);
      continue;
    }
    let mid = 0;
    try {
      const bb = (el as SVGGraphicsElement).getBBox();
      mid = ((bb.y - vbY) + bb.height / 2) * k;
    } catch {
      mid = 0;
    }
    owned[systemAt(cuts, mid)]?.push(el);
  }

  const systems: EngravedSystem[] = systemsList.map((_, s) => {
    const top = cuts[s];
    const height = Math.max(1, cuts[s + 1] - top);
    const piece = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    for (const attr of Array.from(svg.attributes)) {
      if (attr.name === "width" || attr.name === "height" || attr.name === "viewBox" || attr.name === "id") continue;
      piece.setAttribute(attr.name, attr.value);
    }
    piece.setAttribute("width", String(cssWidth));
    piece.setAttribute("height", String(height));
    piece.setAttribute("viewBox", `${vbX} ${vbY + top / k} ${cssWidth / k} ${height / k}`);
    piece.style.display = "block";
    piece.style.overflow = "hidden";
    for (const el of shared) piece.appendChild(el.cloneNode(true));
    for (const el of owned[s]) piece.appendChild(el);
    return {
      markup: piece.outerHTML,
      firstBar: Number.isFinite(firstBar[s]) ? firstBar[s] : 0,
      lastBar: Number.isFinite(lastBar[s]) ? lastBar[s] : 0,
    };
  });
  host.innerHTML = "";
  return { width: cssWidth, height: cuts[cuts.length - 1], cuts, systems, bars, renderMs };
}

/** The onset nearest to `x` on the staff under `y` (or the merged onsets off any staff), as a bar fraction. */
export function pickInBar(bar: BarGeometry, x: number, y: number): { stamp: number; x: number } {
  const staff = bar.staves.find((s) => y >= s.top - 4 && y <= s.bottom + 4);
  const list = staff?.onsets.length ? staff.onsets : bar.onsets;
  if (list.length === 0) {
    const frac = bar.box.width > 0 ? Math.max(0, Math.min(1, (x - bar.box.left) / bar.box.width)) : 0;
    return { stamp: frac, x };
  }
  let best = list[0];
  for (const o of list) if (Math.abs(o.x - x) < Math.abs(best.x - x)) best = o;
  return best;
}

/** x of a bar fraction on the bar's merged onsets (an exact onset when one sits there). */
export function xAtStamp(bar: BarGeometry, stamp: number): number {
  const list = bar.onsets;
  if (list.length === 0) return bar.box.left + stamp * bar.box.width;
  let best = list[0];
  for (const o of list) if (Math.abs(o.stamp - stamp) < Math.abs(best.stamp - stamp)) best = o;
  if (Math.abs(best.stamp - stamp) < 1e-4) return best.x;
  // between onsets: interpolate like the playhead
  let i = 0;
  while (i + 1 < list.length && list[i + 1].stamp <= stamp) i++;
  const a = list[i];
  const b = list[i + 1] ?? { stamp: 1, x: bar.box.left + bar.box.width - 4 };
  if (stamp <= a.stamp || b.stamp <= a.stamp) return a.x;
  return a.x + ((stamp - a.stamp) / (b.stamp - a.stamp)) * (b.x - a.x);
}
