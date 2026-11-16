import { describe, expect, it } from "vitest";
import { strToU8 } from "fflate";
import { MAX_PARTS } from "@/shared/info-map";
import { parseMusicXml, soundingTranspose } from "@/shared/score";
import { mapDynamic } from "@/shared/score/parse";
import { fixtureBytes, parseFixture, parseOk, part, timings } from "./helpers";

const Q = "quirks/";

describe("parseMusicXml: timing quirks", () => {
  it("divisions change between measures and mid-measure", () => {
    const { infoMap, meta } = parseOk(Q + "divisions-change.musicxml");
    expect(timings(part(infoMap, "P1"))).toEqual([
      [72, 0, 0.5],
      [74, 0.5, 0.5],
      [76, 1, 0.25],
      [77, 1.25, 0.25],
      [79, 1.5, 0.5],
      [81, 2, 0.5],
      [83, 2.5, 0.5],
    ]);
    expect(infoMap.measures).toEqual([
      { number: 1, startTime: 0, duration: 1 },
      { number: 2, startTime: 1, duration: 1 },
      { number: 3, startTime: 2, duration: 1 },
    ]);
    expect(infoMap.duration).toBe(3);
    expect(infoMap.tempo).toBe(120); // no marking → default
    expect(infoMap.timeSignature).toBe("2/4");
    expect(meta.title).toBe("Divisions Change");
    expect(infoMap.warnings).toEqual([]);
  });

  it("counts voices in parallel via backup/forward", () => {
    const { infoMap } = parseOk(Q + "multi-voice-backup.musicxml");
    expect(timings(part(infoMap, "P1"))).toEqual([
      [62, 0, 1],
      [67, 0, 2],
      [64, 1, 1],
      [66, 2, 2], // F#4 (alter 1)
      [69, 2, 2],
      [71, 4, 4],
      [60, 6, 2], // after <forward> skips two beats in voice 2
    ]);
    expect(infoMap.measures.map((m) => m.duration)).toEqual([4, 4]);
    expect(infoMap.tempo).toBe(60);
  });

  it("chord notes share the onset; metronome half = 60 means 120 quarters/min", () => {
    const { infoMap } = parseOk(Q + "chords.musicxml");
    expect(timings(part(infoMap, "P1"))).toEqual([
      [60, 0, 0.5],
      [64, 0, 0.5],
      [67, 0, 0.5],
      [62, 0.5, 1],
      [65, 0.5, 1],
    ]);
    expect(infoMap.duration).toBe(1.5);
    expect(infoMap.tempo).toBe(120);
  });

  it("merges tied notes across barlines and with <tied> only", () => {
    const { infoMap } = parseOk(Q + "ties-across-barline.musicxml");
    const cello = part(infoMap, "P1");
    expect(timings(cello)).toEqual([
      [48, 0, 1],
      [55, 1, 5], // dotted half tied over the barline into a half
      [57, 6, 2], // two tied quarters
      [59, 8, 6], // <notations><tied> without <tie>
    ]);
    expect(cello.notes.map((n) => n.measure)).toEqual([1, 1, 2, 3]);
  });

  it("follows a tempo map: metronome, sound tempo, dotted beat unit, half-note beat", () => {
    const { infoMap } = parseOk(Q + "tempo-change.musicxml");
    expect(infoMap.measures).toEqual([
      { number: 1, startTime: 0, duration: 4 },
      { number: 2, startTime: 4, duration: 2 },
      { number: 3, startTime: 6, duration: 3 },
      { number: 4, startTime: 9, duration: 2 },
    ]);
    expect(infoMap.duration).toBe(11);
    expect(infoMap.tempo).toBe(60);
    const m3 = part(infoMap, "P1").notes.filter((n) => n.measure === 3);
    expect(m3.map((n) => [n.time, n.duration])).toEqual([
      [6, 0.5],
      [6.5, 0.5],
      [7, 1], // dotted quarter = 40 → 60 quarters/min from here
      [8, 1],
    ]);
  });

  it("a pickup becomes a short measure 1; parts that disagree on length produce a warning", () => {
    const { infoMap } = parseOk(Q + "pickup-and-mismatch.musicxml");
    // printed numbers 0, 1, 2 differ from playback indices 1, 2, 3, so every measure keeps its label
    expect(infoMap.measures).toEqual([
      { number: 1, startTime: 0, duration: 1, label: "0" },
      { number: 2, startTime: 1, duration: 3, label: "1" },
      { number: 3, startTime: 4, duration: 3, label: "2" },
    ]);
    expect(infoMap.duration).toBe(7);
    expect(infoMap.warnings).toEqual(["Parts disagree on the length of 1 measure(s), first at measure 2 (Bassoon); timing follows the first part."]);
  });

  it("assumes 1 division per quarter and warns when <divisions> is missing", () => {
    const { infoMap } = parseOk(Q + "missing-divisions.musicxml");
    expect(timings(part(infoMap, "P1"))).toEqual([
      [65, 0, 0.5],
      [72, 0.5, 0.5],
    ]);
    expect(infoMap.warnings).toEqual(['Part "Horn": <divisions> missing; assumed 1 per quarter note.']);
  });

  it("grace notes keep their marking with duration 0; cue notes advance time but are not played", () => {
    const { infoMap } = parseOk(Q + "grace-and-cue.musicxml");
    const notes = part(infoMap, "P1").notes;
    expect(notes.map((n) => [n.pitch, n.time, n.duration, n.styleMarking])).toEqual([
      [72, 0, 0.5, null],
      [74, 0, 0, "Accent"], // grace D5
      [71, 0.5, 0.5, null],
      [77, 1.5, 0.5, null], // F5 after the unplayed cue E5
    ]);
  });
});

