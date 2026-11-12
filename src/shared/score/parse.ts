import { louder, type Dynamic } from "../dynamics";
import { MAX_PARTS, type InfoMap, type Instrument, type MeasureInfo, type Note, type StyleMarking } from "../info-map";
import { classifyInstrument } from "../sections";
import { decodeScoreBytes } from "./decode";
import type { ParseInput, ParseOutcome, ScoreMeta } from "./index";
import { abbreviateInstrumentName } from "./names";
import { expandRepeats, parseEndingNumbers, type BarFlags } from "./repeats";
import { DEFAULT_TEMPO, TempoMap, metronomeToQuarterBpm, type TempoEvent } from "./tempo";
import { child, childText, childrenOf, num, parseXml, type XEl } from "./xml";

/**
 * MusicXML → information map. Isomorphic (no DOM, no Node APIs) and
 * deterministic: the same bytes always give the same info map.
 *
 * Two passes:
 *  1. Per part, walk every written measure in document order and convert
 *     positions to quarter notes (divisions may change mid-part; voices move
 *     the cursor with backup/forward; chords share an onset).
 *  2. Expand repeats into playback order, build the tempo map, then emit notes
 *     in playback order so dynamics, pizzicato and ties carry across the
 *     order the music is actually played in.
 *
 * Measures in the info map are numbered 1..N in *playback* order (a repeated
 * passage gets new numbers on its second pass); `label` keeps the printed bar
 * number whenever it differs. Times are score seconds.
 */

const EPS = 1e-6;
const DEFAULT_DYNAMIC: Dynamic = "mp";
const STYLE_PRIORITY: StyleMarking[] = ["Marcato", "Accent", "Staccato", "Tenuto", "Pizzicato", "Tremolo", "Slur"];

export const PART_LIMIT_ERROR = (n: number) =>
  `${n} parts exceed the ${MAX_PARTS}-part limit. Combine or remove parts in your notation app and export the score again.`;

/* ------------------------------------------------------------------ */
/* Pass-1 shapes                                                       */
/* ------------------------------------------------------------------ */

interface WrittenNote {
  /** quarters from the start of the written measure */
  onsetQ: number;
  durQ: number;
  pitch: number;
  tieStart: boolean;
  tieStop: boolean;
  style: StyleMarking | null;
  /** note-level pizzicato="yes" */
  pizz: boolean;
  staff: string;
}

interface DynamicEvent {
  offsetQ: number;
  /** persistent dynamic from this point on */
  set: Dynamic | null;
  /** momentary accent (sfz, fp, ...) applied to notes starting exactly here */
  accent: Dynamic | null;
}

interface PizzEvent {
  offsetQ: number;
  on: boolean;
}

interface WrittenMeasure {
  label: string;
  extentQ: number;
  nominalQ: number | null;
  notes: WrittenNote[];
  dynamics: DynamicEvent[];
  pizz: PizzEvent[];
  tempos: Array<{ offsetQ: number; bpm: number }>;
  /** notes and rests carrying a fermata (quarters from the start of the written measure) */
  fermatas: Array<{ onsetQ: number; durQ: number }>;
  /** first rehearsal mark printed in the measure ("A", "12", "Coda") */
  rehearsal?: string;
  bar: BarFlags;
}

interface PartDef {
  id: string;
  name: string;
  abbreviation: string;
  instrumentName: string;
  instrumentSound: string;
  midiProgram: number | null;
  midiChannel: number | null;
}

interface RawPart {
  id: string;
  measures: XEl[];
}

/* ------------------------------------------------------------------ */
/* Entry point                                                         */
/* ------------------------------------------------------------------ */

