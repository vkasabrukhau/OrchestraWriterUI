# 0014. Alignment: "Integrated tempo from original search", ported to the browser

Date: 2026-11-03
Status: proposed (default aligner on `feat/integrated-sync`; refines 0009)

## Context
Score Sync Lab's preferred method, **Integrated tempo from original search**
(`docs/research/score-sync-lab/INTEGRATED_FROM_ORIGINAL_GUIDE.md`), was
chosen by listening to the full Tchaikovsky 6 first movement (354 bars,
about 18 minutes). It is a Python pipeline built on music21, Sync Toolbox,
librosa and SciPy. Our aligner (0009) is pitch-only chroma DTW in a Web
Worker. Both must sit behind the `Aligner` interface and return one start
and one confidence per measure. Manual markers stay separate (`.claude/rules/sync.md`).

How the two compare:

| | chroma DTW (0009) | integrated tempo (this ADR) |
|---|---|---|
| Evidence | pitch-class (chroma) only | chroma, expected vs heard loudness, attacks, ensemble rests, structural change; a missing cue scores 0.5, not a perfect match |
| Search | one banded DTW at ~93 ms | 2 Hz whole-piece subsequence DTW (broad seed), then a 50 Hz ±4 s corridor |
| Timing model | warping path smoothed per measure | continuous clock fitted jointly to audio and tempo continuity (log-rate changes penalized, relaxed at fermatas and ensemble gaps), validated against the raw cost |
| Written tempo changes | none | kept: continuity is measured against nominal durations |
| Confidence | path distinctiveness + penalties | none in the method; we add a labeled heuristic (below) |
| Manual markers | merged afterwards (`mergeAlignment`) | same; the method has no anchor input (guide §15) |

## Decision
Port the method to TypeScript in `src/lib/align/integrated/` and make it the
default (`DEFAULT_ALIGN_METHOD` in `src/lib/align/select.ts`). It runs in the
existing Web Worker, and `runAlignment()` falls back to chroma DTW when it
cannot run (recording under 2 s or over 40 minutes, a broad match over 8 M
cells). Saved results carry `method: "integrated-tempo"` and a small
`diagnostics` block: accepted/converged flags, broad-match cost and margin,
raw acoustic cost before and after, max shift from the seed, and knot count.

What matches the reference: the cue table, weights and masks; quantized
chroma (L1, thresholds 0.4/0.2/0.1/0.05); the 2 Hz DTW steps (1,1), (1,2),
(2,1) with weights 1, 1, 2 and endpoint ranking by cost per score row; the
knot grid (sixteenths, tempo changes, protection boundaries, seed
positions); the residuals (acoustic √cost with a cubic Hermite, corridor 4×,
continuity λ = 0.25 / spacing, monotone barrier 1000×, endpoints 1e-4); the
two stages at σ = 0.10 s and 0.04 s; the ±4 s bounds; and acceptance (valid
clock, band excess under 0.02 s, raw cost no more than 0.02 worse).

Where the port differs:
- **Recording pitch energy** comes from a 186 ms Hann STFT folded to pitch
  classes, with tuning estimated from spectral peaks. The reference uses
  Sync Toolbox's IIR filterbank. Energies are scaled to the filterbank's
  40 ms windowed sum so the 0.001 silence threshold sits near −50 dBFS.
  Measured as a mean, it would have marked the demo's *p* opening silent.
- **Score loudness** reads each note's written dynamic from the info map
  (music21-like volume scalars). Hairpins are not modeled, and one style
  marking per note means staccato and accent never combine.
- **Solver**: bounded Levenberg–Marquardt with an exact pentadiagonal LDLᵀ
  solve instead of SciPy TRF/LSMR. The objective is the same; every
  residual touches at most three neighboring knots.
- **Cue masks** are computed once over the whole piece instead of per
  window slice. That removes the slice-edge effect the guide warns about.
- **Knots closer than 1e-4 quarter notes are merged.** Positions rebuilt
  from the info map's rounded seconds otherwise create near-zero intervals
  that freeze the fit. Before this fix it froze at the general pause.
- **Not ported**: the score audit and mixed-meter normalization, pause
  variables (unused by this method), alternative-occurrence reporting
  beyond the margin, and the beat-interval audit tables.

To support it, the parser now emits an optional `infoMap.timing`: the tempo
map in score seconds and fermata spans merged across parts. Info maps saved
before this change fall back to the single `tempo` with no fermatas.
Ensemble gaps are always derived from the notes.

Per-measure confidence (`integrated/confidence.ts`) is a **heuristic review
score**. It starts from boundary distinctiveness: joint cost on the clock
against 0.3–2 s off it. It is then reduced for bars with no pitched
material, for large moves from the broad seed, and for a tempo mismatch
across the boundary. It is capped at 89 ("Check") when the fit fell back.
It has not been calibrated against hand-marked timings (guide §14).

## Measured accuracy
Demo fixture: 14 parts, 56 playback bars, 129 s, 1.2 s lead-in, ±4–5 % warp.
Reproduce with `npx tsx scripts/eval-align.ts --mp3` (needs ffmpeg).

| Scenario | Aligner | ±150 ms | ±300 ms | Max | Mean | Time (Node) |
|---|---|---|---|---|---|---|
| Synthesized, demo warp | chroma DTW | 56/56 | 56/56 | 145 ms | 32 ms | 0.2 s |
| | integrated | 55/56 | 56/56 | 151 ms | 22 ms | 1.7 s |
| Smooth rubato ±8 % | chroma DTW | 56/56 | 56/56 | 80 ms | 34 ms | 0.2 s |
| | integrated | 56/56 | 56/56 | 115 ms | 20 ms | 1.8 s |
| 30 % slower than written | chroma DTW | 56/56 | 56/56 | 89 ms | 30 ms | 0.3 s |
| | integrated | 56/56 | 56/56 | 133 ms | 22 ms | 2.0 s |
| Committed MP3 (ffmpeg decode) | chroma DTW | 56/56 | 56/56 | 145 ms | 74 ms | 0.2 s |
| | integrated | 54/56 | 56/56 | 196 ms | 66 ms | 1.6 s |
| Demo ×8 (1006 s, 448 bars) | chroma DTW | 446/448 | — | 156 ms | 33 ms | 3.5 s |
| | integrated | 443/448 | — | 162 ms | 21 ms | 12.9 s |

The integrated aligner's mean error is about a third lower; its worst bars
are the opening (bar 1, about 120 ms late) and the general pause (bar 40,
about 150 ms; reported at 42 %, "Uncertain"). The guide flags the opening as
a known place to validate. All of this is synthetic audio with a sine-ish
synth, where both methods are near their floor; the reason to switch is the
reference's behavior on a real orchestral recording, which we have not yet
measured here.

## Consequences
- Alignment takes several times longer: about 2 s for the demo and about
  13 s for 17 minutes. It stays off the main thread, with progress and
  cancel. The 50 Hz corridor holds two Float32 fields of samples × 401
  (about 85 MB each for 18 minutes).
- Chroma DTW stays as the fallback and as an option (`{ method: "chroma-dtw" }`).
- Open: enforcing manual markers inside the fit (guide §15), calibrating
  confidence on real recordings with hand-marked bars, and a numerical
  comparison against the Python reference on the Tchaikovsky recording.
  The last one needs the score and recording files.
