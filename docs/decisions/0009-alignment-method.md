# 0009. Alignment: chroma DTW in a browser Web Worker, results stored by the API

Date: 2026-10-26
Status: accepted (resolves open question 2 in STATE.md); the default aligner is refined by 0014, chroma DTW stays as its fallback

## Context
The skill `score-audio-alignment` listed synthesize-and-match, chroma DTW and
beat tracking. The browser already decodes the MP3 for playback, and the
output (one time and confidence per measure) is tiny. A server aligner needs
an audio decoding stack (ffmpeg/librosa) and a Python worker that does not
exist yet. See `docs/research/sync-and-instrument-identification.md`.

## Decision
- `src/lib/align/` implements chroma DTW in TypeScript: STFT chroma of the
  recording, score chroma synthesized from the info map (notes weighted by the
  written dynamic), banded DTW with cosine cost, measure starts from the
  warping path, confidence from local path cost with penalties for degenerate
  runs and silent bars. It runs in a Web Worker with progress and can be
  cancelled.
- The result is a `SyncState` (`method: "chroma-dtw"`) saved with
  `PUT /projects/:id/sync`. Manual markers are stored separately and merged
  with `mergeAlignment()`; re-running alignment never discards them.
- The `Aligner` interface in `src/shared/sync.ts` is the stable seam. A
  server-side Sync Toolbox (MIT) aligner is the planned upgrade when a Python
  worker exists, chosen if measured accuracy on real recordings is better.

## Measured accuracy (demo fixture: 14 parts, 56 playback bars, 129 s, 1.2 s lead-in, ±4–5 % tempo warp)

| Scenario | Within ±150 ms | Within ±300 ms | Max error | Mean error |
|---|---|---|---|---|
| Synthesized audio, same warp (unit test) | 56/56 | 56/56 | 145 ms | 32 ms |
| The committed MP3, decoded | 55/56 | 56/56 | 171 ms | 56 ms |
| 44.1 / 48 kHz input | 56/56 | 56/56 | 145 / 141 ms | 32 / 30 ms |
| 6 s lead-in with noise burst and hiss | 56/56 | 56/56 | 93 ms | 28 ms |
| Smooth rubato ±8 % | 56/56 | 56/56 | 78 ms | 31 ms |
| Played 30 % slower than written | 56/56 | 56/56 | 72 ms | 30 ms |

Alignment takes about 0.2–0.3 s in Node for this piece. Confidence is 100 for
every bar except the general-pause bar (45, "Uncertain"); the thresholds were
tuned on synthetic audio and still need a check against real recordings.
Transposing instruments must be aligned at sounding pitch (the parser records
`transpose`); ignoring it put two bars 430–555 ms off.

## Consequences
- Alignment accuracy is measured on the generated fixture (known warp) in
  `npm test` (`tests/unit/align`).
- Very long recordings (> 20 min) may need a coarser hop; the band and hop are
  parameters.