export function parseMusicXml({ bytes, filename }: ParseInput): ParseOutcome {
  const decoded = decodeScoreBytes(bytes, filename);
  if (!decoded.ok) return decoded;
  const xml = parseXml(decoded.text);
  if (!xml.ok) return { ok: false, error: `${filename} is not a MusicXML score. ${xml.error}` };
  const root = xml.root;

  let rawParts: RawPart[];
  if (root.tag === "score-partwise") {
    rawParts = childrenOf(root, "part").map((p) => ({ id: p.attrs.id ?? "", measures: childrenOf(p, "measure") }));
  } else if (root.tag === "score-timewise") {
    rawParts = timewiseToPartwise(root);
  } else if (root.tag === "opus") {
    return { ok: false, error: `${filename} is a MusicXML opus (a collection of scores). Export a single score instead.` };
  } else {
    return { ok: false, error: `${filename} is not a MusicXML score (the document starts with <${root.tag}>, expected <score-partwise>).` };
  }

  const defs = readPartList(root);
  const partCount = Math.max(rawParts.length, defs.length);
  if (partCount > MAX_PARTS) return { ok: false, error: PART_LIMIT_ERROR(partCount) };
  if (rawParts.length === 0) return { ok: false, error: `${filename} has no parts.` };

  const warnings: string[] = [];
  const defById = new Map(defs.map((d) => [d.id, d]));
  const partDefs: PartDef[] = rawParts.map((p, i) => {
    const def = defById.get(p.id);
    if (def) return def;
    const id = p.id || `P${i + 1}`;
    return { id, name: id, abbreviation: "", instrumentName: "", instrumentSound: "", midiProgram: null, midiChannel: null };
  });
  for (const d of defs) {
    if (!rawParts.some((p) => p.id === d.id)) warnings.push(`Part "${d.name}" is listed but has no music; it was skipped.`);
  }

  // Pass 1: written measures per part.
  const read = rawParts.map((p, i) => readPart(p, partDefs[i].name, warnings));
  const written: WrittenMeasure[][] = read.map((r) => r.measures);
  const measureCount = written[0].length > 0 ? written[0].length : Math.max(...written.map((w) => w.length));
  if (measureCount === 0) return { ok: false, error: `${filename} has no measures.` };
  const mismatchedCounts = written.filter((w) => w.length !== measureCount).length;
  if (mismatchedCounts > 0) {
    warnings.push(`${mismatchedCounts} part(s) have a different number of measures than the first part; the first part's ${measureCount} measures are used.`);
  }

  // Master measure grid: the first part's lengths.
  const masterQ: number[] = [];
  const disagreements: string[] = [];
  for (let w = 0; w < measureCount; w++) {
    const first = written[0][w];
    let len = first && first.extentQ > EPS ? first.extentQ : 0;
    if (len === 0) len = Math.max(0, ...written.map((p) => p[w]?.extentQ ?? 0));
    if (len === 0) len = nominalAt(written[0], w) ?? 4;
    masterQ.push(len);
    for (let p = 1; p < written.length; p++) {
      const m = written[p][w];
      if (m && m.extentQ > EPS && Math.abs(m.extentQ - len) > 1e-4) disagreements.push(`${first?.label ?? w + 1} (${partDefs[p].name})`);
    }
  }
  if (disagreements.length > 0) {
    warnings.push(
      `Parts disagree on the length of ${disagreements.length} measure(s), first at measure ${disagreements[0]}; timing follows the first part.`,
    );
  }

  // Repeats → playback order (barline flags merged across parts).
  const bars: BarFlags[] = [];
  for (let w = 0; w < measureCount; w++) {
    const flags: BarFlags = { label: written[0][w]?.label ?? String(w + 1), forward: false, backward: false, times: null, ending: null };
    for (const part of written) {
      const b = part[w]?.bar;
      if (!b) continue;
      flags.forward ||= b.forward;
      flags.backward ||= b.backward;
      flags.times ??= b.times;
      flags.ending ??= b.ending;
    }
    bars.push(flags);
  }
  const playback = expandRepeats(bars);
  warnings.push(...playback.warnings);
  const order = playback.order;

  const startQ: number[] = [0];
  for (let k = 0; k < order.length; k++) startQ.push(startQ[k] + masterQ[order[k]]);

  // Tempo map (events from every part, first part wins at the same position).
  const tempoByPos = new Map<string, TempoEvent>();
  for (const part of written) {
    for (let k = 0; k < order.length; k++) {
      const m = part[order[k]];
      if (!m) continue;
      for (const t of m.tempos) {
        const q = startQ[k] + t.offsetQ;
        const key = q.toFixed(6);
        if (!tempoByPos.has(key)) tempoByPos.set(key, { q, bpm: t.bpm });
      }
    }
  }
  const tempoEvents = [...tempoByPos.values()].sort((a, b) => a.q - b.q);
  const tempoMap = new TempoMap(tempoEvents, DEFAULT_TEMPO);
  const sec = (q: number) => round6(tempoMap.secondsAt(q));
  const firstTempo = tempoEvents.length > 0 ? tempoEvents[0].bpm : DEFAULT_TEMPO;

  const measures: MeasureInfo[] = order.map((w, k) => {
    const s0 = sec(startQ[k]);
    const info: MeasureInfo = { number: k + 1, startTime: s0, duration: round6(sec(startQ[k + 1]) - s0) };
    // printed bar number (MusicXML number attribute, may be "0", "12a", "X1") when it differs from the playback index
    const label = bars[w].label;
    if (label !== String(k + 1)) info.label = label;
    if (w !== k) info.writtenIndex = w;
    // rehearsal mark: the first part that prints one wins (usually the top staff)
    const rehearsal = written.find((part) => part[w]?.rehearsal !== undefined)?.[w]?.rehearsal;
    if (rehearsal !== undefined) info.rehearsal = rehearsal;
    return info;
  });

  // Pass 2: emit notes in playback order.
  const instruments: Instrument[] = partDefs.map((def, p) => {
    const notes = emitNotes(written[p], order, startQ, sec);
    if (notes.length === 0) warnings.push(`Part "${def.name}" has no notes.`);
    const section = classifyInstrument({
      name: def.name,
      abbreviation: def.abbreviation,
      instrumentSound: def.instrumentSound,
      midiProgram: def.midiProgram,
      midiChannel: def.midiChannel,
    });
    const inst: Instrument = {
      id: def.id,
      name: def.name,
      shortName: def.abbreviation || abbreviateInstrumentName(def.name),
      section,
      notes,
    };
    if (read[p].transpose !== 0) inst.transpose = read[p].transpose;
    return inst;
  });

  let timeSignature = firstTimeSignature(rawParts[0]);
  if (!timeSignature) {
    warnings.push("No time signature found; assumed 4/4.");
    timeSignature = "4/4";
  }
  const infoMap: InfoMap = {
    instruments,
    measures,
    duration: sec(startQ[order.length]),
    tempo: round6(firstTempo),
    timeSignature,
    warnings: dedupe(warnings),
    timing: {
      tempo: tempoMap.breakpoints().map((p) => ({ time: round6(p.sec), bpm: round6(p.bpm) })),
      fermatas: fermataSpans(written, order, startQ, sec),
    },
  };
  const meta: ScoreMeta = {
    ...readMeta(root, filename),
    parts: instruments.length,
    measures: measures.length,
    durationSec: infoMap.duration,
    tempo: infoMap.tempo,
    timeSignature,
    warnings: infoMap.warnings,
  };
  return { ok: true, infoMap, meta };
}

