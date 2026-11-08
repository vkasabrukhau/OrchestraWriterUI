"""Local audio-to-score service for the Orchestra Visualizer.

Runs MuScriptor (Kyutai x Mirelo, multi-instrument transcription) and turns
its output into what the Node server needs:

  POST /score   whole recording -> background job; GET /score/{id} polls it
                and finally returns one multi-part MusicXML score (the
                visualizer imports it like an uploaded score), where each
                measure starts in the recording, and the transcription itself
                (notes + beat grid) so the bars can be redone without the model
  POST /rebar   a transcription from /score + bar corrections (time signature,
                bar lines moved by whole beats, half/double tempo) -> the same
                result as /score, in seconds; needs no model
  POST /notes   one time window of a recording -> notes per instrument, in
                seconds (the model slot of src/server/pipeline/model.ts)
  GET  /health  model status

Request bodies are the raw audio bytes (mp3, wav, flac, ...), except /rebar
(JSON). The model is loaded once and calls are serialized: one transcription
at a time.

    cd ml && uv run uvicorn server:app --port 8333

Environment: MUSCRIPTOR_MODEL (small | medium | large, default medium),
MUSCRIPTOR_DEVICE (default: MPS/CUDA when present, else CPU).
"""

from __future__ import annotations

import io
import os
import sys
import tempfile
import threading
import time
import traceback
import uuid
from pathlib import Path

from fastapi import Body, FastAPI, HTTPException, Query, Request

MODEL_NAME = os.environ.get("MUSCRIPTOR_MODEL", "medium")
DEVICE = os.environ.get("MUSCRIPTOR_DEVICE") or None
MAX_BYTES = 500 * 1024 * 1024  # matches the recording upload cap

# Which instruments the model may write (MuScriptor's group names). Left free,
# it often hears a string orchestra as guitar + electric bass; limiting it to
# orchestral instruments is a hard constraint on decoding. "string_ensemble"
# is left out on purpose so strings split into violin / viola / cello / bass.
ENSEMBLES: dict[str, list[str] | None] = {
    "orchestra": [
        "violin", "viola", "cello", "contrabass", "orchestral_harp",
        "flutes", "oboe", "english_horn", "clarinet", "bassoon",
        "french_horn", "trumpet", "trombone", "tuba", "timpani",
        "chromatic_percussion", "acoustic_piano", "organ",
    ],
    "strings": ["violin", "viola", "cello", "contrabass", "acoustic_piano", "organ"],
    "any": None,
}

app = FastAPI(title="Orchestra transcriber")
_lock = threading.Lock()
_model = None
_load_error: str | None = None


def _get_model():
    """Load MuScriptor on first use (the weights download the first time)."""
    global _model, _load_error
    if _model is None:
        from muscriptor.transcription_model import TranscriptionModel

        try:
            t = time.perf_counter()
            _model = TranscriptionModel.load_model(weights_path=MODEL_NAME, device=DEVICE)
            print(f"[transcriber] loaded muscriptor-{MODEL_NAME} in {time.perf_counter() - t:.1f}s",
                  file=sys.stderr)
            _load_error = None
        except Exception as e:  # missing HF login / licence not accepted, mostly
            _load_error = str(e)
            raise HTTPException(503, f"Could not load MuScriptor ({MODEL_NAME}): {e}") from e
    return _model


async def _audio_file(request: Request, filename: str) -> Path:
    body = await request.body()
    if not body:
        raise HTTPException(400, "Send the audio file as the request body")
    if len(body) > MAX_BYTES:
        raise HTTPException(413, "Recording is larger than 500 MB")
    suffix = Path(filename).suffix.lower() or ".mp3"
    fd, path = tempfile.mkstemp(suffix=suffix, prefix="ov-transcribe-")
    with os.fdopen(fd, "wb") as f:
        f.write(body)
    return Path(path)


@app.get("/health")
def health():
    return {"ok": True, "model": MODEL_NAME, "loaded": _model is not None, "error": _load_error}


