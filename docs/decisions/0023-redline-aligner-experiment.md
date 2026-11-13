# 0023. Redline aligner as a selectable experiment

Date: 2026-11-13
Status: proposed

## Context
A second alignment method, redline-sync 0.1.0 (Python: numpy, scipy, numba,
librosa, ffmpeg), was offered for comparison with the integrated tempo
aligner (ADR 0014). The aim is to compare accuracy on real recordings before
deciding anything, without changing the default.

## Decision
Port the syncing part only (`features.py`, `align.py`) to TypeScript in
`src/lib/align/redline/`, run it in the existing alignment worker, and let
the user pick it per run on the Sync page (`components/sync/experiment/
AlignerChoice.tsx`, removable). Not ported: engraving, video rendering, the
CLI and `check.py`.

The port follows the reference step by step: features at 50 frames/s
(chroma of 4 registers + a silence flag, onset chroma, onset strength),
a rough 2 frames/s DTW with free ends on the printed tempi, then three banded
passes on the recording's time axis (10 fps ±15 s, 50 fps ±5 s, 50 fps
±1.5 s) with a 0.3 toll for leaving the current estimate; float32 storage
and numpy/scipy edge conventions (half-even rounding, `np.interp`,
`uniform/maximum/gaussian_filter1d`) are kept. Differences forced by the
app:

- The score comes from the info map, not MusicXML: positions are score
  seconds at the written tempo (the reference uses quarter notes only to
  reach that same nominal axis); repeats are expanded; weights come from the
  written dynamic mapped to MuseScore's `<sound dynamics>` values; grace
  notes are skipped and a percussion part whose every note is MIDI 60 is
  treated as unpitched.
- Resampling to 22050 Hz uses a Kaiser-windowed sinc with swresample's
  defaults instead of ffmpeg; `librosa.estimate_tuning` is ported.
- The DTW keeps two rows of accumulated cost instead of the full matrix
  (same path, less memory).
- On top: measure starts are read from the onset table and scored with the
  integrated aligner's heuristic confidence (`integratedConfidences`, using
  the rough pass as its seed).

Manual markers are not passed to redline (ADR 0021 does not apply to it yet);
range runs align the bar range like any other method. If it throws, the
chroma DTW fallback runs as for the integrated aligner.

## Consequences
Both methods can be compared on the same project. While the experiment is
on, the first Sync visit waits for "Start sync" instead of aligning
automatically. Open: the redline source has no stated license; confirm
before this leaves an experiment. Keep, adopt as default, or remove after
comparing on real recordings.