describe("parseMusicXml: rehearsal marks", () => {
  it("records the first printed mark per bar on every playback pass", () => {
    const { infoMap } = parseOk(Q + "rehearsal.musicxml");
    // written 1 |: 2 3 :| 4  →  1 2 3 2 3 4
    expect(infoMap.measures.map((m) => m.rehearsal)).toEqual([undefined, "A", "B", "A", "B", undefined]);
  });

  it("leaves bars without marks untouched", () => {
    const { infoMap } = parseOk(Q + "repeats.musicxml");
    expect(infoMap.measures.every((m) => m.rehearsal === undefined)).toBe(true);
  });
});

describe("parseMusicXml: repeats and jumps", () => {
  it("expands a repeat with 1st/2nd endings and ignores D.C. with a warning", () => {
    const { infoMap } = parseOk(Q + "repeats.musicxml");
    const notes = part(infoMap, "P1").notes;
    // written 1 |: 2 3 [1. 4 :| [2. 5 | 6 7  →  1 2 3 4 2 3 5 6 7
    expect(notes.map((n) => n.pitch)).toEqual([60, 62, 64, 65, 62, 64, 67, 69, 71]);
    expect(notes.map((n) => n.time)).toEqual([0, 2, 4, 6, 8, 10, 12, 14, 16]);
    expect(notes.map((n) => n.measure)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9]);
    expect(infoMap.measures).toHaveLength(9);
    expect(infoMap.duration).toBe(18);
    // printed bar numbers survive where they differ from the playback index
    expect(infoMap.measures.map((m) => [m.number, m.label])).toEqual([
      [1, undefined],
      [2, undefined],
      [3, undefined],
      [4, undefined],
      [5, "2"],
      [6, "3"],
      [7, "5"],
      [8, "6"],
      [9, "7"],
    ]);
    expect(Object.keys(infoMap.measures[0])).not.toContain("label");
    // the f from written measure 3 is still in force on the second pass of measure 2
    expect(notes.map((n) => n.dynamics)).toEqual(["mp", "mp", "f", "f", "f", "f", "f", "f", "f"]);
    expect(infoMap.warnings).toEqual([
      'Measure 6: "D.C. al Fine" ignored; D.C./D.S./Coda jumps are not expanded.',
      "Repeat expanded: measures 2–4 play twice (with 1st/2nd endings).",
    ]);
  });
});

