/**
 * Cut a partwise MusicXML score into smaller scores of consecutive bars, so a
 * chunk of a large score can be engraved without OpenSheetMusicDisplay
 * processing every bar (ADR 0016: its per-render cost grows with the whole
 * score, about 0.4 s on a 42-part, 480-bar score even for 8 bars).
 *
 * Each slice keeps the header (part list, defaults) and, per part, the bars
 * asked for. The state an earlier bar set up (divisions, key, time, clefs,
 * staves, transposition) is copied into the slice's first bar; a time
 * signature carried in that way is not printed (it is not a change). Printed
 * bar numbers stay as written. Ties and slurs that cross into a slice start
 * without their beginning, which OSMD draws as from the edge.
 *
 * Browser and jsdom only (DOMParser / XMLSerializer).
 */

/** Attribute children that carry state across bars, keyed by tag and their staff/number. */
const CARRIED = new Set(["divisions", "key", "time", "staves", "part-symbol", "instruments", "clef", "staff-details", "transpose"]);

/**
 * Layout the file asks for, and where breaking is natural, by written bar
 * (0-based). Engravers (MuseScore, Sibelius, Finale) write their line and page
 * breaks into MusicXML as <print new-system/new-page>; honoring them is most
 * of why a score looks right in MuseScore.
 */
export interface LayoutHints {
  /** bars that start a new page in the file */
  newPage: Set<number>;
  /** bars that start a new line (system) in the file */
  newSystem: Set<number>;
  /**
   * how natural a page turn is just before bar i: final or double barlines,
   * repeats, fermatas held by much of the orchestra, rehearsal marks, key,
   * time and tempo changes (0 = nothing special)
   */
  strength: number[];
}

export interface ScoreSlicer {
  /** written bars in the score (the first part's) */
  count: number;
  hints: LayoutHints;
  /** MusicXML of written bars [from, to] (0-based, inclusive) */
  slice(from: number, to: number): string;
}

/** A slicer for a partwise score, or null when the text is not one (the caller lays out the whole file). */
export function makeSlicer(xml: string): ScoreSlicer | null {
  if (typeof DOMParser === "undefined") return null;
  const doc = new DOMParser().parseFromString(xml, "application/xml");
  const root = doc.documentElement;
  if (!root || root.tagName !== "score-partwise" || doc.getElementsByTagName("parsererror").length > 0) return null;
  const parts = childElements(root, "part");
  if (parts.length === 0) return null;
  const measures = parts.map((p) => childElements(p, "measure"));
  const count = measures[0].length;
  if (count === 0) return null;
  const header = Array.from(root.children).filter((c) => c.tagName !== "part" && c.tagName !== "credit");

  /** per part, the carried attribute elements in force at the start of each bar (computed on demand, cached) */
  const stateCache = new Map<string, Map<string, Element>>();
  const stateAt = (p: number, bar: number): Map<string, Element> => {
    const key = `${p}:${bar}`;
    const hit = stateCache.get(key);
    if (hit) return hit;
    const state = bar === 0 ? new Map<string, Element>() : new Map(stateAt(p, bar - 1));
    if (bar > 0) {
      const m = measures[p][bar - 1];
      if (m) for (const attrs of childElements(m, "attributes")) for (const el of Array.from(attrs.children)) if (CARRIED.has(el.tagName)) state.set(`${el.tagName}:${el.getAttribute("number") ?? ""}`, el);
    }
    stateCache.set(key, state);
    return state;
  };

  const serializer = new XMLSerializer();
  return {
    count,
    hints: readHints(measures, count),
    slice(from: number, to: number): string {
      const a = Math.max(0, Math.min(count - 1, from));
      const b = Math.max(a, Math.min(count - 1, to));
      const out = doc.implementation.createDocument(null, "score-partwise", null);
      const top = out.documentElement;
      for (const attr of Array.from(root.attributes)) top.setAttribute(attr.name, attr.value);
      for (const h of header) top.appendChild(out.importNode(h, true));
      parts.forEach((part, p) => {
        const np = out.importNode(part, false) as Element;
        for (let i = a; i <= b; i++) {
          const src = measures[p][i];
          if (!src) continue;
          const m = out.importNode(src, true) as Element;
          if (i === a && a > 0) carryInto(out, m, stateAt(p, a));
          np.appendChild(m);
        }
        top.appendChild(np);
      });
      return `<?xml version="1.0" encoding="UTF-8"?>\n${serializer.serializeToString(out)}`;
    },
  };
}