/* ------------------------------------------------------------------ */
/* Part list and metadata                                              */
/* ------------------------------------------------------------------ */

function readPartList(root: XEl): PartDef[] {
  const list = child(root, "part-list");
  return childrenOf(list, "score-part").map((sp) => {
    const id = sp.attrs.id ?? "";
    const instrument = child(sp, "score-instrument");
    const midi = child(sp, "midi-instrument");
    const name = clean(childText(sp, "part-name")) || id;
    return {
      id,
      name,
      abbreviation: clean(childText(sp, "part-abbreviation")),
      instrumentName: clean(childText(instrument, "instrument-name")),
      instrumentSound: clean(childText(instrument, "instrument-sound")),
      midiProgram: num(childText(midi, "midi-program")),
      midiChannel: num(childText(midi, "midi-channel")),
    };
  });
}

function readMeta(root: XEl, filename: string): Pick<ScoreMeta, "title" | "composer" | "movement"> {
  const workTitle = clean(childText(child(root, "work"), "work-title"));
  const movementTitle = clean(childText(root, "movement-title"));
  const credits = childrenOf(root, "credit");
  const creditOf = (type: string) =>
    clean(credits.find((c) => childrenOf(c, "credit-type").some((t) => t.text === type))?.children.find((c) => c.tag === "credit-words")?.text ?? "");
  const creator = childrenOf(child(root, "identification"), "creator").find((c) => c.attrs.type === "composer");
  const title = workTitle || movementTitle || creditOf("title") || filename.replace(/\.(musicxml|xml|mxl)$/i, "");
  const movement = workTitle && movementTitle && movementTitle !== workTitle ? movementTitle : "";
  return { title, composer: clean(creator?.text ?? "") || creditOf("composer"), movement };
}

function firstTimeSignature(part: RawPart): string | null {
  for (const m of part.measures) {
    for (const a of childrenOf(m, "attributes")) {
      const time = child(a, "time");
      const beats = childText(time, "beats");
      const beatType = childText(time, "beat-type");
      if (beats && beatType) return `${beats}/${beatType}`;
    }
  }
  return null;
}