describe("parseMusicXml: measure labels", () => {
  it("uses the MusicXML number attribute as the label, even when it is not numeric", () => {
    const measure = (n: string) =>
      `<measure number="${n}"><attributes><divisions>1</divisions></attributes><note><pitch><step>C</step><octave>4</octave></pitch><duration>4</duration></note></measure>`;
    const xml = `<?xml version="1.0"?><score-partwise version="4.0"><part-list><score-part id="P1"><part-name>Flute</part-name></score-part></part-list><part id="P1">${["1", "2", "X1", "3"].map(measure).join("")}</part></score-partwise>`;
    const out = parseMusicXml({ bytes: strToU8(xml), filename: "labels.musicxml" });
    expect(out.ok && out.infoMap.measures.map((m) => [m.number, m.label])).toEqual([
      [1, undefined],
      [2, undefined],
      [3, "X1"],
      [4, "3"],
    ]);
  });
});

describe("parseMusicXml: dynamics", () => {
  it("defaults to mp, persists per part, maps ppp/ffff, treats sfz/rf as accents and fp as f then p", () => {
    const { infoMap } = parseOk(Q + "dynamics.musicxml");
    expect(part(infoMap, "P1").notes.map((n) => n.dynamics)).toEqual([
      "mp", // before any marking
      "p",
      "p",
      "p",
      "f", // sfz: accent on this note only
      "p", // back to p
      "pp", // ppp → pp
      "fff", // ffff → fff
      "f", // fp: forte attack…
      "p", // …then piano
      "ff", // note-attached <notations><dynamics><ff/>
      "ff",
      "ff", // sfz inside ff never makes a note quieter
    ]);
    expect(part(infoMap, "P2").notes.map((n) => n.dynamics)).toEqual([
      "mp", // P1's markings don't leak into P2
      "mp",
      "mf",
      "f", // rf
      "mf",
      "mp", // other-dynamics text "mp"
    ]);
  });

  it("maps every MusicXML dynamic element onto the seven-step ladder", () => {
    expect(mapDynamic("pppppp")).toEqual({ set: "pp", accent: null });
    expect(mapDynamic("p")).toEqual({ set: "p", accent: null });
    expect(mapDynamic("mp")).toEqual({ set: "mp", accent: null });
    expect(mapDynamic("mf")).toEqual({ set: "mf", accent: null });
    expect(mapDynamic("ffffff")).toEqual({ set: "fff", accent: null });
    for (const accent of ["sf", "sfz", "fz", "rf", "rfz"]) expect(mapDynamic(accent)).toEqual({ set: null, accent: "f" });
    expect(mapDynamic("sffz")).toEqual({ set: null, accent: "ff" });
    expect(mapDynamic("sfp")).toEqual({ set: "p", accent: "f" });
    expect(mapDynamic("sfpp")).toEqual({ set: "pp", accent: "f" });
    expect(mapDynamic("n")).toEqual({ set: "pp", accent: null });
    expect(mapDynamic("dolce")).toBeNull();
  });
});

describe("parseMusicXml: style markings", () => {
  it("reads articulations, slurs, tremolo, pizzicato and pizz./arco directions", () => {
    const { infoMap } = parseOk(Q + "articulations.musicxml");
    expect(part(infoMap, "P1").notes.map((n) => n.styleMarking)).toEqual([
      "Staccato",
      "Tenuto",
      "Accent",
      "Marcato", // strong-accent
      "Slur", // slur start
      null, // slur stop
      "Tremolo",
      "Pizzicato", // technical/pizzicato
      "Accent", // accent beats staccato
      "Pizzicato", // "pizz." + <sound pizzicato="yes">
      "Pizzicato",
      null, // arco
    ]);
  });
});