@app.post("/notes")
async def notes(
    request: Request,
    start: float = Query(0.0, ge=0),
    end: float | None = Query(None, gt=0),
    filename: str = "audio.mp3",
):
    """Notes in [start, end) of the recording; times relative to `start`."""
    from muscriptor.events import NoteEndEvent
    from muscriptor.utils.audio import load_audio

    path = await _audio_file(request, filename)
    try:
        with _lock:
            model = _get_model()
            sr = 16000
            wav = load_audio(path, target_sr=sr)
            a = int(start * sr)
            b = wav.shape[-1] if end is None else min(wav.shape[-1], int(end * sr))
            if b <= a:
                return {"notes": []}
            out = []
            for ev in model.transcribe((wav[..., a:b], sr)):
                if isinstance(ev, NoteEndEvent):
                    s = ev.start_event
                    out.append({
                        "part": s.instrument,
                        "pitch": s.pitch,
                        "start": round(s.start_time, 4),
                        "end": round(max(ev.end_time, s.start_time + 0.05), 4),
                    })
        return {"notes": out}
    finally:
        path.unlink(missing_ok=True)


# Whole-recording transcriptions run as background jobs (minutes, not seconds):
# POST /score answers with a job id at once; GET /score/{id} reports progress
# and, when done, the MusicXML.
_jobs: dict[str, dict] = {}


@app.post("/score", status_code=202)
async def score(request: Request, filename: str = "audio.mp3", title: str = "", ensemble: str = "orchestra"):
    """Start transcribing the whole recording into one multi-part MusicXML score."""
    if ensemble not in ENSEMBLES:
        raise HTTPException(400, f"ensemble must be one of: {', '.join(ENSEMBLES)}")
    path = await _audio_file(request, filename)
    job_id = uuid.uuid4().hex
    _jobs[job_id] = {"status": "running", "progress": 0.0, "message": "Waiting for the model", "result": None, "error": None}
    threading.Thread(target=_run_score, args=(job_id, path, title or Path(filename).stem, ENSEMBLES[ensemble]), daemon=True).start()
    return {"id": job_id}


@app.get("/score/{job_id}")
def score_status(job_id: str):
    job = _jobs.get(job_id)
    if job is None:
        raise HTTPException(404, "No such transcription job")
    return job


def _run_score(job_id: str, path: Path, title: str, instruments: list[str] | None) -> None:
    from muscriptor.events import NoteStartEvent, ProgressEvent

    job = _jobs[job_id]
    t = time.perf_counter()
    try:
        with _lock:
            job["message"] = "Loading the model"
            model = _get_model()
            job.update(progress=0.03, message="Finding the beat")
            grid = model.detect_beat_grid_for(path, "best-effort")
            events = []
            for ev in model.transcribe(path, instruments=instruments):
                if isinstance(ev, ProgressEvent):
                    if ev.total:
                        job.update(progress=0.05 + 0.85 * ev.completed / ev.total,
                                   message=f"Transcribing ({ev.completed}/{ev.total} chunks)")
                    continue
                events.append(ev)
            onsets = [e.start_time for e in events if isinstance(e, NoteStartEvent)]
            if grid is not None:
                grid = grid.with_onset_delay(onsets)
            transcription = _transcription(model, events, grid, title)
        job.update(progress=0.92, message="Writing MusicXML")
        result = _render(transcription, {})
        job.update(status="succeeded", progress=1.0, message="Done", result={
            **result,
            "transcription": transcription,
            "seconds": round(time.perf_counter() - t, 1),
            "model": f"muscriptor-{MODEL_NAME}",
        })
    except HTTPException as e:
        job.update(status="failed", message="Failed", error=str(e.detail))
    except Exception as e:  # noqa: BLE001 - reported to the caller
        traceback.print_exc()
        job.update(status="failed", message="Failed", error=f"{type(e).__name__}: {e}")
    finally:
        path.unlink(missing_ok=True)


@app.post("/rebar")
def rebar(body: dict = Body(...)):
    """Rewrite a transcription's score with corrected bars (no model needed)."""
    transcription = body.get("transcription")
    if not isinstance(transcription, dict) or transcription.get("version") != TRANSCRIPTION_VERSION \
            or not isinstance(transcription.get("notes"), list):
        raise HTTPException(400, "transcription must be the object a /score result returned")
    bars = body.get("bars") or {}
    if not isinstance(bars, dict):
        raise HTTPException(400, "bars must be an object")
    meter = bars.get("beatsPerBar")
    if meter is not None and (not isinstance(meter, int) or not 1 <= meter <= 12):
        raise HTTPException(400, "bars.beatsPerBar must be a whole number from 1 to 12, or null")
    shift = bars.get("shiftBeats", 0)
    if not isinstance(shift, int) or abs(shift) > 64:
        raise HTTPException(400, "bars.shiftBeats must be a whole number of beats")
    if bars.get("beatScale", 1) not in (0.5, 1, 2):
        raise HTTPException(400, "bars.beatScale must be 0.5, 1 or 2")
    return _render(transcription, bars)