function timewiseToPartwise(root: XEl): RawPart[] {
  const byId = new Map<string, RawPart>();
  const measures = childrenOf(root, "measure");
  measures.forEach((m, idx) => {
    for (const p of childrenOf(m, "part")) {
      const id = p.attrs.id ?? "";
      let part = byId.get(id);
      if (!part) {
        part = { id, measures: [] };
        byId.set(id, part);
      }
      // keep measure indexes aligned when a part skips a measure
      while (part.measures.length < idx) part.measures.push({ tag: "measure", attrs: {}, children: [], text: "" });
      part.measures.push({ tag: "measure", attrs: m.attrs, children: p.children, text: "" });
    }
  });
  return [...byId.values()];
}

/* ------------------------------------------------------------------ */
/* Pass 1: written measures                                            */
/* ------------------------------------------------------------------ */

interface ReadPartResult {
  measures: WrittenMeasure[];
  /** semitones from written to sounding pitch (first <transpose> in the part) */
  transpose: number;
}

function readPart(part: RawPart, partName: string, warnings: string[]): ReadPartResult {
  let transpose: number | null = null;
  let warnedTranspose = false;
  let divisions: number | null = null;
  let warnedDivisions = false;
  let nominal: number | null = null;
  let endingOpen: number[] | null = null;
  const out: WrittenMeasure[] = [];

  const toQ = (durText: string): number => {
    const d = num(durText) ?? 0;
    if (divisions == null) {
      if (!warnedDivisions && d > 0) {
        warnings.push(`Part "${partName}": <divisions> missing; assumed 1 per quarter note.`);
        warnedDivisions = true;
      }
      return d;
    }
    return d / divisions;
  };

  for (const el of part.measures) {
    const m: WrittenMeasure = {
      label: el.attrs.number ?? String(out.length + 1),
      extentQ: 0,
      nominalQ: nominal,
      notes: [],
      dynamics: [],
      pizz: [],
      tempos: [],
      fermatas: [],
      bar: { label: el.attrs.number ?? String(out.length + 1), forward: false, backward: false, times: null, ending: endingOpen },
    };
    let cursor = 0;
    let lastOnset = 0;
    let endingClosedHere = false;

    for (const c of el.children) {
      switch (c.tag) {
        case "attributes": {
          const div = num(childText(c, "divisions"));
          if (div != null && div > 0) divisions = div;
          const tr = child(c, "transpose");
          if (tr) {
            const semis = (num(childText(tr, "chromatic")) ?? 0) + 12 * (num(childText(tr, "octave-change")) ?? 0);
            if (transpose == null) transpose = semis;
            else if (semis !== transpose && !warnedTranspose) {
              warnings.push(`Part "${partName}" changes transposition in measure ${m.label}; written pitch is kept and alignment uses the first transposition.`);
              warnedTranspose = true;
            }
          }
          const time = child(c, "time");
          if (time) {
            const beats = childText(time, "beats")
              .split("+")
              .reduce((s, b) => s + (Number(b) || 0), 0);
            const beatType = Number(childText(time, "beat-type"));
            if (beats > 0 && beatType > 0) {
              nominal = (beats * 4) / beatType;
              if (cursor === 0) m.nominalQ = nominal;
            }
          }
          break;
        }
        case "note": {
          const grace = child(c, "grace") !== undefined;
          const chord = child(c, "chord") !== undefined;
          const durQ = grace ? 0 : toQ(childText(c, "duration"));
          const onset = chord ? lastOnset : cursor;
          if (!chord) {
            lastOnset = cursor;
            if (!grace) cursor += durQ;
          }
          m.extentQ = Math.max(m.extentQ, cursor, onset + durQ);
          if (durQ > 0 && childrenOf(c, "notations").some((n) => child(n, "fermata"))) m.fermatas.push({ onsetQ: onset, durQ });
          if (child(c, "rest") || child(c, "cue")) break;
          const pitch = readPitch(c);
          if (pitch == null) break;
          const notations = childrenOf(c, "notations");
          const ties = tieFlags(c, notations);
          // note-attached dynamics behave like a direction at the note's onset
          for (const n of notations) for (const d of childrenOf(n, "dynamics")) pushDynamic(m, onset, d);
          m.notes.push({
            onsetQ: onset,
            durQ,
            pitch,
            tieStart: ties.start,
            tieStop: ties.stop,
            style: styleOf(notations),
            pizz: c.attrs.pizzicato === "yes",
            staff: childText(c, "staff") || "1",
          });
          break;
        }
        case "backup":
          cursor = Math.max(0, cursor - toQ(childText(c, "duration")));
          break;
        case "forward":
          cursor += toQ(childText(c, "duration"));
          m.extentQ = Math.max(m.extentQ, cursor);
          break;
        case "direction":
          readDirection(c, cursor, m, partName, warnings);
          break;
        case "sound":
          readSound(c, cursor, m, partName, warnings);
          break;
        case "barline": {
          const repeat = child(c, "repeat");
          if (repeat?.attrs.direction === "forward") m.bar.forward = true;
          if (repeat?.attrs.direction === "backward") {
            m.bar.backward = true;
            const times = num(repeat.attrs.times);
            if (times != null && times > 0) m.bar.times = times;
          }
          const ending = child(c, "ending");
          if (ending) {
            const type = ending.attrs.type;
            if (type === "start") {
              const numbers = parseEndingNumbers(ending.attrs.number);
              endingOpen = numbers.length > 0 ? numbers : null;
              m.bar.ending = endingOpen;
            } else if (type === "stop" || type === "discontinue") {
              if (!m.bar.ending) m.bar.ending = parseEndingNumbers(ending.attrs.number);
              endingClosedHere = true;
            }
          }
          break;
        }
        default:
          break;
      }
    }
    if (endingClosedHere) endingOpen = null;
    if (m.bar.ending && m.bar.ending.length === 0) m.bar.ending = null;
    out.push(m);
  }
  return { measures: out, transpose: transpose ?? 0 };
}