describe("parseMusicXml: parts and sections", () => {
  it("derives names, abbreviations and sections from the part list", () => {
    const { infoMap, meta } = parseOk(Q + "part-list.musicxml");
    expect(infoMap.instruments.map((i) => [i.id, i.name, i.shortName, i.section])).toEqual([
      ["P1", "P1", "P1", "Strings"], // empty part-name → id; instrument-sound strings.viola
      ["P2", "Kit", "Kit", "Percussion"], // MIDI channel 10
      ["P3", "Line 3", "Line 3", "Woodwinds"], // GM program 74 (flute)
      ["P4", "Piano", "Pno.", "Other"], // GM program 1
      ["P5", "Bass Clarinet", "B. Cl.", "Woodwinds"], // keyword, not "bass" → Strings
      ["P6", "Timpani", "Timp. (D–A)", "Percussion"], // part-abbreviation wins
    ]);
    expect(part(infoMap, "P2").notes[0].pitch).toBe(60); // unpitched → 60
    expect(meta.composer).toBe("Test Composer");
    expect(meta.title).toBe("Part List");
    expect(infoMap.warnings).toEqual(['Part "Piano" has no notes.']);
  });

  it("keeps written pitch for transposing instruments and records the transposition", () => {
    const { infoMap } = parseOk(Q + "transposing-clarinet.musicxml");
    const cl = part(infoMap, "P1");
    expect(cl.name).toBe("Clarinet in B♭"); // numeric character reference decoded
    expect(cl.shortName).toBe("Cl. (B♭)");
    expect(cl.section).toBe("Woodwinds");
    expect(cl.notes.map((n) => n.pitch)).toEqual([74, 78]); // written D5, F#5 (sounding C5, E5)
    expect(soundingTranspose(cl)).toBe(-2);
  });

  it("converts score-timewise to the same info map as its partwise twin", () => {
    const timewise = parseOk(Q + "timewise.musicxml");
    const partwise = parseOk(Q + "timewise-as-partwise.musicxml");
    expect(timewise.infoMap).toEqual(partwise.infoMap);
    expect(timewise.meta).toEqual(partwise.meta);
    expect(timings(part(timewise.infoMap, "P2"))).toEqual([
      [48, 0, 2],
      [43, 2, 2],
    ]);
  });

  it(`rejects more than ${MAX_PARTS} parts with a clear message`, () => {
    const n = 65;
    const list = Array.from({ length: n }, (_, i) => `<score-part id="P${i + 1}"><part-name>Violin ${i + 1}</part-name></score-part>`).join("");
    const parts = Array.from(
      { length: n },
      (_, i) =>
        `<part id="P${i + 1}"><measure number="1"><attributes><divisions>1</divisions></attributes><note><pitch><step>C</step><octave>4</octave></pitch><duration>4</duration></note></measure></part>`,
    ).join("");
    const xml = `<?xml version="1.0"?><score-partwise version="4.0"><part-list>${list}</part-list>${parts}</score-partwise>`;
    const out = parseMusicXml({ bytes: strToU8(xml), filename: "big.musicxml" });
    expect(out).toEqual({
      ok: false,
      error: "65 parts exceed the 64-part limit. Combine or remove parts in your notation app and export the score again.",
    });
    // exactly 64 is fine
    const ok = parseMusicXml({
      bytes: strToU8(xml.replace(/<score-part id="P65">.*?<\/score-part>/, "").replace(/<part id="P65">.*?<\/part>/, "")),
      filename: "64.musicxml",
    });
    expect(ok.ok && ok.infoMap.instruments.length).toBe(64);
  });
});