# Version of the transcription object /score returns and /rebar accepts.
TRANSCRIPTION_VERSION = 1

WARN_NO_BEAT = ("No steady beat was found in the recording, so the score is written at a "
                "placeholder 120 BPM and its rhythms are approximate.")
WARN_LOOSE_RHYTHM = ("The notes don't follow a steady beat, so note lengths in the score are "
                     "approximate.")
WARN_METER = ("The time signature wasn't detected, so 4/4 was assumed and the bar lines may sit "
              "a beat or more off. Check them in Sync, then correct them under Bars.")


def _transcription(model, events, grid, title: str) -> dict:
    """The model's notes (cleaned up as MuScriptor does before writing MIDI) and
    the detected beat grid, as JSON: everything needed to write the score again."""
    from muscriptor.events import NoteEndEvent, NoteStartEvent
    from muscriptor.tokenizer.notes import DRUM_PROGRAM, Note, trim_overlapping_notes, validate_notes

    notes, pending, names = [], {}, {}
    for ev in events:
        if isinstance(ev, NoteStartEvent):
            drums = ev.instrument == "drums"
            program = DRUM_PROGRAM if drums else model._program_for_instrument(ev.instrument)
            names[program] = ev.instrument.replace("_", " ")
            pending[ev.index] = Note(is_drum=drums, program=program, onset=ev.start_time,
                                     offset=ev.start_time, pitch=ev.pitch)
        elif isinstance(ev, NoteEndEvent):
            note = pending.pop(ev.start_event_index)
            note.offset = ev.end_time
            notes.append(note)
    notes = trim_overlapping_notes(validate_notes(notes, fix=True), sort=True)
    return {
        "version": TRANSCRIPTION_VERSION,
        "title": title,
        "names": {str(k): v for k, v in names.items()},
        # [program, is_drum, pitch, onset s, offset s]
        "notes": [[n.program, int(n.is_drum), n.pitch, round(n.onset, 4), round(n.offset, 4)] for n in notes],
        "grid": None if grid is None else {
            "bpm": grid.bpm,
            "beatsPerBar": grid.beats_per_bar,
            "firstDownbeat": grid.first_downbeat,
            "beats": None if grid.beats is None else [round(float(b), 4) for b in grid.beats],
            "onsetDelay": grid.onset_delay,
            "beatSubdivision": grid.beat_subdivision,
            "steady": grid.steady,
        },
    }


def _export_options(grid, bars: dict):
    """MuScriptor export options for these bar corrections. They move bar lines, never notes.

    - beatsPerBar: the time signature in beats (None: as detected; 4 when
      nothing was detected, anchored on the tracked first downbeat rather than
      on the first note).
    - shiftBeats: bar lines moved later by this many beats. Bar lines repeat
      every bar, so it is taken modulo the meter (one beat earlier = meter - 1
      beats later), which keeps the downbeat inside the tracked beats.
    - beatScale: 2 when the tracker counted half notes as beats, 0.5 when it
      counted eighths.

    Returns (options, shift actually applied).
    """
    import numpy as np
    from muscriptor.utils.midi import ExportOptions, scaled_meter

    scale = float(bars.get("beatScale") or 1)
    meter = bars.get("beatsPerBar")
    detected = grid.beats_per_bar if grid is not None else None
    if meter is None and detected is None:
        meter = 4
    # the meter the score is written in: the one asked for, or the detected one
    # read at the new beat (as resolve_grid does)
    written_meter = meter if meter is not None else (scaled_meter(detected, scale) or 4)
    shift = int(bars.get("shiftBeats") or 0) % written_meter
    first = None
    if shift and grid is not None and grid.beats is not None and len(grid.beats) >= 2:
        # Count tracked beats from the detected downbeat (a tempo average drifts
        # off them when the performance speeds up or slows down); a written beat
        # is 1/scale of a tracked one.
        beats = np.asarray(grid.beats, dtype=float)
        start = int(np.abs(beats - grid.first_downbeat).argmin())
        first = float(np.interp(start + shift / scale, np.arange(len(beats)), beats))
    elif shift:
        bpm = grid.bpm if grid is not None else 120.0
        base = grid.first_downbeat if grid is not None else 0.0
        first = base + shift * 60.0 / (bpm * scale)
    options = ExportOptions(quantize=True, fill_gaps=0.25, beats_per_bar=meter,
                            first_downbeat=first, beat_scale=scale)
    return options, shift