const STEP_SEMITONES: Record<string, number> = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 };

/** Written pitch → MIDI. Unpitched percussion → 60. Transposition is ignored on purpose (written pitch). */
function readPitch(note: XEl): number | null {
  if (child(note, "unpitched")) return 60;
  const pitch = child(note, "pitch");
  if (!pitch) return null;
  const step = STEP_SEMITONES[childText(pitch, "step").toUpperCase()];
  const octave = num(childText(pitch, "octave"));
  if (step === undefined || octave == null) return null;
  const alter = num(childText(pitch, "alter")) ?? 0;
  const midi = (octave + 1) * 12 + step + Math.round(alter);
  return Math.max(0, Math.min(127, midi));
}

function tieFlags(note: XEl, notations: XEl[]): { start: boolean; stop: boolean } {
  const ties = childrenOf(note, "tie");
  if (ties.length > 0) {
    return { start: ties.some((t) => t.attrs.type === "start"), stop: ties.some((t) => t.attrs.type === "stop") };
  }
  const tied = notations.flatMap((n) => childrenOf(n, "tied"));
  return {
    start: tied.some((t) => t.attrs.type === "start" || t.attrs.type === "continue"),
    stop: tied.some((t) => t.attrs.type === "stop" || t.attrs.type === "continue"),
  };
}

function styleOf(notations: XEl[]): StyleMarking | null {
  const found = new Set<StyleMarking>();
  for (const n of notations) {
    for (const a of childrenOf(n, "articulations")) {
      for (const art of a.children) {
        if (art.tag === "strong-accent") found.add("Marcato");
        else if (art.tag === "accent") found.add("Accent");
        else if (art.tag === "staccato" || art.tag === "staccatissimo" || art.tag === "spiccato") found.add("Staccato");
        else if (art.tag === "tenuto" || art.tag === "detached-legato") found.add("Tenuto");
      }
    }
    for (const t of childrenOf(n, "technical")) {
      if (child(t, "pizzicato") || child(t, "snap-pizzicato")) found.add("Pizzicato");
    }
    for (const o of childrenOf(n, "ornaments")) {
      if (child(o, "tremolo")) found.add("Tremolo");
    }
    if (childrenOf(n, "slur").some((s) => s.attrs.type === "start")) found.add("Slur");
  }
  for (const s of STYLE_PRIORITY) if (found.has(s)) return s;
  return null;
}

/** MusicXML dynamics element → persistent and/or momentary dynamic. */
function pushDynamic(m: WrittenMeasure, offsetQ: number, dynamics: XEl) {
  for (const d of dynamics.children) {
    const ev = mapDynamic(d.tag === "other-dynamics" ? d.text : d.tag);
    if (ev) m.dynamics.push({ offsetQ, ...ev });
  }
}

