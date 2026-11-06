# Transcription service (experimental)

Turns a recording into a score with [MuScriptor](https://github.com/muscriptor/muscriptor)
(Kyutai × Mirelo, multi-instrument transcription), so a project with only an
MP3 can still be visualized. Branch `sulaiman/audio-to-score`; this is a
later-phase item (STATE.md open question 6) and is not part of the MVP.

## One-time setup

1. Accept the model licence on Hugging Face (free, granted at once):
   https://huggingface.co/MuScriptor/muscriptor-medium
   The **weights are CC BY-NC 4.0: non-commercial use only.** The code is MIT.
2. Log in on this machine: `uvx hf auth login` (or `export HF_TOKEN=hf_...`).
3. Install: `cd ml && uv sync --python 3.11` (PyTorch, MuScriptor, music21).

## Run

```bash
docker compose up -d     # Postgres + S3Mock
npm run ml:serve         # this service on http://127.0.0.1:8333
npm run dev              # the app
```

In the app: new project → Import → drop an MP3 → in the Score card pick the
instruments to listen for (**Orchestra**, **Strings + keyboard**, or **Any
instrument**) and choose **Transcribe**. Left free, the model often hears a
string orchestra as guitar and electric bass; the first two options forbid
every other instrument while decoding. The service writes a multi-part MusicXML score, which is
imported like an uploaded one; then Sync → Customize → Preview as usual.

The first run downloads the weights (~1.2 GB for `medium`). Pick another size
with `MUSCRIPTOR_MODEL=small|medium|large npm run ml:serve`; `large` is the
most accurate and much slower on a laptop. On Apple Silicon it runs on the GPU
(MPS).

## Endpoints

| | |
|---|---|
| `GET /health` | model name, whether it is loaded, last load error |
| `POST /score?filename=&title=&ensemble=orchestra\|strings\|any` | body = audio bytes → `{id}`; transcribes the whole recording in the background |
| `GET /score/{id}` | `{status, progress, message, result: {musicxml, parts, bpm, ...}, error}` |
| `POST /notes?start=&end=&filename=` | body = audio bytes → notes per instrument in that window (the `/api/transcriptions` model slot, used when `TRANSCRIBER_URL` is set) |

## Known limits

- No written dynamics: MuScriptor outputs no velocity, so every part shows at
  the default brightness. Deriving dynamics from the audio would break the
  "match the score" principle, so it is not done.
- Instruments come from a fixed list (violin, viola, cello, contrabass, flutes,
  oboe, clarinet, bassoon, french horn, trumpet, trombone, tuba, timpani,
  harp, piano, …). Sections of identical instruments (Violin I / II) come out
  as one part.
- Every part is rebuilt on one bar grid (same meter, same number of full
  bars, ties across barlines), so the app's parser sees consistent measures.
- A constant tempo (the detected BPM) is written; the Sync step aligns the measures to the
  recording afterwards.
- Accuracy on dense orchestral music is far below a real score; see the
  MuScriptor paper. Treat the result as a sketch.