def _render(transcription: dict, bars: dict) -> dict:
    """Write the score for a transcription with these bar settings.

    Bar lines follow the tracked beats when the performance drifts off a
    constant tempo (MuScriptor's default), so notes are quantized against the
    beat they were played on. The score carries one written tempo; the
    measure starts tie each bar to the recording, so Sync needs no guessing.
    """
    import numpy as np
    from muscriptor.tokenizer.notes import Note
    from muscriptor.utils.beats import BeatGrid
    from muscriptor.utils.midi import notes_to_midi, resolve_grid

    notes = [Note(is_drum=bool(d), program=int(p), onset=float(on), offset=float(off), pitch=int(pitch))
             for p, d, pitch, on, off in transcription["notes"]]
    names = {int(k): v for k, v in (transcription.get("names") or {}).items()}
    g = transcription.get("grid")
    grid = None if g is None else BeatGrid(
        bpm=g["bpm"], beats_per_bar=g["beatsPerBar"], first_downbeat=g["firstDownbeat"],
        beats=None if g["beats"] is None else np.asarray(g["beats"], dtype=float),
        onset_delay=g["onsetDelay"], beat_subdivision=g["beatSubdivision"], steady=g["steady"],
    )
    options, shift = _export_options(grid, bars)
    midi = notes_to_midi(notes, program_names=names, beat_grid=grid, options=options)
    buf = io.BytesIO()
    midi.save(file=buf)
    midi_bytes = buf.getvalue()
    resolved = resolve_grid(grid, options, [n.onset for n in notes])
    beats_per_bar = resolved.beats_per_bar or 4
    xml, parts, measures = _midi_to_musicxml(midi_bytes, transcription.get("title") or "Transcription",
                                             beats_per_bar, resolved.bpm)

    warnings = []
    if grid is None:
        warnings.append(WARN_NO_BEAT)
    elif resolved.beat_subdivision is None:
        warnings.append(WARN_LOOSE_RHYTHM)
    if bars.get("beatsPerBar") is None and (grid is None or grid.beats_per_bar is None):
        warnings.append(WARN_METER)
    return {
        "musicxml": xml,
        "parts": parts,
        "bpm": round(resolved.bpm, 2),
        "beatsPerBar": beats_per_bar,
        # Where each measure starts in the recording (seconds), from the same
        # beat grid the notes were written against.
        "measureStarts": _measure_starts(midi_bytes, beats_per_bar, measures),
        "warnings": warnings,
        "detected": {
            "beatsPerBar": grid.beats_per_bar if grid is not None else None,
            "bpm": round(grid.bpm, 2) if grid is not None else None,
        },
        "bars": {"beatsPerBar": bars.get("beatsPerBar"), "shiftBeats": shift,
                 "beatScale": float(bars.get("beatScale") or 1)},
    }


# MuScriptor's instrument groups (track names, "_" read as " ") -> the name the
# score shows, its abbreviation, and its place in a conductor's score: winds,
# brass, percussion, harp and keyboards, then strings. Names are ones the
# app's section classifier and abbreviation table already know; the General
# MIDI program written beside them settles the rest ("Strings", "Brass", "Harp").
INSTRUMENT_NAMES: dict[str, tuple[str, str]] = {
    "flutes": ("Flute", "Fl."),
    "oboe": ("Oboe", "Ob."),
    "english horn": ("English Horn", "E.H."),
    "clarinet": ("Clarinet", "Cl."),
    "bassoon": ("Bassoon", "Bsn."),
    "soprano and alto sax": ("Alto Saxophone", "A. Sax."),
    "tenor sax": ("Tenor Saxophone", "T. Sax."),
    "baritone sax": ("Baritone Saxophone", "Bar. Sax."),
    "french horn": ("Horn", "Hn."),
    "trumpet": ("Trumpet", "Tpt."),
    "trombone": ("Trombone", "Tbn."),
    "tuba": ("Tuba", "Tba."),
    "brass section": ("Brass", "Brass"),
    "timpani": ("Timpani", "Timp."),
    "drums": ("Drum Kit", "Dr."),
    "chromatic percussion": ("Mallet Percussion", "Mall."),
    "orchestral harp": ("Harp", "Hp."),
    "acoustic piano": ("Piano", "Pno."),
    "electric piano": ("Electric Piano", "E. Pno."),
    "organ": ("Organ", "Org."),
    "acoustic guitar": ("Guitar", "Gtr."),
    "clean electric guitar": ("Electric Guitar", "E. Gtr."),
    "distorted electric guitar": ("Distorted Guitar", "D. Gtr."),
    "voice": ("Voice", "Vo."),
    "orchestra hit": ("Orchestra Hit", "Hit"),
    "synth lead": ("Synth Lead", "Syn."),
    "synth pad": ("Synth Pad", "Pad"),
    "violin": ("Violin", "Vln."),
    "viola": ("Viola", "Vla."),
    "cello": ("Cello", "Vc."),
    "contrabass": ("Double Bass", "Cb."),
    "string ensemble": ("Strings", "Str."),
    "synth strings": ("Synth Strings", "Syn. Str."),
    "acoustic bass": ("Acoustic Bass", "Bass"),
    "electric bass": ("Electric Bass", "E. Bass"),
}
SCORE_ORDER = list(INSTRUMENT_NAMES)


