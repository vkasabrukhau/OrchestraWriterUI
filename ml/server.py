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
async def score(request: Request, filename: str = "audio.mp3", title: str = ""):
    """Start transcribing the whole recording into one multi-part MusicXML score."""
    path = await _audio_file(request, filename)
    job_id = uuid.uuid4().hex
    _jobs[job_id] = {"status": "running", "progress": 0.0, "message": "Waiting for the model", "result": None, "error": None}
    threading.Thread(target=_run_score, args=(job_id, path, title or Path(filename).stem), daemon=True).start()
    return {"id": job_id}


@app.get("/score/{job_id}")
def score_status(job_id: str):
    job = _jobs.get(job_id)
    if job is None:
        raise HTTPException(404, "No such transcription job")
    return job


def _run_score(job_id: str, path: Path, title: str) -> None:
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
            for ev in model.transcribe(path):
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
        xml, parts = _midi_to_musicxml(midi_bytes, title)
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


def _midi_to_musicxml(midi_bytes: bytes, title: str) -> tuple[str, list[str]]:
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
        s = converter.parse(str(mid), quantizePost=True)
        parts = list(s.parts) if isinstance(s, stream.Score) else [s]
        out_names = []
        for i, part in enumerate(parts):
            name = (names[i] if i < len(names) and names[i] else None) or part.partName or f"Part {i + 1}"
            name = name.replace("_", " ").title()
            part.partName = name
            part.partAbbreviation = name[:6]
            out_names.append(name)
        s.metadata = metadata.Metadata()
        s.metadata.title = title
        s.metadata.composer = "Transcribed by MuScriptor"
        xml_path = Path(tmp) / "score.musicxml"
        s.write("musicxml", fp=str(xml_path))
        return xml_path.read_text(encoding="utf-8"), out_names
