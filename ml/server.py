"""Local audio-to-score service for the Orchestra Visualizer.

Runs MuScriptor (Kyutai x Mirelo, multi-instrument transcription) and turns
its output into what the Node server needs:

  POST /score   whole recording -> background job; GET /score/{id} polls it
                and finally returns one multi-part MusicXML score (the
                visualizer imports it like an uploaded score)
  POST /notes   one time window of a recording -> notes per instrument, in
                seconds (the model slot of src/server/pipeline/model.ts)
  GET  /health  model status

Request bodies are the raw audio bytes (mp3, wav, flac, ...). The model is
loaded once and calls are serialized: one transcription at a time.

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

from fastapi import FastAPI, HTTPException, Query, Request

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
    from muscriptor.utils.midi import ExportOptions, resolve_grid

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
            # A constant tempo keeps the score simple; the Sync step maps measures
            # onto the recording afterwards. Quantized so it reads as notation.
            export = ExportOptions(tempo_map=False, quantize=True, fill_gaps=0.25)
            midi_bytes = model.events_to_midi_bytes(iter(events), beat_grid=grid, export=export)
            if grid is not None:
                grid = resolve_grid(grid, export, onsets)
        job.update(progress=0.92, message="Writing MusicXML")
        xml, parts = _midi_to_musicxml(
            midi_bytes, title, grid.beats_per_bar if grid else None, grid.bpm if grid else None)
        job.update(status="succeeded", progress=1.0, message="Done", result={
            "musicxml": xml,
            "parts": parts,
            "bpm": round(grid.bpm, 2) if grid else None,
            "beatsPerBar": grid.beats_per_bar if grid else None,
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


def _midi_to_musicxml(midi_bytes: bytes, title: str, beats_per_bar: int | None, bpm: float | None) -> tuple[str, list[str]]:
    """Quantized MIDI -> MusicXML with music21, keeping MuScriptor's track names."""
    import mido
    from music21 import converter, metadata, stream

    names = []
    for track in mido.MidiFile(file=io.BytesIO(midi_bytes)).tracks:
        name = next((m.name for m in track if m.type == "track_name"), "")
        if any(m.type == "note_on" for m in track):
            names.append(name.strip())

    with tempfile.TemporaryDirectory() as tmp:
        mid = Path(tmp) / "score.mid"
        mid.write_bytes(midi_bytes)
        parsed = converter.parse(str(mid), quantizePost=True)
        parts = list(parsed.parts) if isinstance(parsed, stream.Score) else [parsed]
        out_names = []
        for i, part in enumerate(parts):
            name = (names[i] if i < len(names) and names[i] else None) or part.partName or f"Part {i + 1}"
            out_names.append(name.replace("_", " ").title())
        s = _even_score(parts, out_names, beats_per_bar or 4, bpm)
        s.metadata = metadata.Metadata()
        s.metadata.title = title
        s.metadata.composer = "Transcribed by MuScriptor"
        xml_path = Path(tmp) / "score.musicxml"
        s.write("musicxml", fp=str(xml_path))
        return xml_path.read_text(encoding="utf-8"), out_names


def _even_score(parts, names: list[str], beats_per_bar: int, bpm: float | None = None):
    """Rebuild every part on one bar grid: same meter, same number of full bars.

    music21's MIDI import gives each part its own length and can overfill a
    bar where voices overlap, which the app's parser flags ("parts disagree on
    the length of a measure"). Each part is flattened to one voice (chords
    where notes overlap), padded with rests to the longest part rounded up to
    a whole bar, then cut into measures with ties across barlines.
    """
    import math

    from music21 import instrument as m21instrument
    from music21 import meter, stream, tempo

    bar = float(beats_per_bar)
    end = max((float(p.flatten().highestTime) for p in parts), default=0.0)
    end = max(bar, math.ceil(end / bar - 1e-6) * bar)

    score = stream.Score()
    for part, name in zip(parts, names):
        voice = part.chordify()  # one voice; overlapping notes become chords
        out = stream.Part()
        inst = m21instrument.Instrument()
        inst.partName = name
        inst.partAbbreviation = name[:6]
        out.insert(0, inst)
        out.partName = name
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
    return score