def _part_label(track_name: str, program: int | None) -> tuple[str, str, int]:
    """(name, abbreviation, score-order rank) for one MuScriptor track."""
    key = track_name.replace("_", " ").strip().lower()
    if key in INSTRUMENT_NAMES:
        name, abbr = INSTRUMENT_NAMES[key]
        return name, abbr, SCORE_ORDER.index(key)
    # A group left out of `instruments` can still surface as "program <n>":
    # name it after the MuScriptor group that General MIDI program belongs to.
    group = _group_for_program(program) if program is not None else None
    if group in INSTRUMENT_NAMES:
        name, abbr = INSTRUMENT_NAMES[group]
        return name, abbr, SCORE_ORDER.index(group)
    name = key.title() or "Part"
    return name, "", len(SCORE_ORDER) + (program if program is not None else 200)


def _group_for_program(program: int) -> str | None:
    """MuScriptor's group name ("string ensemble") for a General MIDI program (0-based)."""
    from muscriptor.tokenizer.mt3 import MT3_FULL_PLUS_GROUP_NAMES, get_group_program_map

    programs = get_group_program_map("MT3_FULL_PLUS", "OMIT")
    for name, gid in MT3_FULL_PLUS_GROUP_NAMES.items():
        if program in programs.get(gid, []):
            return name.replace("_", " ")
    return None


def _midi_to_musicxml(
    midi_bytes: bytes, title: str, beats_per_bar: int, bpm: float | None,
) -> tuple[str, list[str], int]:
    """Quantized MIDI -> MusicXML with music21: (xml, part names in score order, measures)."""
    import mido
    from music21 import converter, metadata, stream

    # Track name, first program and drum channel of every track that plays.
    tracks = []
    for track in mido.MidiFile(file=io.BytesIO(midi_bytes)).tracks:
        notes = [m for m in track if m.type == "note_on"]
        if not notes:
            continue
        name = next((m.name for m in track if m.type == "track_name"), "")
        program = next((m.program for m in track if m.type == "program_change"), None)
        tracks.append((name.strip(), program, notes[0].channel == 9))

    with tempfile.TemporaryDirectory() as tmp:
        mid = Path(tmp) / "score.mid"
        mid.write_bytes(midi_bytes)
        parsed = converter.parse(str(mid), quantizePost=True)
        parts = list(parsed.parts) if isinstance(parsed, stream.Score) else [parsed]
        labeled = []
        for i, part in enumerate(parts):
            track_name, program, drums = tracks[i] if i < len(tracks) else (part.partName or f"Part {i + 1}", None, False)
            name, abbr, rank = _part_label(track_name, program)
            labeled.append((rank, i, part, {"name": name, "abbr": abbr, "program": program, "drums": drums}))
        labeled.sort(key=lambda x: (x[0], x[1]))
        s, bars = _even_score([x[2] for x in labeled], [x[3] for x in labeled], beats_per_bar, bpm)
        s.metadata = metadata.Metadata()
        s.metadata.title = title
        s.metadata.composer = "Transcribed by MuScriptor"
        xml_path = Path(tmp) / "score.musicxml"
        s.write("musicxml", fp=str(xml_path))
        return xml_path.read_text(encoding="utf-8"), [x[3]["name"] for x in labeled], bars