/** Put the carried state into a slice's first bar, without overriding what the bar sets itself. */
function carryInto(doc: XMLDocument, m: Element, state: Map<string, Element>) {
  if (state.size === 0) return;
  let attrs = childElements(m, "attributes")[0];
  if (!attrs) {
    attrs = doc.createElement("attributes");
    // attributes come before the bar's notes; a <print> (layout hint) may come first
    const first = Array.from(m.children).find((c) => c.tagName !== "print");
    m.insertBefore(attrs, first ?? null);
  }
  const own = new Set(Array.from(attrs.children).map((el) => `${el.tagName}:${el.getAttribute("number") ?? ""}`));
  // MusicXML orders attribute children: divisions, key, time, staves, part-symbol, instruments, clef, staff-details, transpose
  const order = ["divisions", "key", "time", "staves", "part-symbol", "instruments", "clef", "staff-details", "transpose"];
  const carried = [...state].filter(([k]) => !own.has(k)).map(([, el]) => el);
  for (const el of carried.sort((x, y) => order.indexOf(x.tagName) - order.indexOf(y.tagName))) {
    const copy = doc.importNode(el, true) as Element;
    // a carried time signature is not a change: do not print it
    if (copy.tagName === "time") copy.setAttribute("print-object", "no");
    const before = Array.from(attrs.children).find((c) => order.indexOf(c.tagName) > order.indexOf(copy.tagName));
    attrs.insertBefore(copy, before ?? null);
  }
}

function readHints(measures: Element[][], count: number): LayoutHints {
  const newPage = new Set<number>();
  const newSystem = new Set<number>();
  const strength = new Array<number>(count).fill(0);
  const fermataParts = new Array<number>(count).fill(0);
  const parts = measures.length;
  measures.forEach((list, p) => {
    for (let i = 0; i < count; i++) {
      const m = list[i];
      if (!m) continue;
      for (const pr of childElements(m, "print")) {
        if (pr.getAttribute("new-page") === "yes" && i > 0) newPage.add(i);
        if ((pr.getAttribute("new-system") === "yes" || pr.getAttribute("new-page") === "yes") && i > 0) newSystem.add(i);
      }
      if (m.getElementsByTagName("fermata").length > 0) fermataParts[i]++;
      if (p !== 0) {
        if (m.getElementsByTagName("rehearsal").length > 0 && i > 0) strength[i] = Math.max(strength[i], 3);
        continue;
      }
      // barlines, attribute changes and directions, read from the first part
      for (const bl of childElements(m, "barline")) {
        const style = bl.getElementsByTagName("bar-style")[0]?.textContent ?? "";
        const repeat = bl.getElementsByTagName("repeat")[0]?.getAttribute("direction");
        const right = (bl.getAttribute("location") ?? "right") === "right";
        // a strong barline at the end of bar i means a natural turn before bar i + 1
        const at = right ? i + 1 : i;
        if (at <= 0 || at >= count) continue;
        let v = 0;
        if (style === "light-heavy") v = 4;
        else if (style === "light-light" || style === "heavy-light" || style === "heavy-heavy") v = 3;
        if (repeat === "backward" || repeat === "forward") v = Math.max(v, 3);
        strength[at] += v;
      }
      if (i > 0) {
        for (const a of childElements(m, "attributes")) {
          if (a.getElementsByTagName("key").length > 0 || a.getElementsByTagName("time").length > 0) strength[i] += 2;
        }
        if (m.getElementsByTagName("rehearsal").length > 0) strength[i] = Math.max(strength[i], 3);
        if (m.getElementsByTagName("metronome").length > 0 || Array.from(m.getElementsByTagName("sound")).some((s) => s.hasAttribute("tempo"))) strength[i] += 1;
      }
    }
  });
  // a fermata held by much of the orchestra ends a phrase: turn after it
  for (let i = 0; i + 1 < count; i++) {
    if (fermataParts[i] === 0) continue;
    strength[i + 1] += fermataParts[i] >= Math.max(1, parts * 0.3) ? 4 : 1;
  }
  for (const b of newPage) strength[b] += 10;
  return { newPage, newSystem, strength };
}

function childElements(el: Element, tag: string): Element[] {
  return Array.from(el.children).filter((c) => c.tagName === tag);
}