describe("parseMusicXml: file formats and bad input", () => {
  it("reads compressed .mxl through META-INF/container.xml", () => {
    const plain = parseOk(Q + "divisions-change.musicxml");
    const zipped = parseOk(Q + "compressed.mxl");
    expect(zipped.infoMap).toEqual(plain.infoMap);
    expect(zipped.meta.title).toBe("Divisions Change");
  });

  it("falls back to the first score entry when an .mxl has no container.xml", () => {
    const plain = parseOk(Q + "divisions-change.musicxml");
    expect(parseOk(Q + "compressed-no-container.mxl").infoMap).toEqual(plain.infoMap);
  });

  it("decodes UTF-16 with a BOM", () => {
    const { infoMap } = parseOk(Q + "utf16-bom.musicxml");
    expect(infoMap.instruments.map((i) => i.name)).toEqual(["Violin", "Violoncelle — solo"]);
    expect(timings(infoMap.instruments[0])).toEqual(timings(parseOk(Q + "timewise-as-partwise.musicxml").infoMap.instruments[0]));
  });

  it("returns clear errors for empty, garbage, truncated, non-MusicXML and broken zip input", () => {
    expect(parseFixture(Q + "empty.musicxml")).toEqual({ ok: false, error: "empty.musicxml is empty." });
    expect(parseFixture(Q + "garbage.musicxml")).toEqual({ ok: false, error: "garbage.musicxml is not a MusicXML score. The file is not XML." });
    expect(parseFixture(Q + "not-musicxml.xml")).toEqual({
      ok: false,
      error: "not-musicxml.xml is not a MusicXML score (the document starts with <html>, expected <score-partwise>).",
    });
    const truncated = parseFixture(Q + "truncated.musicxml");
    expect(truncated.ok).toBe(false);
    expect(!truncated.ok && truncated.error).toMatch(/^truncated\.musicxml is not a MusicXML score\. The file ends early: <note> and 3 enclosing element\(s\) are never closed/);
    const fakeMxl = parseMusicXml({ bytes: fixtureBytes(Q + "divisions-change.musicxml"), filename: "score.mxl" });
    expect(fakeMxl).toEqual({ ok: false, error: "score.mxl is not a valid compressed MusicXML (.mxl) file: it is not a zip archive." });
    const brokenZip = new Uint8Array([0x50, 0x4b, 0x03, 0x04, 1, 2, 3, 4, 5, 6, 7, 8]);
    expect(parseMusicXml({ bytes: brokenZip, filename: "broken.mxl" }).ok).toBe(false);
  });

  it("is deterministic: same bytes, identical output", () => {
    const a = parseFixture(Q + "dynamics.musicxml");
    const b = parseFixture(Q + "dynamics.musicxml");
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });
});

describe("parseMusicXml: timing for the aligner", () => {
  it("emits the tempo map in score seconds", () => {
    const { infoMap } = parseOk(Q + "tempo-change.musicxml");
    expect(infoMap.timing?.tempo).toEqual([
      { time: 0, bpm: 60 },
      { time: 4, bpm: 120 },
      { time: 7, bpm: 60 },
      { time: 9, bpm: 120 },
    ]);
    expect(infoMap.timing?.fermatas).toEqual([]);
  });

  it("collects fermatas on notes and rests across parts, once per span", () => {
    const fermataBar = (rest: boolean) => `
      <measure number="1">
        <attributes><divisions>1</divisions><time><beats>2</beats><beat-type>4</beat-type></time></attributes>
        <note><pitch><step>C</step><octave>4</octave></pitch><duration>1</duration></note>
        <note>${rest ? "<rest/>" : "<pitch><step>D</step><octave>4</octave></pitch>"}<duration>1</duration><notations><fermata/></notations></note>
      </measure>`;
    const xml = `<?xml version="1.0"?><score-partwise version="4.0">
      <part-list><score-part id="P1"><part-name>Flute</part-name></score-part><score-part id="P2"><part-name>Oboe</part-name></score-part></part-list>
      <part id="P1">${fermataBar(false)}</part><part id="P2">${fermataBar(true)}</part></score-partwise>`;
    const out = parseMusicXml({ bytes: strToU8(xml), filename: "fermata.musicxml" });
    if (!out.ok) throw new Error(out.error);
    expect(out.infoMap.timing?.fermatas).toEqual([{ start: 0.5, end: 1 }]);
  });
});