export function mapDynamic(raw: string): { set: Dynamic | null; accent: Dynamic | null } | null {
  const mark = raw.toLowerCase().replace(/[^a-z]/g, "");
  if (!mark) return null;
  if (/^p+$/.test(mark)) return { set: mark.length === 1 ? "p" : "pp", accent: null };
  if (/^f+$/.test(mark)) return { set: mark.length === 1 ? "f" : mark.length === 2 ? "ff" : "fff", accent: null };
  switch (mark) {
    case "mp":
    case "mf":
      return { set: mark, accent: null };
    case "n":
      return { set: "pp", accent: null };
    case "pf":
      return { set: "f", accent: null };
    case "sf":
    case "sfz":
    case "fz":
    case "rf":
    case "rfz":
      return { set: null, accent: "f" };
    case "sffz":
      return { set: null, accent: "ff" };
    case "fp":
    case "sfp":
    case "sfzp":
      return { set: "p", accent: "f" };
    case "sfpp":
      return { set: "pp", accent: "f" };
    default:
      return null;
  }
}

const JUMP_WORDS = /\bD\.\s?C\.|\bD\.\s?S\.|da capo|dal segno|to coda/i;

function readDirection(dir: XEl, cursor: number, m: WrittenMeasure, partName: string, warnings: string[]) {
  let tempo: number | null = null;
  let jumpWarned = false;
  for (const dt of childrenOf(dir, "direction-type")) {
    for (const d of childrenOf(dt, "dynamics")) pushDynamic(m, cursor, d);
    for (const r of childrenOf(dt, "rehearsal")) {
      const mark = r.text.trim();
      if (mark && m.rehearsal === undefined) m.rehearsal = mark.slice(0, 40);
    }
    const metronome = child(dt, "metronome");
    if (metronome && tempo == null) {
      const units = childrenOf(metronome, "beat-unit");
      const perMinute = childText(metronome, "per-minute");
      if (units.length === 1 && perMinute) {
        tempo = metronomeToQuarterBpm(units[0].text, childrenOf(metronome, "beat-unit-dot").length, perMinute);
      }
    }
    for (const w of childrenOf(dt, "words")) {
      if (/\bpizz/i.test(w.text)) m.pizz.push({ offsetQ: cursor, on: true });
      else if (/\barco\b/i.test(w.text)) m.pizz.push({ offsetQ: cursor, on: false });
      if (JUMP_WORDS.test(w.text)) {
        warnings.push(`Measure ${m.label}: "${w.text}" ignored; D.C./D.S./Coda jumps are not expanded.`);
        jumpWarned = true;
      }
    }
  }
  const sound = child(dir, "sound");
  const soundTempo = sound ? num(sound.attrs.tempo) : null;
  if (soundTempo != null && soundTempo > 0) tempo = soundTempo;
  if (tempo != null && tempo > 0) m.tempos.push({ offsetQ: cursor, bpm: tempo });
  if (sound) readSound(sound, cursor, m, partName, jumpWarned ? [] : warnings, true);
}

function readSound(sound: XEl, cursor: number, m: WrittenMeasure, _partName: string, warnings: string[], tempoHandled = false) {
  if (!tempoHandled) {
    const t = num(sound.attrs.tempo);
    if (t != null && t > 0) m.tempos.push({ offsetQ: cursor, bpm: t });
  }
  if (sound.attrs.pizzicato === "yes") m.pizz.push({ offsetQ: cursor, on: true });
  if (sound.attrs.pizzicato === "no") m.pizz.push({ offsetQ: cursor, on: false });
  if (sound.attrs.dacapo === "yes" || sound.attrs.dalsegno || sound.attrs.tocoda) {
    warnings.push(`Measure ${m.label}: a D.C./D.S./Coda jump was ignored; jumps are not expanded.`);
  }
}

function nominalAt(part: WrittenMeasure[], w: number): number | null {
  for (let i = Math.min(w, part.length - 1); i >= 0; i--) if (part[i]?.nominalQ != null) return part[i].nominalQ;
  return null;
}

/* ------------------------------------------------------------------ */
/* Pass 2: notes in playback order                                     */
/* ------------------------------------------------------------------ */

interface Pending {
  startQ: number;
  endQ: number;
  pitch: number;
  dynamics: Dynamic;
  style: StyleMarking | null;
  measure: number;
  order: number;
}