def _measure_starts(midi_bytes: bytes, beats_per_bar: int, bars: int) -> list[float]:
    """Recording seconds at which each of the score's `bars` measures starts.

    Read off the MIDI MuScriptor wrote: its tempo (map) turns beats into
    seconds, and its bar-offset marker says where in that playback the
    recording's 0 s falls. Measure k starts at beat (k - 1) * beats_per_bar,
    as in `_even_score`. A pickup bar that starts before the recording is
    clamped to 0.
    """
    import mido
    from muscriptor.utils.beats import read_bar_offset

    midi = mido.MidiFile(file=io.BytesIO(midi_bytes))
    offset = read_bar_offset(midi)
    tpb = midi.ticks_per_beat
    changes: dict[int, int] = {}
    for track in midi.tracks:
        tick = 0
        for msg in track:
            tick += msg.time
            if msg.type == "set_tempo":
                changes[tick] = msg.tempo
    tempi = sorted(changes.items()) or [(0, 500000)]
    if tempi[0][0] != 0:
        tempi.insert(0, (0, 500000))

    def seconds_at(tick: int) -> float:
        total = 0.0
        for i, (start, tempo) in enumerate(tempi):
            end = tempi[i + 1][0] if i + 1 < len(tempi) else None
            if end is not None and tick > end:
                total += (end - start) * tempo / 1e6 / tpb
                continue
            return total + (tick - start) * tempo / 1e6 / tpb
        return total

    starts = []
    for k in range(bars):
        t = max(0.0, seconds_at(k * beats_per_bar * tpb) - offset)
        if starts and t <= starts[-1]:
            t = starts[-1] + 0.01
        starts.append(round(t, 3))
    return starts


def _even_score(parts, labels: list[dict], beats_per_bar: int, bpm: float | None = None):
    """Rebuild every part on one bar grid: same meter, same number of full bars.

    music21's MIDI import gives each part its own length and can overfill a
    bar where voices overlap, which the app's parser flags ("parts disagree on
    the length of a measure"). Each part is flattened to one voice (chords
    where notes overlap), padded with rests to the longest part rounded up to
    a whole bar, then cut into measures with ties across barlines.

    Returns the score and its number of measures.
    """
    import math

    from music21 import instrument as m21instrument
    from music21 import meter, stream, tempo

    bar = float(beats_per_bar)
    end = max((float(p.flatten().highestTime) for p in parts), default=0.0)
    end = max(bar, math.ceil(end / bar - 1e-6) * bar)

    score = stream.Score()
    for part, label in zip(parts, labels):
        if label["drums"]:
            # chordify() drops unpitched hits; drum hits are short, so keep them as
            # they are (percussion chords) and only trim each to the next one.
            hits = sorted(part.flatten().notes, key=lambda n: float(n.offset))
            for hit, nxt in zip(hits, hits[1:]):
                gap = float(nxt.offset) - float(hit.offset)
                if gap > 0:
                    hit.quarterLength = min(float(hit.quarterLength), gap)
            voice = stream.Stream(hits)
        else:
            voice = part.chordify()  # one voice; overlapping notes become chords
        out = stream.Part()
        inst = m21instrument.Instrument()
        inst.instrumentName = label["name"]
        inst.partName = label["name"]
        if label["abbr"]:
            inst.partAbbreviation = label["abbr"]  # else the app derives one from the name
        if label["program"] is not None:
            inst.midiProgram = label["program"]
        if label["drums"]:
            inst.midiChannel = 9  # written as channel 10, the GM percussion channel
        out.insert(0, inst)
        out.partName = label["name"]
        out.insert(0, meter.TimeSignature(f"{beats_per_bar}/4"))
        if bpm and not score.parts:
            out.insert(0, tempo.MetronomeMark(number=round(bpm, 1)))
        for n in voice.flatten().notes:
            off = float(n.offset)
            if off >= end:
                continue
            n.quarterLength = min(float(n.quarterLength), end - off)
            if n.quarterLength <= 0:
                continue
            out.insert(off, n)
        out.makeRests(fillGaps=True, refStreamOrTimeRange=[0.0, end], inPlace=True, hideRests=False)
        out.makeMeasures(inPlace=True)
        out.makeTies(inPlace=True)
        score.insert(0, out)
    return score, int(round(end / bar))
