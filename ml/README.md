# Transcription service (experimental)

Turns a recording into a score with [MuScriptor](https://github.com/muscriptor/muscriptor)
(Kyutai × Mirelo, multi-instrument transcription), so a project with only an
MP3 can still be visualized. Experimental and not part of the MVP: a
later-phase item (STATE.md open question 6), offered on Import once a
recording is uploaded. Locally it runs on your machine; the deployed site runs
it on an AWS GPU instance that starts on demand (see "On AWS" below, ADR 0014).

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
imported like an uploaded one; then Sync → Customize → Preview as usual. Sync opens
already aligned (100%, method `transcription-beats`): the service reports where each
measure starts in the recording, from the same beat grid the notes were written against.
"Re-run auto-alignment" still replaces it with the chroma-DTW aligner.

The job runs on the server, so leaving or reloading the Import page is safe: the
page asks the server and picks the running transcription back up.

Under the parsed score, the Import page then says what the transcription is
unsure about ("The time signature wasn't detected, so 4/4 was assumed",
"note lengths are approximate" when the music doesn't follow a steady beat)
and offers **Bars** corrections: time signature, bar lines one beat earlier or
later, half or double tempo. Applying them rewrites the score from the saved
transcription in seconds (no model run) and redoes the sync.

## On AWS

The deployed site uses one `g4dn.xlarge` (NVIDIA T4) named
`orchestra-writer-transcriber`, created once by `scripts/ml-init.sh` (ADR 0014):

- **On demand.** When someone transcribes (or corrects bars), the API starts the
  instance if it is stopped (`src/server/services/transcriber.ts`); the job shows
  "Starting the GPU server (about 2 minutes)". The instance stops itself after 15
  minutes without a transcription or a call from the app (`deploy/idle-stop.sh`).
  It costs ~$0.53/hour while running and ~$6/month of disk while stopped.
- **Code.** Every deploy uploads `ml/` to `s3://orchestra-writer-s3/system/transcriber/ml.tar.gz`
  (`deploy/package.sh`). The instance installs the newest copy each time it
  starts (`deploy/prepare.sh`), so a running instance picks up a deploy after its
  next idle stop. PyTorch, Python and the weights stay on its disk; only the
  first boot of a new instance downloads them (~10 minutes).
- **Access.** HTTPS on port 8333 with a self-signed certificate the API pins, and
  a bearer token (`TRANSCRIBER_TOKEN`); every call but `GET /health` needs it.
  Token, certificate, TLS key and the Hugging Face token live in SSM under
  `/orchestra-writer/`.
- **Debugging.** No SSH; use Session Manager:
  `aws ssm start-session --target <instance-id>`, then `journalctl -u ov-transcriber -f`
  (service) or `journalctl -t ov-idle-stop` (why it stopped).

`deploy/` holds the instance side: `install.sh` (first boot, from EC2 user-data),
`prepare.sh` (before every start: code, secrets, `uv sync`), `run.sh` (uvicorn),
`idle-stop.sh` and the systemd units.

## Tests

`npm run ml:test` (stdlib `unittest`, no model needed) writes scores from
synthetic performances, steady and slowing down, and checks that bars start on
the true downbeats, that corrections move them as asked, part names, drums, and
the warnings.

The first run downloads the weights (~1.2 GB for `medium`). Pick another size
with `MUSCRIPTOR_MODEL=small|medium|large npm run ml:serve`; `large` is the
most accurate and much slower on a laptop. On Apple Silicon it runs on the GPU
(MPS).

## Endpoints

| | |
|---|---|
| `GET /health` | model name, whether it is loaded, last load error |
| `POST /score?filename=&title=&ensemble=orchestra\|strings\|any` | body = audio bytes → `{id}`; transcribes the whole recording in the background |
| `GET /score/{id}` | `{status, progress, message, result: {musicxml, parts, bpm, beatsPerBar, measureStarts, warnings, detected, bars, transcription, ...}, error}`; `measureStarts[k]` = recording seconds where measure k+1 starts; `transcription` = the model's notes + beat grid, for `/rebar` |
| `POST /rebar` | JSON `{transcription, bars: {beatsPerBar, shiftBeats, beatScale}}` → the same result as `/score`, in seconds and without the model: the score rewritten with corrected bars (time signature, bar lines moved later by whole beats, half/double tempo); they move bar lines, never notes |
| `POST /notes?start=&end=&filename=` | body = audio bytes → notes per instrument in that window (the `/api/transcriptions` model slot, used when `TRANSCRIBER_URL` is set) |

## Known limits

- No written dynamics: MuScriptor outputs no velocity, so every part shows at
  the default brightness. Deriving dynamics from the audio would break the
  "match the score" principle, so it is not done.
- Instruments come from a fixed list (violin, viola, cello, contrabass, flutes,
  oboe, clarinet, bassoon, french horn, trumpet, trombone, tuba, timpani,
  harp, piano, …). Sections of identical instruments (Violin I / II) come out
  as one part. Parts are written in score order (winds, brass, percussion,
  harp and keyboards, strings) with plain names, standard abbreviations
  ("Hn.", "Cb.") and their General MIDI program, so the app sorts each into
  the right section.
- Every part is rebuilt on one bar grid (same meter, same number of full
  bars, ties across barlines), so the app's parser sees consistent measures.
- Bar lines follow the tracked beats when the performance drifts off a
  constant tempo (MuScriptor's default), so notes are quantized against the
  beat they were played on; the score itself carries one written tempo (the
  fitted BPM), and the measure starts above tie each bar to the recording.
  When no meter is detected, 4/4 is written from the tracker's first
  downbeat, with a warning; correct it under Bars.
- Accuracy on dense orchestral music is far below a real score; see the
  MuScriptor paper. Treat the result as a sketch.