function emitNotes(part: WrittenMeasure[], order: number[], startQ: number[], sec: (q: number) => number): Note[] {
  const pending: Pending[] = [];
  const openTies = new Map<string, Pending>();
  let dyn: Dynamic = DEFAULT_DYNAMIC;
  let pizz = false;
  let seq = 0;

  for (let k = 0; k < order.length; k++) {
    const m = part[order[k]];
    if (!m) continue;
    const base = startQ[k];
    const notes = m.notes.map((n, i) => ({ n, i })).sort((a, b) => a.n.onsetQ - b.n.onsetQ || a.i - b.i);
    const dyns = m.dynamics.map((d, i) => ({ d, i })).sort((a, b) => a.d.offsetQ - b.d.offsetQ || a.i - b.i);
    const pizzEvents = m.pizz.map((p, i) => ({ p, i })).sort((a, b) => a.p.offsetQ - b.p.offsetQ || a.i - b.i);
    let di = 0;
    let pi = 0;
    let accent: { offsetQ: number; dyn: Dynamic } | null = null;

    for (const { n } of notes) {
      while (di < dyns.length && dyns[di].d.offsetQ <= n.onsetQ + EPS) {
        const ev = dyns[di].d;
        if (ev.set) dyn = ev.set;
        if (ev.accent) accent = { offsetQ: ev.offsetQ, dyn: ev.accent };
        di++;
      }
      while (pi < pizzEvents.length && pizzEvents[pi].p.offsetQ <= n.onsetQ + EPS) {
        pizz = pizzEvents[pi].p.on;
        pi++;
      }
      const noteDyn = accent && Math.abs(accent.offsetQ - n.onsetQ) <= EPS ? louder(dyn, accent.dyn) : dyn;
      const s = base + n.onsetQ;
      const e = s + n.durQ;
      const key = `${n.staff}:${n.pitch}`;

      if (n.tieStop) {
        const open = openTies.get(key);
        if (open && Math.abs(open.endQ - s) <= 1e-4) {
          open.endQ = Math.max(open.endQ, e);
          if (!n.tieStart) openTies.delete(key);
          continue;
        }
      }
      const style = n.style ?? (n.pizz || pizz ? "Pizzicato" : null);
      const rec: Pending = { startQ: s, endQ: e, pitch: n.pitch, dynamics: noteDyn, style, measure: k + 1, order: seq++ };
      pending.push(rec);
      if (n.tieStart && n.durQ > 0) openTies.set(key, rec);
      else openTies.delete(key);
    }
    // dynamics after the last note of the measure still carry forward
    for (; di < dyns.length; di++) {
      const set = dyns[di].d.set;
      if (set) dyn = set;
    }
    while (pi < pizzEvents.length) {
      pizz = pizzEvents[pi].p.on;
      pi++;
    }
  }

  pending.sort((a, b) => a.startQ - b.startQ || a.pitch - b.pitch || a.order - b.order);
  return pending.map((p) => {
    const t0 = sec(p.startQ);
    return {
      time: t0,
      duration: round6(sec(p.endQ) - t0),
      pitch: p.pitch,
      dynamics: p.dynamics,
      styleMarking: p.style,
      measure: p.measure,
    };
  });
}

/** Fermata spans in score seconds, playback order, merged across parts. */
function fermataSpans(part: WrittenMeasure[][], order: number[], startQ: number[], sec: (q: number) => number): Array<{ start: number; end: number }> {
  const seen = new Map<string, { start: number; end: number }>();
  for (const written of part) {
    for (let k = 0; k < order.length; k++) {
      for (const f of written[order[k]]?.fermatas ?? []) {
        const start = sec(startQ[k] + f.onsetQ);
        const end = sec(startQ[k] + f.onsetQ + f.durQ);
        const key = `${start}:${end}`;
        if (!seen.has(key)) seen.set(key, { start, end });
      }
    }
  }
  return [...seen.values()].sort((a, b) => a.start - b.start || a.end - b.end);
}

/* ------------------------------------------------------------------ */
/* utils                                                               */
/* ------------------------------------------------------------------ */

function round6(x: number): number {
  const r = Math.round(x * 1e6) / 1e6;
  return r === 0 ? 0 : r;
}

function clean(s: string): string {
  return s.replace(/\s+/g, " ").trim();
}

function dedupe(list: string[]): string[] {
  return [...new Set(list)];
}
