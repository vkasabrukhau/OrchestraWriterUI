# Integrated tempo from original search

## Implementation guide and extension map

**Verified against the local implementation on November 2, 2026.**

This document describes the method named **Integrated tempo from original search** in Score Sync Lab. The user currently considers this the best candidate based on manual listening and score-following review. That preference is a human assessment, not a benchmark result or a claim that every note is correctly aligned.

This document is self-contained: the explanation, focused implementation, dependency versions, and representative verification tests are included directly. The first part explains the actual algorithm in enough detail to reproduce its behavior. Only the code for the selected method is included. The final part identifies existing code and diagnostics relevant to future confidence displays and user corrections. Those final sections are integration guidance, not specifications for already implemented features.

### Reading paths

- Overview: [summary](#1-summary-of-what-happens), [included implementation](#2-included-implementation), [libraries](#3-libraries-and-their-actual-roles).
- Reimplementation: [coordinates](#4-coordinates-and-data-contracts), [score preparation](#5-prepare-and-audit-the-score), [features](#6-build-pitch-and-expressive-profiles), [costs](#7-compute-the-pairwise-mismatch-cost), [broad matching](#8-find-the-original-broad-match), [joint optimization](#9-jointly-fit-acoustic-agreement-and-tempo), [reproduction](#10-packaging-cache-behavior-and-reproduction).
- Interpretation: [existing diagnostics](#12-diagnostics-already-available), [saved example](#13-verified-example-from-the-current-saved-run).
- Future development: [measure confidence](#14-extension-guidance-confidence-for-each-measure), [manual anchors](#15-extension-guidance-user-confirmed-manual-alignment-anchors), [improvements](#16-improvement-opportunities-and-limitations).

### Three terms that must remain separate

| Term | Meaning | Present behavior |
|---|---|---|
| Alignment mapping | A function connecting a score position to a recording timestamp | Estimated by the algorithm and used by playback |
| Review marker | A location worth listening to, possibly because timing moved or beats look irregular | Displayed for inspection; does not constrain optimization |
| Manual alignment anchor | A user-confirmed correspondence: **this score position occurs at this audio timestamp** | Not currently supported as an enforced input to this method |

Clicking a score position or review marker to seek playback does **not** create a manual alignment anchor. Likewise, a field called `anchors` in a saved result does not mean its rows are enforced constraints.

## 1. Summary of what happens

1. Read the MusicXML score and establish one shared timeline across instruments. Convert written pitches to sounding pitches and account for tempo marks and repeats.
2. Build comparable pitch profiles from the score notes and recording. Build separate profiles for expected/heard loudness, attacks, ensemble rests, and structural changes.
3. Compare the entire supported score with the whole recording at a coarse resolution. Our code supplies a mismatch matrix. Librosa's dynamic time warping finds an ordered path through that matrix.
4. Use that broad alignment as the initial estimate for a **whole-piece joint optimization**. At this stage, audio agreement and tempo continuity influence the same timing decisions.
5. Allow beat lengths to change, but penalize unexplained rapid changes in timing rate. Reduce this continuity pressure around identified fermatas and ensemble gaps.
6. Check whether the resulting clock is valid, stays within its acoustic search neighborhood, and has not degraded the raw feature agreement beyond the configured tolerance.
7. Save the mapping and diagnostics. Generate review locations and beat-length comparisons for manual inspection.

The method does not transcribe the recording into individual notes. It estimates a continuous score-to-recording clock from time-varying feature agreement. Every note inherits its predicted recording position from that clock.

### The most important architectural distinction

The seed is the **original broad Structure Search match**, rebuilt by `original_coarse()`. It is not the final historical `Structure search test` result, which also has its own local-window refinement. This integrated version does **not** run that old eight-second-window refinement and then apply a smoother to its output.

The selected path is:

```text
MusicXML → shared score clock → direct score features ─┐
                                                     ├→ global 2 Hz custom-cost DTW
Recording → tuning + pitch/energy/attack features ───┘
       → original broad mapping
       → 50 Hz acoustic corridor around that mapping
       → jointly fit all timing knots with tempo continuity
       → validate → final mapping + diagnostics + review locations
```

This guide and its executable entry point cover only this original-broad-search initialization.

## 2. Included implementation

Appendix A contains one module, `integrated_original.py`. Save that block under that name to run the method independently. It includes only the selected algorithm and its supporting preparation, solver, and diagnostic functions.

| Responsibility | Included functions |
|---|---|
| Shared score clock | `normalized_xml`, `load_score`, `parse_score`, `score_clock`, `quarter_at` |
| Coverage audit | `audit_score_prefix` |
| Pitch features | `extract_pitch` |
| Expressive features | `score_envelope`, `audio_profile`, `scale_envelope`, `attack_envelope` |
| Feature containers and structure | `_features`, `_slice`, `_downsample`, `_novelty` |
| Broad matching | `joint_cost`, `_solve_cost`, `_mapping`, `original_coarse` |
| Fermata and ensemble gaps | `protected_intervals` |
| Joint optimization | `optimize_mapping`, `optimize_cost_times_direct`, `_direct_residual_jac`, `acoustic_mean` |
| Output and evaluation | `package_method`, `evaluate_evidence`, `audit_methods`, `write_audit` |
| Single-method entry point | `run_original_search` |

The active solver is sparse nonlinear least squares in absolute knot times. The standalone module contains no alternate alignment modes, old log-duration solver, synthesis pipeline, or mode-selection catalog.

The wrapper is adapted for standalone use. The cost and direct optimizer retain the current implementation. It does not reproduce application cache files or inherited UI marker lists; these do not determine the alignment. Its provenance and verification limits are stated below.

## 3. Libraries and their actual roles

Versions below were inspected in `.venv312`, not inferred from broad dependency ranges.

| Library | Installed version | Use in this workflow |
|---|---:|---|
| music21 | 9.9.2 | MusicXML parsing, score objects, sounding pitches, ties, tempo/dynamic/articulation access, repeat expansion; chordify supplies a separate harmony inspection table |
| Sync Toolbox (`synctoolbox`) | 1.4.2 | Tuning estimation, recording pitch features, symbolic note pitch features, octave folding and chroma quantization |
| librosa | 0.11.0 | Audio decoding/resampling, RMS energy, spectral-flux onset strength, and custom-cost subsequence DTW/backtracking for the original broad seed |
| NumPy | 2.4.6 | Arrays, interpolation, normalization, score/audio grids, numeric validation |
| pandas | 2.3.3 | Notes, measures, mappings, marker and diagnostic tables |
| SciPy | 1.18.1 | Filtering, novelty peak selection, sparse Jacobians, `least_squares` with TRF and LSMR |
| SoundFile | 0.14.0 | Audio decoding backend and generated WAV input for the smoke test |

This method uses direct score features. MIDI synthesis, FluidSynth, soundfonts, and rendered-reference comparison code are not required or included.

Music21 is not run on the recording. `chordify()` is not an audio chord detector and chord labels are not passed to this method's matcher. “Harmony” below means comparing pitch-class feature vectors, not comparing named chords.

The public library APIs confirm that Librosa accepts a supplied cost matrix and custom DTW steps, while SciPy's least-squares solver minimizes a bounded nonlinear residual objective. The feature definitions, weights, time model, and acceptance rules described below are project code built around those APIs. See [Librosa DTW documentation](https://librosa.org/doc/0.11.0/generated/librosa.sequence.dtw.html) and [SciPy least-squares documentation](https://docs.scipy.org/doc/scipy/reference/generated/scipy.optimize.least_squares.html). Installed package source remains the exact authority for pinned-version behavior.

## 4. Coordinates and data contracts

Keep three different quantities explicit:

- **`q`: shared musical position**, in quarter-note units after normalization and repeat expansion.
- **`s`: nominal score time**, in seconds derived from written metronome marks.
- **`t`: recording time**, in seconds from the beginning of the uploaded audio file.

A tempo segment beginning at `(q_j, s_j)` with quarter-note tempo `b_j` defines:

```text
s(q) = s_j + (q - q_j) × 60 / b_j
```

The result estimates `T(s) = t`. It does not replace `s(q)` or the score's notation.

### Parsed score

`parse_score()` returns a dictionary including:

```text
notes: DataFrame(start, duration, pitch, velocity, instrument, part, note)
measures: DataFrame(measure, printed_label, score_sec, quarter)
tempo_map: [{quarter, score_sec, bpm}, ...]
duration: nominal score extent in seconds
chords: chordify inspection table
warnings, timing_version, timing_repairs
```

`measure` denotes playback order. A printed measure number alone is insufficient to identify a repeated occurrence.

### Features

The aligned feature container has:

```text
chroma: float array [12, N]
level: float array [N]
attack: float array [N]
rest: bool array [N]
rate: frames per second
novelty: float array [N]
novelty_valid: bool array [N]
```

Score and recording have separate frame counts. `_features()` trims channels to their common available length and checks finiteness.

### Result

The main contract is a DataFrame with increasing `score_sec` and nondecreasing `recording_sec`. Accepted direct optimization outputs have strictly increasing recording knots. Packaging also includes `measures`, `coverage`, `diagnostics`, `anchors`, `accepted_anchors`, and `provisional_markers`.

Interpolation must respect coverage. Outside the mapping's supported score range, return unavailable values rather than silently extending the first/last timestamp. The comparison code uses `np.interp(..., left=np.nan, right=np.nan)` for this reason.

## 5. Prepare and audit the score

### 5.1 Shared time and repeats

`load_score()` normalizes a supported case of simultaneous 4/4 and 12/8 notation before music21 parsing. Compound voices can be represented as triplets on a shared 4/4 clock. This is a targeted repair, not a general promise to understand arbitrary polymeter or malformed MusicXML. Unsupported offsets, forward gaps, or ambiguous durations can raise an error. The uploaded file is not overwritten.

The internal score can normalize the meter while display preparation retains written meters. If repeat expansion is enabled, `score.expandRepeats()` produces playback order before timing extraction.

`audit_score_prefix()` compares parts' measure ordering, starts, meter durations, and duration excess. Relevant tolerances include 0.025 quarter notes for cross-part timing/meter disagreement and 0.05 quarter notes for material excess. It stops supported coverage at unresolved ambiguity instead of claiming the whole score is usable. Parsed and audited measure clocks must agree.

### 5.2 Nominal seconds and note rows

`parse_score()` gathers metronome marks across parts. Conflicting positive tempos at one position raise an error. If no starting mark exists, it inserts a nominal 120 quarter notes/minute and records a warning.

It converts to sounding pitch and joins ties for symbolic pitch/onset preparation. Zero-duration events are omitted. Unpitched notes and pitches outside MIDI 21–108 are excluded from the pitched alignment table. Each note row gets velocity 80, but the pitch feature builder is explicitly told to ignore velocity.

The full score extent includes trailing rests. Feature padding prevents the symbolic pitch timeline from stopping prematurely at the final pitched note.

Equal velocity applies only to the pitch table. Expressive dynamics are supplied separately by `score_envelope()`.

## 6. Build pitch and expressive profiles

### 6.1 Recording pitch profile

`extract_pitch()` decodes the recording with `librosa.load(..., sr=22050, mono=True)`. This wrapper validates a 2-second to 40-minute recording, rejects silence/nonfinite input, and limits nominal score duration to 40 minutes.

Sync Toolbox estimates tuning, then `audio_to_pitch_features` produces pitch-band energy at **50 Hz**, one feature frame every 20 ms. In installed version 1.4.2, this is an IIR filterbank followed by short-time mean-square power aggregation. It is not polyphonic note transcription. The output has 128 pitch rows, with the requested MIDI 21–108 range populated.

For this invocation, the nominal aggregation window is twice the feature hop: about 40 ms. The implementation adjusts group delay and uses its internal pitch-dependent downsampled signals.

`pitch_to_chroma` adds rows with equal `pitch % 12`, discarding octave identity at this matching stage. `quantize_chroma` uses thresholded L1 normalization and thresholds `[0.40, 0.20, 0.10, 0.05]`, each contributing 0.25. The joint matcher subsequently L2-normalizes chroma columns for cosine comparison.

Overtones, orchestration, room response, and overlapping voices affect these energies. A high chroma similarity is useful evidence, not proof that every underlying note was identified correctly. The pitch matrices exist during feature extraction. A future octave-aware extension could retain them instead of discarding them after chroma conversion.

### 6.2 Direct score pitch profile

`df_to_pitch_features(parsed['notes'], feature_rate=50, ignore_velocity=True)` converts symbolic note occupancy into the pitch-feature representation. The result is padded through `ceil(duration × 50) + 1` frames, folded to chroma, and quantized just like the recording representation.

No audio is synthesized here. A score snapshot is the expected pitch content of that score-time interval, constructed from note start/end information.

### 6.3 Expected score loudness, attacks, and rests

`score_envelope(..., detailed=True)` separately reads the normalized score. For each part:

1. Start with dynamic strength 0.5; apply music21 dynamic `volumeScalar` values from their written positions onward.
2. Interpolate dynamic wedges between their endpoints. Use a nearby following dynamic marking when available; otherwise approximate an increase/decrease of 0.2, clipped to 0.05–1.
3. Track active note count. Strong accents use factor 2.2, ordinary accents 1.8, other notes 1.
4. Shorten staccato activity to half its written duration.
5. For attacks, add `sqrt(note_count) × strength² × accent` with a short approximately 60 ms declining envelope. Tie continuation/stop events should not create fresh attacks under the implemented event-level tie check.
6. Give accents an approximately 80 ms transient activity boost, rather than increasing their entire sustained duration.
7. Add `sqrt(activity) × strength²` from each part to the ensemble loudness prediction.
8. Mark an ensemble rest where summed sounding activity is zero.

`scale_envelope()` applies `log1p`, uses the 5th/95th percentiles as scale endpoints, and clips to 0–1. Attack normalization uses `log1p` and the 95th percentile of positive values.

These are deliberately approximate models. They do not model instrument-specific acoustic balance, microphone placement, real decay, or a musician's exact articulation. Unmapped wedges are counted by the profile builder. The application wrapper discarded those preparation diagnostics. The standalone wrapper included here preserves them as `profile_diagnostics`.

### 6.4 Recording loudness and attacks

`audio_profile()` uses:

- RMS: `librosa.feature.rms`, frame length 1024, hop 220 samples.
- Attack strength: `librosa.onset.onset_strength`, hop 220, FFT length 1024.
- Interpolation onto the common 50 Hz frame clock.
- Loudness scaling via `scale_envelope(rms × 100)` and attack scaling via `attack_envelope`.

At 22,050 Hz, the RMS analysis window is roughly 46 ms and hop roughly 10 ms. This differs from the final 20 ms feature spacing. Preserve the centering/default conventions if reproducing the pipeline.

The recording `rest` array is initially false everywhere. It is **not** a learned silence segmentation. The rest cue asks whether the recording is quiet at a location where the score predicts an ensemble rest.

### 6.5 Structural-change profile

Feature preparation in `run_original_search()` downsamples to 5 Hz and computes `_novelty()`:

- Normalize chroma columns.
- Apply signed Gaussian checkerboard-style filters at two context scales, 2 and 8 seconds.
- Sum squared filtered pitch-class responses and normalize each by a robust high percentile.
- Add the magnitude of change in a one-second-smoothed loudness contour, also robustly normalized.
- Average the two pitch novelty channels and energy-change channel; clip to 0–1.

Interpolate this novelty profile back onto the 50 Hz grid. Its first/last eight seconds are marked invalid because full structural context is unavailable there.

This supplies a “something changes around here” feature. It does not label musical form or recognize named themes.

## 7. Compute the pairwise mismatch cost

`joint_cost(score, audio, use_structure=True)` considers a score frame `i` paired with a recording frame `j`. Each cue has a cost, an availability mask, and a weight.

| Cue | Cost | Availability | Weight |
|---|---|---|---:|
| Harmony | Clipped `1 − cosine_similarity(chroma_i, chroma_j)` | Nonzero pitched score frame, not an expected rest | 0.55 |
| Dynamics | Absolute difference of normalized levels | Both level profiles have local standard deviation >0.035 in a roughly four-second neighborhood; score is not resting | 0.15 |
| Attack | Absolute difference after approximately ±40 ms maximum filtering | Either side's attack exceeds 0.12 | 0.25 |
| Rest | `clip(recording_level / 0.2, 0, 1)` | Score-confirmed rest, with approximately 80 ms release allowance; disabled for an entirely silent score slice | 0.15 |
| Structure | Absolute novelty difference | Either novelty >0.15 and both structural-context masks valid | 0.10 |

For available cues `k`, the combined cost is:

```text
C(i,j) = sum(weight_k × cost_k(i,j)) / sum(weight_k)
```

If no cue is available, it returns **0.5**, not zero. The listed weights need not sum to one because the denominator is recomputed for each pairing.

A missing channel does not earn a perfect match. An unexpected attack in the recording can contribute a mismatch even without a score attack. Pitched score material paired with absent audio pitch energy also does not become “unavailable”; it receives poor harmonic agreement.

The function limits a single pairwise matrix to 8,000,000 cells. Full coarse search may therefore reject a long pair even though the outer audio-duration guard accepts it. Fine refinement avoids building a full 50 Hz score-by-recording matrix.

## 8. Find the original broad match

`original_coarse()` restricts score features to the supported extent and downsamples both sides to **2 Hz**. Downsampling averages chroma/level, retains attack maxima, and marks a coarse rest only if more than 95% of its source window is resting.

The full matrix has one row per coarse score frame and one column per coarse recording frame. There is no Sync Toolbox baseline corridor imposed on this Structure Search seed.

`_solve_cost()` calls:

```python
D, steps = librosa.sequence.dtw(
    C=cost,
    subseq=True,
    backtrack=False,
    return_steps=True,
    step_sizes_sigma=np.array([[1, 1], [1, 2], [2, 1]], dtype=np.uint32),
    weights_mul=np.array([1., 1., 2.]),
)
```

Rows advance in score time; columns advance in recording time. Allowed steps express coarse local recording/score timing ratios of 1, 2, and 0.5. No backward motion or zero-score-advance hold step is present. A subsequence can begin and end inside the recording, accommodating an introduction or trailing audio.

The multiplicative weights charge for the number of score frames advanced. This prevents the two-score-frame step from receiving an artificial cost discount. Endpoints are ranked by the accumulated cost divided by the number of score rows, not by the mean of a differing number of visited cells.

The solver considers endpoint minima, recovers paths, and retains up to three nonoverlapping occurrences from at most 100 candidates. The next-best difference is an ambiguity diagnostic, not a probability. Whole-piece searches may have no distinct alternative; absence of an alternative is not evidence of certainty.

`_mapping()` divides frame coordinates by the feature rate and groups duplicate score times by their mean recording time. If downsampling leaves a short final score interval, `original_coarse()` extends it with the last path slope only when the implied endpoint fits within the recording.

This stage is sequence matching. A locally similar chord cannot be selected freely if it would violate the ordered path through the piece.

## 9. Jointly fit acoustic agreement and tempo

### 9.1 Musical knots

`optimize_mapping()` creates a knot grid containing:

- Score coverage start/end.
- Positions every **0.25 shared quarter notes**, a sixteenth-note subdivision in the normalized clock.
- Every written tempo boundary.
- Fermata/ensemble-gap protection boundaries.
- Explicit pause-event boundaries if supplied.
- Seed-mapping positions at least 0.02 quarter notes away from existing mandatory knots.

It rounds/deduplicates this grid, converts it to nominal score seconds, and initializes recording knot positions by interpolation of the broad map. It records the error introduced by this reparameterization.

Let score knots be `s_k`, recording knot variables `t_k`, and nominal interval durations `d_k = s_(k+1) − s_k`. Between two knots the estimated recording clock is piecewise linear. These knots are timing degrees of freedom, not automatically detected note onsets.

### 9.2 Protection intervals

`protected_intervals()` identifies fermatas and gaps in the union of sounding score intervals. Only those protection intervals are needed here.

Continuity weights are normally 1. Adjacent timing intervals touching a protected interval receive weight 0.25. This relaxes the tempo preference without fixing the duration or verifying the rest acoustically.

The helper derives gaps from written sounding intervals; it is distinct from the staccato-aware feature rest mask. It does not append an arbitrary trailing silence beyond the last sounding event. Protection in any part can be broader than a confirmed whole-ensemble pause when a fermata is present.

### 9.3 Acoustic corridor

For each 50 Hz score sample, take its seed recording time and build candidates from approximately **four seconds earlier to four seconds later**. At 50 Hz, each cost row has 401 recording positions.

Rows are built in batches of 64, with around two seconds of extra context for cue availability calculations. Unsupported audio locations get a cost of 2. The corridor origin is floored to the recording feature grid. This produces a compact `samples × 401` field rather than a full fine-resolution matrix.

The corridor stays attached to the original seed during both optimization stages. If the correct occurrence lies outside it, this refinement cannot recover it merely by becoming smoother.

### 9.4 Active mathematical objective

The active solver optimizes **absolute recording times at knots**. For an audio-cost sample inside interval `k`, it evaluates the cost at the linearly interpolated recording time. Within a cost row, the objective uses a cubic Hermite interpolation with neighbor-derived slopes. Costs below a small positive floor are clipped before taking square-root residuals.

For this selected version there are no explicit pause variables. Its local recording-to-nominal rate is:

```text
r_k = (t_(k+1) − t_k) / d_k
```

Tempo continuity penalizes differences in `log(r_k)`, not differences in raw duration. Consequently, a written tempo change already represented in `d_k` need not be flattened into equal-length recording intervals.

The squared-residual objective contains:

1. **Acoustic cost:** approximately the mean interpolated joint mismatch across all score samples.
2. **Continuity:**
   `lambda × sum(w_k × (log(r_(k+1)) − log(r_k))² / h_k) / sum(h_k)`
   where `lambda=0.25`, `w_k` is the protection weight, and `h_k` is the mean musical spacing of the two adjacent knot intervals.
3. **Corridor barrier:** `4 × mean(outside_distance_seconds²)`.
4. **Monotonicity barrier:** summed squared normalized deficits when moving durations fall below 5% of nominal durations, scaled by 1000.
5. **Weak endpoint trust:** `0.0001 × [(t_0 − initial_0)² + (t_last − initial_last)²]`.
6. **Optional pause prior:** present only when pause variables are supplied, discussed below.

Dividing continuity terms by physical musical spacing matters: adding extra knots should not silently turn into a different smoothing strength just because the parameterization is denser.

The sparse Jacobian uses two neighboring knot columns for each acoustic sample and three for each ordinary continuity term. `_direct_residual_jac()` returns a CSR sparse matrix assembled from local contributions.

### 9.5 Solver and stages

Each stage calls SciPy `least_squares` with:

```text
method='trf'
tr_solver='lsmr'
x_scale='jac'
max_nfev=1200
ftol=1e-8, xtol=1e-8, gtol=1e-7
LSMR: atol=1e-8, btol=1e-8, maxiter=300
```

Each knot has a box bound within ±4 seconds of its current stage initialization, with recording time bounded below by zero. These box bounds and the fixed acoustic corridor are different constraints. Stage two bounds are recentered on the stage-one result, but its acoustic rows are still centered on the original seed.

The solver first uses the cost field Gaussian-smoothed along recording time with sigma **0.10 seconds**, then **0.04 seconds**. These filters smooth the **matching cost landscape**, not the final timing curve. Both stages still jointly optimize acoustic and continuity terms.

This is a local optimizer. It is not a globally optimal generalized-DTW implementation and does not guarantee the correct musical occurrence.

### 9.6 Validation and fallback

A stage is accepted only if moving durations and recording increments are positive, its objective does not increase beyond tolerance, and maximum acoustic-band excess is below 0.02 seconds. Otherwise its timing output falls back to the stage's initial times.

After the stages, the code evaluates raw, unsmoothed acoustic cost using linear interpolation. If the candidate exceeds the original seed's raw acoustic mean by more than **0.02**, it resets to the reparameterized initial timing. An endpoint exceeding the recording's feature extent causes return of the original mapping.

Final mapping samples are the union of original seed positions and knot score times, with near-duplicates removed. Recording time is interpolated through accepted knots.

**Convergence and acceptance are different:** the code can accept an improved, valid candidate even if the optimizer reports a limit rather than convergence. Always preserve both flags. The overall diagnostic also records stage details and maximum displacement.

### 9.7 Pause capability in the included solver

The selected method calls the solver with no explicit pause events. It relaxes continuity around score-derived fermatas and ensemble gaps, but does not allocate separate hold-duration variables during this run.

The same direct solver includes optional pause-event handling: it can subtract additional hold time before regularizing moving tempo, spread an event over overlapping intervals, cap its initial allocation at 85% of an interval, and apply a weak prior of 0.02. This shared solver capability is retained for completeness and future integration, not exposed as a second alignment version. Exact pause onset is not established by this mechanism. The supplied entry point always passes an empty pause-event list.

## 10. Packaging, cache behavior, and reproduction

### 10.1 Standalone reproduction

Save Appendix A as `integrated_original.py` in an empty directory. Install the dependencies in Appendix B in a Python 3.12 environment. Supply a MusicXML score and its corresponding recording. No original repository, cached research results, alternate algorithms, or soundfonts are needed.

```python
from pathlib import Path
from integrated_original import run_original_search

score = Path('/absolute/path/to/score.mxl')
audio = Path('/absolute/path/to/recording.mp3')
result = run_original_search(
    score.read_bytes(), audio.read_bytes(), suffix=score.suffix,
    expand=True, progress=print,
)
result['mapping'].to_csv('mapping.csv', index=False)
```

The included command-line entry point is:

```text
python integrated_original.py score.mxl recording.mp3 --output alignment-output
```

It writes mapping and measure tables plus optimizer and evaluation JSON. It runs only **Integrated tempo from original search**. It does not load or generate competing versions.

### 10.2 What was adapted for this document

The single-method wrapper extracts the required pitch features directly instead of running a baseline alignment to obtain them. It builds the same expressive and structural features, audits coverage, preserves the supported-end floor convention, computes the original broad seed, and calls the same direct joint optimizer with the same constants and no explicit holds.

The protection helper preserves the fermata/ensemble-gap logic while omitting unused run detection. The core numerical functions are extracted from the active implementation, with project-local imports resolved within the one included module. Dormant score-rendering branches and the unused optimizer were removed.

The standalone output intentionally omits historical inherited review-marker lists and cross-version comparisons. Its optional audit measures displacement against its own broad seed. Historical application diagnostics can use a different comparison baseline; do not conflate those values.

No full-recording numerical-equivalence claim is made for this packaging change. The selected cached result in Section 13 remains the historical application result. Appendix C records the standalone checks actually performed.

### 10.3 Cache and provenance considerations

The standalone entry point does not cache. A future application can cache decoded features, coarse matching, and refinement separately, but every relevant input must participate in cache identity: score/audio hashes, repeat choice, supported extent, feature configuration, initial mapping, protection intervals, solver settings, and any future user anchors.

Keep environment versions and implementation revision with exported results. Do not overwrite older results when changing parameters. Explicit tables and JSON metadata are preferable to loading untrusted serialized Python objects.

### 10.4 Environment

Appendix B pins the direct dependencies used by this standalone code. Python package installers resolve their transitive dependencies. This is a focused dependency list, not a complete cross-platform lockfile or a guarantee that every operating system has the required audio codecs. The pipeline was checked in the existing Python 3.12 environment.

## 11. How the follower uses the result

The recording supplies playback time. The follower interpolates the mapping in the opposite direction to locate score time, then converts that position into notation geometry. Integrated variants enable continuous cursor behavior. This display interpolation does not improve alignment estimates.

Similarly, a graph click or a seek operation only changes what the user is viewing. It does not change the mapping, re-run matching, or confirm a score/audio correspondence.

A note's predicted start and end can be obtained by applying the map to its score start and end. A beat duration is the difference of mapped beat boundaries. A measure boundary may be plausible while interior beats are poorly placed, which is why those quantities must be inspected separately.

## 12. Diagnostics already available

### 12.1 Acoustic evidence

`evaluate_evidence()` samples the mapping, evaluates the unchanged `joint_cost(..., details=True)`, and aggregates per-cue mismatch and availability. The default sampling is every 0.1 seconds; a denser diagnostic sampling can use 0.02 seconds.

It currently returns whole-mapping summaries, not a calibrated confidence per measure. The underlying cue cost/validity arrays are the useful primitive for more local reporting. Preserve the local context used to calculate masks; evaluating a measure in isolation with no surrounding frames can change cue availability artificially.

### 12.2 Beat and subdivision auditing

`audit_methods()` evaluates grids of 1, 0.5, 0.25, 0.125, and one-third quarter notes. It reports mapped durations and ratios of adjacent **recording/nominal duration rates**, separately classifying protected intervals and written tempo boundaries. It also probes across barlines, where within-measure summaries can hide seams.

The comparison page's newer **Beat lengths** view is simpler: it plots complete shared quarter-note intervals, omits partial pickup fragments, includes rests, and displays raw adjacent-duration changes in milliseconds for the selected range. Changing From/To measure recomputes those statistics; graphical drag zoom changes only the viewport.

These are different diagnostics. A millisecond difference, a normalized adjacent-rate ratio, and a pitch mismatch have different units and cannot be treated interchangeably.

### 12.3 Displacement and stability

The broad and final mappings expose how much joint refinement moved each score position. The standalone audit compares against this exact broad seed. A displacement is a change from an estimate, not an error against truth.

For future stability reporting, the same algorithm could be evaluated with controlled changes to parameters or initialization. Such reruns are not included as alternate solution versions here. Agreement would indicate model stability, not independent accuracy.

### 12.4 Review markers versus the algorithm

The application can display provisional review points for this method. They do not constrain its broad search or optimizer. The saved historical result includes inherited review locations, plus unusually variable beat positions, moved locations, and the opening.

The standalone code omits the inherited UI marker list rather than importing another pipeline to recreate it. It returns detailed beat intervals, displacement summaries, feature agreement, and optimizer status that an application can use for review displays. Its automatic `accepted_anchors` count remains zero.

A review display is optional output. It must not be confused with a user-confirmed alignment constraint.

### 12.5 Independent annotations

`audit_methods(..., annotations=...)` already accepts score/audio correspondences for **evaluation**, including optional timestamp uncertainty. It computes absolute error and uncertainty-adjusted error.

That existing evaluation hook is not a manual-anchor solver. Passing an annotation there measures disagreement; it does not force the alignment through it.

## 13. Verified example from the current saved run

Inputs are the supplied Tchaikovsky Symphony No. 6, first-movement MusicXML and Hallé recording. This section reads existing saved diagnostics; it is not a newly executed alignment.

| Item | Saved value |
|---|---:|
| Supported playback measures | 354 |
| Nominal score coverage | 0.000 to 962.760 s |
| Mapped recording coverage | 8.544325 to 1072.222107 s |
| Timing knots | 6,967 |
| Acoustic samples | 48,139 |
| Protection intervals | 39 |
| Protected knot intervals | 266 |
| Explicit pause events | 0 |
| Review markers after augmentation/deduplication | 171 |
| Accepted fixed alignment anchors | 0 |
| Stage evaluations, coarse/fine cost scales | 835 / 126 |
| Both stages converged and accepted | Yes |
| Raw acoustic mismatch, seed → candidate | 0.310813 → 0.284146 |
| Maximum movement from broad seed | 1.593928 s |
| Seed reparameterization displacement | 0.024890 s |

These values document the computation, not a claim of subsecond note accuracy. In particular, the opening remains a location to validate against the recording.

Current integrated fingerprint:

```text
eb585a90d167f1dcaf41b5edf4d38d91b7100f617c549bcf125188947027ad4d
```

Saved bundle:

```text
results/2b012530f735659296b60f0771b1c75f526bcbee7a4e6e565e37c3e1bf2cdbcf-integrated.pkl
```

## 14. Extension guidance: confidence for each measure

**This section describes what future developers should investigate, not an existing confidence implementation or a prescribed scoring formula.**

A useful confidence display should distinguish at least:

- Is the measure's overall location plausible?
- Is its exact start boundary supported?
- Are beats inside it well localized?
- Did the joint optimizer move it substantially?
- Are there competing plausible occurrences?
- Is the evidence absent, contradictory, or simply weak?

One number can hide these differences. A smooth internal beat sequence can still be shifted, and a correctly placed phrase can contain genuinely uneven performance timing.

### Existing tools to examine

| Concern | Existing source of information | Interpretation to retain |
|---|---|---|
| Pitch/loudness/attack/rest disagreement | `joint_cost(details=True)`, `evaluate_evidence()` | Low mismatch is model agreement, not independent correctness; unavailable cues must remain unavailable |
| Coarse occurrence ambiguity | `_solve_cost()` alternatives | Alternative-search scope matters; no returned alternative does not imply certainty |
| Local positional ambiguity | Feature variation and costs near the final path | Sustained chords or silence may be compatible with many timestamps |
| Excessive correction | Seed/final mappings, stage displacement diagnostics | Compare to the exact broad seed when attributing movement to refinement |
| Uneven timing or barline seams | `audit_methods()` interval rows and `barline_seams` | Keep intentional tempo changes and protected pauses distinguishable |
| Sensitivity to assumptions | Controlled reruns of this same method with explicit parameter changes | Stability is reassuring but not independent accuracy evidence |
| Solver validity | `accepted`, `converged`, iteration counts, band excess, fallback flags | A fallback is not an optimized high-confidence result |
| Actual timing error | Independent annotations accepted by `audit_methods()` | Requires human/reference correspondences not used to fit the tested estimate |

For a measure that seems “over-smoothed,” inspect whether regularity improved while local acoustic agreement worsened, whether attacks/rests contradict the new placement, and whether the result approached a corridor limit. Current whole-piece means can conceal a short problematic span. Local reporting is a sensible extension, but needs deliberate aggregation and context handling.

The solver does not currently store per-measure acoustic-versus-continuity contributions, uncertainty intervals, or a per-measure estimate of how much of the correction was caused by regularization. Those would require additional instrumentation or controlled comparisons, not relabeling an existing global diagnostic.

A percentage called confidence should eventually be checked against independent timing annotations with a defined tolerance and coverage policy. Until then, “needs review,” “weak evidence,” or an explicitly labeled heuristic score is more honest than “95% correct.”

## 15. Extension guidance: user-confirmed manual alignment anchors

A future manual correction would assert:

> This specific occurrence and beat position in the score corresponds to this timestamp in the recording.

That is a constraint on `T(s)`, not a review flag. The current method has no supported API that enforces such a correspondence, and its automatic marker table should not be repurposed silently to pretend otherwise.

### Where existing components are relevant

**Score position and identity.** `parsed['measures']`, the shared quarter-note clock, and `score_clock()`/`seconds_at()` provide the conversion from a chosen score position into the optimizer's coordinates. Repeat occurrence and within-measure position matter; printed measure labels alone can be ambiguous.

**Broad search.** `original_coarse()` and `_solve_cost()` determine the initial occurrence and path. A user correction far outside the existing ±4-second acoustic corridor indicates that broad matching or search support needs reconsideration. Refining the old neighborhood cannot honor a distant correction reliably.

**Joint timing fit.** `optimize_mapping()` constructs the musical knot grid and cost corridor. `optimize_cost_times_direct()` controls the actual knot-time variables. These are the central places to investigate for incorporating fixed or uncertainty-aware user correspondences while retaining acoustic evidence and musical continuity. Current weak endpoint priors and per-knot box bounds do not implement user anchors.

**Refitting around a correction.** The existing cost slicing and sparse local residual structure are useful building blocks if an application later reprocesses only a neighborhood or the interval between confirmed anchors. The current solver nevertheless fits the whole supplied mapping at once. Preserving continuity at the boundary of a partial rerun, and ensuring earlier confirmed positions remain satisfied, would require deliberate changes and tests.

**Validation.** `audit_methods()` can measure the residual at user-specified correspondences and compare surrounding beat lengths. An anchor used for fitting must be distinguished from a held-out annotation used to evaluate generalization. Reproducing a fitted anchor exactly is a constraint check, not evidence that all intervening notes are correct.

**Storage and caching.** The project already retains input hashes, versions, mappings, and provenance-like diagnostics. Future manual corrections need their own identity and revision history and must participate in the relevant cache keys. Otherwise the app could display an old result after the user supplied a correction.

**Follower interaction.** The score follower already translates between audio, score time, and notation positions. It is a useful UI foundation for choosing a correspondence. Saving and enforcing that correspondence is additional functionality beyond its present click-to-seek behavior.

### Decisions a future implementation must make explicitly

- Is the user giving an exact anchor or an approximate timestamp with uncertainty?
- Does the score position mean attack onset, notated beat, arrival before a fermata, or release afterward?
- Are multiple anchors consistent with score order and recording order?
- Does the recording contain cuts, repeats, or reordered passages that the current monotone model cannot represent?
- Which regions should be recomputed, and what happens when the user edits or removes an earlier anchor?
- How are unsupported or contradictory corrections explained instead of silently ignored?

These are design considerations, not a requirement to choose one anchoring algorithm now. The key requirement is that a future manual anchor genuinely influence or constrain matching, rather than merely being drawn over an unchanged mapping.

## 16. Improvement opportunities and limitations

### Better local evidence reporting

The existing per-cue cost masks are richer than the current whole-piece summaries. Local visibility into cue availability, mismatch, ambiguity, and movement would make failures easier to interpret. Store unavailable values distinctly from successful matches.

### More faithful expressive profiles

Score dynamics and articulation are heuristic. Instrument balance, sustaining behavior, room decay, accents, unpitched sounds, and imported wedges can all differ from the predicted profile. Inspect `score_envelope()` and its preparation diagnostics before adding a more complicated confidence model on top of them.

### Better pause representation

This selected version currently relaxes continuity around protected intervals but does not receive explicit hold events. The existing pause-capable direct solver is a starting point for investigation; an appropriate source of pause evidence would still be needed. They are not already a complete model of arbitrary breaths, fermata release, or silence timing.

### Recovering from wrong global occurrences

The broad stage has limited tempo steps and the fine stage has local support. Repeated passages, cuts, long deviations, or wrong repeat policy can defeat this model. More confident-looking smoothing cannot fix an incorrect structural hypothesis. Broad alternatives, user anchors, and explicit handling of score traversal are relevant directions.

### Distinguishing accuracy from regularity

The current smoothness comparisons demonstrate timing regularity, not verified musical placement. Build evaluation around known score/audio correspondences and preserve held-out passages. Compare attack-rich runs, sustained textures, quiet openings, rests, fermatas, transitions, and repeated passages separately.

### Standalone packaging and parameter exposure

The included entry point already isolates the chosen algorithm. Expose meaningful configuration with stable versioned schemas rather than requiring developers to edit numeric literals. Relevant parameters include cue weights, feature rate, coarse search rate/steps, corridor radius, cost-smoothing scales, continuity strength, protection weighting, and acceptance tolerances. These interact; changing one should produce a new experiment with comparable diagnostics, not overwrite historical results.

### Numerical and provenance improvements

Preserve candidate-versus-returned-map distinctions after fallback, provide clearer per-stage status, instrument local objective contributions, and include all relevant configuration/source/environment dependencies in cache identity. Audit behavior at missing feature coverage, tiny knot intervals, and audio endpoints when modifying the solver.

## 17. Verification checklist for a reimplementation

Representative executable tests of the selected scoring and direct optimizer are included in Appendix C. They can be read and recreated directly from this document; no access to the original project is required.

For equivalent behavior, verify:

1. Musical positions convert consistently across parts, tempo marks, repeat occurrences, and the supported mixed-meter normalization.
2. Symbolic and audio features use the same time origin and frame conventions.
3. Cue availability masks behave correctly for silence, sustained notes, unexpected attacks, and structural edges.
4. DTW ranking and alternative margins use the same score-normalized objective, including the score-advance step weighting.
5. The active direct solver's analytic Jacobian agrees with finite differences on representative interior cases.
6. Accepted maps remain monotone and covered; invalid candidates do not leak through fallback paths.
7. Ordinary timing can become steadier without flattening written tempo structure or hiding pauses in diagnostics.
8. Refinement movement is measured against the correct seed, not accidentally against a different historical method.
9. Graphs, exports, and the follower use the same result and preserve unavailable coverage.
10. Any future manual anchors are tested as enforced input correspondences, separately from review-marker display and held-out evaluation annotations.

This guide describes an experimental but inspectable matching system. Its most useful property is that acoustic evidence, timing continuity, diagnostic transparency, and human review can be developed together without pretending that smooth playback alone establishes correct alignment.



## Appendix A. Single-method standalone implementation

Save the following complete block as `integrated_original.py`. Every project-specific function it needs is in this block. The only external code dependencies are the third-party libraries listed in Appendix B. The entry point runs exactly one alignment method. Shared optional pause handling is retained inside the direct optimizer, but the entry point supplies no pause events.

```python
"""Standalone extraction of Integrated tempo from original search.
The matching cost and direct joint optimizer retain the project's active logic.
The wrapper only orchestrates this method; no other alignment modes are run.
"""
from __future__ import annotations
import io, json, csv, time, tempfile, zipfile
from pathlib import Path
from fractions import Fraction as F
import xml.etree.ElementTree as ET
import numpy as np
import pandas as pd
from music21 import converter, note, chord, tempo, stream
from scipy.ndimage import uniform_filter1d, maximum_filter1d, convolve1d, gaussian_filter1d
from scipy.signal import find_peaks
TIMING_VERSION='shared-beat-clock-v2'
VERSION='integrated-original-standalone-v1'
STEPS=np.array([[1,1],[1,2],[2,1]],dtype=np.uint32)
STEP_WEIGHTS=STEPS[:,0].astype(float)
MAX_CELLS=8_000_000
TYPES = {'maxima': 32, 'long': 16, 'breve': 8, 'whole': 4, 'half': 2, 'quarter': 1, 'eighth': F(1, 2), '16th': F(1, 4), '32nd': F(1, 8), '64th': F(1, 16), '128th': F(1, 32), '256th': F(1, 64)}

def xml_root(data, suffix):
    if suffix.lower() == '.mxl':
        with zipfile.ZipFile(io.BytesIO(data)) as z:
            container = ET.fromstring(z.read('META-INF/container.xml'))
            name = next((e.attrib['full-path'] for e in container.iter() if e.tag.split('}')[-1] == 'rootfile'))
            data = z.read(name)
    return ET.fromstring(data)

def written_duration(n):
    if n.find('grace') is not None:
        return F(0)
    if n.find('rest') is not None and n.findtext('type') is None:
        return F(4)
    typ = n.findtext('type')
    if typ not in TYPES:
        raise ValueError(f'Cannot reconstruct mixed-meter note type {typ}')
    q = F(TYPES[typ]) * (2 - F(1, 2) ** len(n.findall('dot')))
    tm = n.find('time-modification')
    if tm is not None:
        q *= F(tm.findtext('normal-notes')) / F(tm.findtext('actual-notes'))
    return q

def normalized_xml(data, suffix, display=False):
    root = xml_root(data, suffix)
    parts = root.findall('part')
    measures = [p.findall('measure') for p in parts]
    if not parts:
        raise ValueError('Expected a partwise MusicXML score')
    meters = []
    for ms in measures:
        state = ('4', '4')
        seq = []
        for m in ms:
            t = m.find('attributes/time')
            if t is not None:
                state = (t.findtext('beats'), t.findtext('beat-type'))
            seq.append(state)
        meters.append(seq)
    repairs = []
    for i in range(min(map(len, measures))):
        signatures = {seq[i] for seq in meters}
        if signatures != {('4', '4'), ('12', '8')}:
            continue
        labels = {ms[i].get('number') for ms in measures}
        if len(labels) != 1:
            raise ValueError('Mixed-meter part measure labels disagree')
        for (pi, ms) in enumerate(measures):
            m = ms[i]
            div = next((int(a.findtext('divisions')) for old in reversed(ms[:i + 1]) for a in reversed(old.findall('attributes')) if a.find('divisions') is not None), 1)
            groups = {}
            for n in m.findall('note'):
                groups.setdefault((n.findtext('staff', '1'), n.findtext('voice', '1')), []).append(n)
            factors = {}
            for (voice, ns) in groups.items():
                total = sum((written_duration(n) for n in ns if n.find('chord') is None), F(0))
                if total not in (4, 6):
                    raise ValueError(f"Mixed-meter measure {m.get('number')}, part {pi + 1}, voice {voice}: written duration {total} is ambiguous")
                factors[voice] = F(4, total)
            cursor = F(0)
            seen = set()
            changes = 0
            for e in m:
                if e.tag == 'backup':
                    old = F(e.findtext('duration')) / div
                    if old not in (4, 6) or cursor != 4:
                        raise ValueError(f"Unsupported partial-voice backup in mixed-meter measure {m.get('number')}")
                    e.find('duration').text = str(4 * div)
                    cursor = F(0)
                elif e.tag == 'forward':
                    raise ValueError('Mixed-meter forward gaps require explicit review')
                elif e.tag == 'direction' and e.find('offset') is not None and (F(e.findtext('offset')) != 0):
                    if set(factors.values()) != {F(1)}:
                        raise ValueError('Mixed-meter direction offsets require explicit review')
                elif e.tag == 'note' and e.find('grace') is None:
                    voice = (e.findtext('staff', '1'), e.findtext('voice', '1'))
                    factor = factors[voice]
                    q = written_duration(e) * factor
                    ticks = q * div
                    if ticks.denominator != 1:
                        raise ValueError('MusicXML divisions cannot represent shared beat exactly')
                    duration = e.find('duration')
                    if duration is None:
                        raise ValueError('Mixed-meter note has no duration')
                    changes += duration.text != str(int(ticks))
                    duration.text = str(int(ticks))
                    if factor != 1:
                        tm = e.find('time-modification')
                        if tm is None:
                            tm = ET.SubElement(e, 'time-modification')
                            ET.SubElement(tm, 'actual-notes').text = '3'
                            ET.SubElement(tm, 'normal-notes').text = '2'
                        else:
                            ratio = F(int(tm.findtext('actual-notes')), int(tm.findtext('normal-notes'))) / factor
                            tm.find('actual-notes').text = str(ratio.numerator)
                            tm.find('normal-notes').text = str(ratio.denominator)
                    if e.find('chord') is None:
                        if voice not in seen and cursor != 0:
                            raise ValueError('Mixed-meter voice does not start at barline')
                        seen.add(voice)
                        cursor += q
            if not display:
                for t in m.findall('attributes/time'):
                    if t.findtext('beats') == '12' and t.findtext('beat-type') == '8':
                        t.find('beats').text = '4'
                        t.find('beat-type').text = '4'
            if changes or any((f != 1 for f in factors.values())) or meters[pi][i] == ('12', '8'):
                repairs.append({'measure': m.get('number'), 'part': parts[pi].get('id'), 'compound_voices': [list(k) for (k, v) in factors.items() if v != 1], 'changed_durations': changes})
    return (ET.tostring(root, encoding='utf-8'), repairs)

def load_score(data, suffix, expand=True):
    from music21 import converter, stream
    (xml, repairs) = normalized_xml(data, suffix)
    with tempfile.TemporaryDirectory() as d:
        path = Path(d) / 'score.musicxml'
        path.write_bytes(xml)
        score = converter.parse(str(path), forceSource=True)
    if not isinstance(score, stream.Score) or not score.parts:
        raise ValueError('The file must contain a score with parts')
    if expand:
        score = score.expandRepeats()
    return (score, repairs)

def parse_score(data: bytes, suffix: str='.musicxml', expand: bool=True):
    if suffix.lower() not in {'.xml', '.musicxml', '.mxl'}:
        raise ValueError('Use MusicXML (.xml, .musicxml, or .mxl).')
    (score, timing_repairs) = load_score(data, suffix, expand)
    warnings = []
    if timing_repairs:
        labels = list(dict.fromkeys((r['measure'] for r in timing_repairs)))
        warnings.append(f"Shared beat timing normalized in measures {', '.join(labels)}: compound voices use three eighth notes per common beat. Original file unchanged.")
    score = score.toSoundingPitch(inPlace=False)
    marks = {}
    for el in score.recurse().getElementsByClass(tempo.MetronomeMark):
        bpm = el.getQuarterBPM()
        if bpm and bpm > 0:
            offset = float(el.getOffsetInHierarchy(score))
            if offset in marks and abs(marks[offset] - bpm) > 0.01:
                raise ValueError('Conflicting tempo marks across parts at the same position.')
            marks[offset] = float(bpm)
    if 0.0 not in marks:
        marks[0.0] = 120.0
        warnings.append('No starting metronome mark: using 120 quarter notes/minute as the nominal score clock.')
    points = sorted(marks.items())

    def seconds(q):
        total = 0.0
        for (i, (start, bpm)) in enumerate(points):
            if q <= start:
                break
            end = points[i + 1][0] if i + 1 < len(points) else q
            total += max(0, min(q, end) - start) * 60 / bpm
        return total
    measures = []
    for (i, m) in enumerate(score.parts[0].getElementsByClass(stream.Measure)):
        q = float(m.offset)
        measures.append({'measure': i + 1, 'printed_label': str(m.number) + (m.numberSuffix or ''), 'score_sec': seconds(q), 'quarter': q})
    if not measures:
        raise ValueError('No measures found.')
    joined = score.stripTies(inPlace=False)
    rows = []
    skipped = 0
    for (i, part) in enumerate(joined.parts):
        name = part.partName or f'Part {i + 1}'
        for el in part.recurse().notes:
            if isinstance(el, note.Unpitched):
                skipped += 1
                continue
            pitches = el.pitches if isinstance(el, chord.Chord) else [el.pitch]
            q = float(el.getOffsetInHierarchy(joined))
            end = seconds(q + float(el.quarterLength))
            start = seconds(q)
            if end <= start:
                continue
            for p in pitches:
                if p.midi < 21 or p.midi > 108:
                    skipped += 1
                    continue
                rows.append({'start': start, 'duration': end - start, 'pitch': int(p.midi), 'velocity': 80, 'instrument': name, 'part': name, 'note': p.nameWithOctave})
    if not rows:
        raise ValueError('No pitched notes in the supported A0–C8 range.')
    if skipped:
        warnings.append(f'Excluded {skipped} unpitched or out-of-range events from alignment.')
    warnings.append('Pitch features use equal note velocity; expressive dynamics are supplied by a separate profile.')
    chords = []
    for c in score.chordify().flatten().getElementsByClass(chord.Chord):
        chords.append({'score_sec': seconds(float(c.offset)), 'duration': seconds(float(c.offset + c.quarterLength)) - seconds(float(c.offset)), 'pitches': ' '.join((p.nameWithOctave for p in c.pitches)), 'chord': c.pitchedCommonName})
    return {'notes': pd.DataFrame(rows), 'measures': pd.DataFrame(measures), 'chords': pd.DataFrame(chords), 'duration': seconds(float(score.highestTime)), 'warnings': warnings, 'timing_version': TIMING_VERSION, 'timing_repairs': timing_repairs, 'tempo_map': [{'quarter': q, 'score_sec': seconds(q), 'bpm': bpm} for (q, bpm) in points]}

def scale_envelope(x):
    x = np.log1p(np.maximum(x, 0))
    (lo, hi) = np.percentile(x, [5, 95])
    return np.clip((x - lo) / max(hi - lo, 1e-08), 0, 1)

def attack_envelope(x):
    x = np.log1p(np.maximum(x, 0))
    positive = x[x > 0]
    return np.clip(x / max(float(np.percentile(positive, 95)) if len(positive) else 0, 1e-08), 0, 1)

def score_envelope(parsed, score_bytes, suffix, expand, rate=50, detailed=False, limit_seconds=None):
    from music21 import dynamics, stream, articulations
    (score, _) = load_score(score_bytes, suffix, expand)

    def seconds(q):
        t = next((t for t in reversed(parsed['tempo_map']) if t['quarter'] <= q))
        return t['score_sec'] + (q - t['quarter']) * 60 / t['bpm']
    profile_duration = parsed['duration'] if limit_seconds is None else min(parsed['duration'], float(limit_seconds))
    times = np.arange(int(np.ceil(profile_duration * rate)) + 1) / rate
    envelope = np.zeros(len(times))
    attacks = np.zeros(len(times))
    sounding = np.zeros(len(times))
    accented = []
    markings = 0
    wedges = 0
    skipped_wedges = 0
    for (i, part) in enumerate(score.parts):
        name = part.partName or f'Part {i + 1}'
        events = sorted(((seconds(float(d.getOffsetInHierarchy(score))), float(d.volumeScalar)) for d in part.recurse().getElementsByClass(dynamics.Dynamic)))
        markings += len(events)
        strength = np.full(len(times), 0.5)
        for (t, v) in events:
            strength[times >= t] = v
        for w in part.recurse().getElementsByClass(dynamics.DynamicWedge):
            elements = w.getSpannedElements()
            if len(elements) < 2:
                continue
            try:
                a = seconds(float(elements[0].getOffsetInHierarchy(score)))
                b = seconds(float(elements[-1].getOffsetInHierarchy(score)))
            except Exception:
                try:
                    (first, last) = (elements[0], elements[-1])
                    fm = first.getContextByClass(stream.Measure)
                    lm = last.getContextByClass(stream.Measure)
                    starts = [m for m in part.getElementsByClass(stream.Measure) if m.number == fm.number and m.numberSuffix == fm.numberSuffix]
                    ends = [m for m in part.getElementsByClass(stream.Measure) if m.number == lm.number and m.numberSuffix == lm.numberSuffix]
                    if len(starts) != 1 or len(ends) != 1:
                        raise ValueError('ambiguous repeated span')
                    a = seconds(float(starts[0].offset + first.getOffsetInHierarchy(fm)))
                    b = seconds(float(ends[0].offset + last.getOffsetInHierarchy(lm)))
                except Exception:
                    skipped_wedges += 1
                    continue
            if b <= a:
                continue
            start = strength[min(round(a * rate), len(times) - 1)]
            after = [v for (t, v) in events if b <= t <= b + 2]
            end = after[0] if after else np.clip(start + (0.2 if isinstance(w, dynamics.Crescendo) else -0.2), 0.05, 1)
            mask = (times >= a) & (times <= b)
            strength[mask] = np.interp(times[mask], [a, b], [start, end])
            wedges += 1
        activity = np.zeros(len(times))
        for event in part.recurse().notes:
            q = float(event.getOffsetInHierarchy(score))
            start = seconds(q)
            end = seconds(q + float(event.quarterLength))
            count = max(1, len(getattr(event, 'pitches', ())))
            accent = 2.2 if any((isinstance(x, articulations.StrongAccent) for x in event.articulations)) else 1.8 if any((isinstance(x, articulations.Accent) for x in event.articulations)) else 1.0
            if any((isinstance(x, articulations.Staccato) for x in event.articulations)):
                end = start + (end - start) * 0.5
            lo = max(0, int(np.floor(start * rate)))
            hi = min(len(times), int(np.ceil(end * rate)))
            activity[lo:hi] += count
            sounding[lo:hi] += count
            tie = getattr(event, 'tie', None)
            if hi > lo and (tie is None or tie.type == 'start'):
                amplitude = np.sqrt(count) * strength[lo] ** 2 * accent
                for k in range(max(1, round(0.06 * rate))):
                    if lo + k < len(attacks):
                        attacks[lo + k] += amplitude * (1 - k / max(1, round(0.06 * rate)))
                if accent > 1:
                    accented.append(start)
                activity[lo:min(hi, lo + max(1, round(0.08 * rate)))] += count * (accent - 1)
        envelope += np.sqrt(activity) * strength ** 2
    profile = scale_envelope(envelope)
    diagnostics = {'dynamic_marks': markings, 'wedges': wedges, 'unmapped_wedges': skipped_wedges, 'accented_attacks': len(accented), 'profile_rate': rate}
    if detailed:
        return (dict(level=profile, attack=attack_envelope(attacks), rest=sounding == 0, accented=accented), diagnostics)
    return (profile, diagnostics)

def audit_score_prefix(parsed, score_bytes, suffix, expand=True):
    """Abstain at the first material cross-part clock/measure ambiguity; never repair notation silently."""
    from music21 import stream
    (score, repairs) = load_score(score_bytes, suffix, expand)
    parts = [list(p.getElementsByClass(stream.Measure)) for p in score.parts]
    reference = parts[0]
    minor = []
    reason = None
    stop = len(reference)
    for (i, base) in enumerate(reference):
        for (staff, measures) in enumerate(parts):
            if i >= len(measures):
                reason = f'Part {staff + 1} has fewer playback measures'
                break
            m = measures[i]
            if (m.number, m.numberSuffix) != (base.number, base.numberSuffix):
                reason = f'Measure ordering differs in part {staff + 1}'
                break
            if abs(float(m.offset - base.offset)) > 0.025:
                reason = f'Instrument parts disagree on the start of measure {base.number}'
                break
            if abs(float(m.barDuration.quarterLength - base.barDuration.quarterLength)) > 0.025:
                reason = f'Mixed-meter timing requires review at measure {base.number}'
                break
            excess = float(m.highestTime - m.barDuration.quarterLength)
            if excess > 0.05:
                reason = f'Measure {base.number} exceeds its meter in part {staff + 1}'
                break
            if excess > 1e-05:
                minor.append(f'Measure {base.number}, part {staff + 1}: small duration excess {excess:.5f} quarter notes')
        if reason:
            stop = i
            break
    if len(parsed['measures']) != len(reference):
        raise ValueError('Parsed and audited playback measure counts differ')
    for i in range(stop):
        if abs(float(reference[i].offset) - float(parsed['measures'].iloc[i].quarter)) > 0.025:
            raise ValueError('Parsed and audited score clocks differ before the proposed coverage limit')
    end = float(parsed['measures'].iloc[stop].score_sec) if stop < len(reference) else float(parsed['duration'])
    if end < 8 or stop < 2:
        raise ValueError('No sufficiently long unambiguous score prefix is available')
    return {'score_start': 0.0, 'score_end': end, 'supported_measures': stop, 'total_measures': len(reference), 'last_supported_label': str(reference[stop - 1].number), 'first_unsupported_label': str(reference[stop].number) if stop < len(reference) else None, 'reason': reason or 'No material clock disagreement detected', 'minor_warnings': minor, 'timing_repairs': repairs, 'status': 'structural audit passed; musical accuracy not manually verified', 'policy': 'Recognizable compound voices normalized to shared beats; unresolved timing still stops coverage. Automatic markers are provisional.'}

def audio_profile(audio, sr, frames, rate=50):
    import librosa
    rms = librosa.feature.rms(y=audio, frame_length=1024, hop_length=220)[0]
    flux = librosa.onset.onset_strength(y=audio, sr=sr, hop_length=220, n_fft=1024)
    t = np.arange(frames) / rate
    return {'rest': np.zeros(frames, dtype=bool), 'level': scale_envelope(np.interp(t, np.arange(len(rms)) * 220 / sr, rms) * 100), 'attack': attack_envelope(np.interp(t, np.arange(len(flux)) * 220 / sr, flux))}

def _features(chroma, profile, rate):
    chroma = np.asarray(chroma, dtype=np.float32)
    if chroma.ndim != 2 or chroma.shape[0] != 12:
        raise ValueError('Expected 12-row chroma')
    n = min([chroma.shape[1]] + [len(profile[k]) for k in ['level', 'attack']] + ([len(profile['rest'])] if 'rest' in profile else []))
    if n < 2:
        raise ValueError('At least two feature frames are required')
    out = {'chroma': chroma[:, :n], 'rate': float(rate)}
    for key in ['level', 'attack', 'rest']:
        out[key] = np.asarray(profile.get(key, np.zeros(n))[:n], dtype=bool if key == 'rest' else np.float32)
    if any((not np.isfinite(out[k]).all() for k in ['chroma', 'level', 'attack'])):
        raise ValueError('Features must be finite')
    return out

def _slice(f, start, end):
    start = max(0, int(start))
    end = min(f['chroma'].shape[1], int(end))
    return {k: (v[:, start:end] if k == 'chroma' else v[start:end]) if isinstance(v, np.ndarray) else v for (k, v) in f.items()}

def _downsample(f, target):
    stride = max(1, round(f['rate'] / target))
    out = {'rate': f['rate'] / stride}
    out['chroma'] = uniform_filter1d(f['chroma'], size=stride, axis=1)[:, ::stride]
    out['level'] = uniform_filter1d(f['level'], size=stride)[::stride]
    out['attack'] = maximum_filter1d(f['attack'], size=stride)[::stride]
    out['rest'] = uniform_filter1d(f['rest'].astype(float), size=stride)[::stride] > 0.95
    if 'novelty' in f:
        out['novelty'] = uniform_filter1d(f['novelty'], size=stride)[::stride]
    if 'novelty_valid' in f:
        out['novelty_valid'] = uniform_filter1d(f['novelty_valid'].astype(float), size=stride)[::stride] > 0.99
    return out

def _novelty(f):
    """FMP rank-one checkerboard novelty, without allocating a full SSM."""
    c = f['chroma'].astype(np.float32)
    c = c / np.maximum(np.linalg.norm(c, axis=0, keepdims=True), 1e-08)
    out = []
    for seconds in [2.0, 8.0]:
        L = max(1, round(seconds * f['rate']))
        axis = np.arange(-L, L + 1)
        v = np.sign(axis) * np.exp(-(np.sqrt(0.5) / (L * 0.5) * axis) ** 2)
        y = np.sum(convolve1d(c, v, axis=1, mode='constant') ** 2, axis=0) / np.abs(v).sum() ** 2
        y[:min(L, len(y))] = 0
        y[max(0, len(y) - L):] = 0
        out.append(y / max(float(np.percentile(y, 95)), 0.05))
    smooth = uniform_filter1d(f['level'], size=max(1, round(f['rate'])))
    change = np.abs(np.gradient(smooth))
    change /= max(float(np.percentile(change, 95)), 0.02)
    return np.clip((out[0] + out[1] + change) / 3, 0, 1).astype(np.float32)

def joint_cost(score, audio, *, use_structure=False, details=False):
    """Pairwise diagnostic cost with missing-evidence masks and symmetric attacks.

    Identical shared silence supplies no harmonic evidence. Missing channels do
    not earn perfect scores. Level/attack/rest weights are experimental choices.
    Returns (cost, metadata); details=True exposes per-cue cost/valid matrices.
    """
    (n, m) = (score['chroma'].shape[1], audio['chroma'].shape[1])
    if n * m > MAX_CELLS:
        raise ValueError('Cost window exceeds the bounded memory budget')
    sn = np.linalg.norm(score['chroma'], axis=0)
    an = np.linalg.norm(audio['chroma'], axis=0)
    sc = score['chroma'] / np.maximum(sn, 1e-08)
    ac = audio['chroma'] / np.maximum(an, 1e-08)
    harmony = np.clip(1 - sc.T @ ac, 0, 1).astype(np.float32)
    hv = np.broadcast_to(((sn > 1e-08) & ~score['rest'])[:, None], (n, m))
    numerator = np.zeros((n, m), np.float32)
    denominator = np.zeros_like(numerator)
    cues = {}

    def add(name, cost, valid, weight):
        nonlocal numerator, denominator
        numerator += weight * np.where(valid, cost, 0)
        denominator += weight * valid
        cues[name] = {'available_fraction': float(np.mean(valid))}
        if details:
            cues[name].update(cost=cost, valid=valid)
    add('harmony', harmony, hv, 0.55)

    def variation(f):
        size = max(3, round(4 * f['rate']))
        mean = uniform_filter1d(f['level'], size=size)
        return np.sqrt(np.maximum(uniform_filter1d(f['level'] ** 2, size=size) - mean ** 2, 0))
    (sv, av) = (variation(score), variation(audio))
    dv = (sv[:, None] > 0.035) & (av[None, :] > 0.035) & ~score['rest'][:, None]
    dynamics = np.abs(score['level'][:, None] - audio['level'][None, :])
    add('dynamics', dynamics, dv, 0.15)
    sa = maximum_filter1d(score['attack'], size=max(1, 2 * round(0.04 * score['rate']) + 1))
    aa = maximum_filter1d(audio['attack'], size=max(1, 2 * round(0.04 * audio['rate']) + 1))
    av_mask = (sa[:, None] > 0.12) | (aa[None, :] > 0.12)
    attack = np.abs(sa[:, None] - aa[None, :])
    add('attack', attack, av_mask, 0.25)
    lag = max(1, round(0.08 * score['rate']))
    rest = score['rest'].copy()
    if lag < len(rest):
        rest[lag:] &= score['rest'][:-lag]
    rest[:min(lag, len(rest))] = False
    if not np.any(~score['rest']):
        rest[:] = False
    rv = np.broadcast_to(rest[:, None], (n, m))
    rest_cost = np.broadcast_to(np.clip(audio['level'][None, :] / 0.2, 0, 1), (n, m))
    add('rest', rest_cost, rv, 0.15)
    if use_structure:
        ns = score['novelty'] if 'novelty' in score else _novelty(score)
        na = audio['novelty'] if 'novelty' in audio else _novelty(audio)

        def novelty_valid(f):
            if 'novelty_valid' in f:
                return f['novelty_valid']
            t = np.arange(f['chroma'].shape[1]) / f['rate']
            return (t >= 8) & (t <= t[-1] - 8)
        nv = ((ns[:, None] > 0.15) | (na[None, :] > 0.15)) & novelty_valid(score)[:, None] & novelty_valid(audio)[None, :]
        add('structure', np.abs(ns[:, None] - na[None, :]), nv, 0.1)
    cost = np.divide(numerator, denominator, out=np.full_like(numerator, 0.5), where=denominator > 0)
    return (cost, {'cues': cues, 'evidence_fraction': float(np.mean(denominator > 0)), 'evidence_mask': denominator > 0 if details else None})

def _solve_cost(cost, *, top_k=3, rate=50.0, evidence=None):
    import librosa
    (D, steps) = librosa.sequence.dtw(C=cost, subseq=True, backtrack=False, return_steps=True, step_sizes_sigma=STEPS, weights_mul=STEP_WEIGHTS)
    endings = D[-1] / max(cost.shape[0], 1)
    finite = np.flatnonzero(np.isfinite(endings))
    if not len(finite):
        raise ValueError('No path within the tempo/search constraints')
    minima = find_peaks(-endings)[0]
    candidates = np.unique(np.r_[finite[np.argmin(endings[finite])], minima])
    candidates = candidates[np.isfinite(endings[candidates])]
    candidates = candidates[np.argsort(endings[candidates])]
    alternatives = []
    for end in candidates[:100]:
        p = librosa.sequence.dtw_backtracking(steps, step_sizes_sigma=STEPS, subseq=True, start=int(end))[::-1]
        if not len(p) or p[0, 0] != 0:
            continue
        (lo, hi) = (int(p[0, 1]), int(p[-1, 1]))
        if any((max(lo, a['start']) <= min(hi, a['end']) for a in alternatives)):
            continue
        alternatives.append({'path': p, 'start': lo, 'end': hi, 'cost': float(endings[end]), 'mean_cell_cost': float(np.mean(cost[p[:, 0], p[:, 1]]))})
        if len(alternatives) >= top_k:
            break
    if not alternatives:
        raise ValueError('No complete phrase match')
    best = alternatives[0]
    out = dict(best, alternatives=alternatives[1:], joint_margin=alternatives[1]['cost'] - best['cost'] if len(alternatives) > 1 else None)
    if evidence is not None:
        out['evidence_fraction'] = float(evidence[best['path'][:, 0], best['path'][:, 1]].mean())
    return out

def _mapping(path, rate, score_offset=0.0, audio_offset=0.0):
    return pd.DataFrame({'score_sec': path[:, 0] / rate + score_offset, 'recording_sec': path[:, 1] / rate + audio_offset}).groupby('score_sec', as_index=False).mean()

def quarter_at(seconds, tempos):
    ts = np.array([t['score_sec'] for t in tempos])
    qs = np.array([t['quarter'] for t in tempos])
    bpm = np.array([t['bpm'] for t in tempos])
    ix = np.maximum(0, np.searchsorted(ts, seconds, side='right') - 1)
    return qs[ix] + (np.asarray(seconds) - ts[ix]) * bpm[ix] / 60

def acoustic_mean(times, origins, rows, step):
    z = (np.asarray(times) - origins) / step
    j = np.floor(np.clip(z, 0, rows.shape[1] - 1 - 1e-08)).astype(int)
    f = np.clip(z - j, 0, 1)
    ii = np.arange(len(z))
    values = rows[ii, j] * (1 - f) + rows[ii, j + 1] * f
    return float(np.mean(values))

def optimize_mapping(score_features, audio_features, parsed, initial_mapping, protected_intervals=(), progress=print, pause_events=()):
    """Whole-piece joint refinement with no independent-window stitching.

    Protected intervals are shared-quarter coordinates. Their duration is fitted
    to the audio with relaxed tempo continuity, rather than copied from the seed.
    """
    rate = float(score_features['rate'])
    arate = float(audio_features['rate'])
    (lo, hi) = initial_mapping.score_sec.to_numpy(float)[[0, -1]]
    (qlo, qhi) = quarter_at(np.array([lo, hi]), parsed['tempo_map'])
    qs = np.unique(np.r_[qlo, np.arange(np.ceil(qlo * 4) / 4, qhi, 0.25), qhi, [t['quarter'] for t in parsed['tempo_map'] if qlo < t['quarter'] < qhi]])
    boundary_quarters = [v for interval in protected_intervals for v in interval if qlo < v < qhi]
    for event in pause_events:
        for value in (float(event['score_sec']), float(event.get('score_end', float(event['score_sec']) + 1.0))):
            if lo < value < hi:
                boundary_quarters.append(float(quarter_at(np.array([value]), parsed['tempo_map'])[0]))
    qs = np.unique(np.round(np.r_[qs, boundary_quarters], 9))
    extra = []
    for value in quarter_at(initial_mapping.score_sec.to_numpy(float), parsed['tempo_map']):
        if np.min(np.abs(qs - value)) >= 0.02:
            extra.append(value)
    qs = np.unique(np.round(np.r_[qs, extra], 9))
    tq = np.array([t['quarter'] for t in parsed['tempo_map']])
    ts = np.array([t['score_sec'] for t in parsed['tempo_map']])
    bpm = np.array([t['bpm'] for t in parsed['tempo_map']])
    ix = np.maximum(0, np.searchsorted(tq, qs, side='right') - 1)
    knots = ts[ix] + (qs - tq[ix]) * 60 / bpm[ix]
    knots[0] = lo
    knots[-1] = hi
    initial = np.interp(knots, initial_mapping.score_sec, initial_mapping.recording_sec)
    if np.any(np.diff(initial) <= 0):
        raise ValueError('Seed must have strictly increasing score and recording clocks')
    nominal = np.diff(knots)
    seed_reparameterization = float(np.max(np.abs(np.interp(initial_mapping.score_sec, knots, initial) - initial_mapping.recording_sec)))
    weights = np.ones(len(nominal) - 1)
    protected = np.zeros(len(nominal), bool)
    for (a, b) in protected_intervals:
        protected |= (qs[:-1] < b - 1e-08) & (qs[1:] > a + 1e-08)
    weights[protected[:-1] | protected[1:]] *= 0.25
    for q in tq[1:]:
        weights[np.abs(qs[1:-1] - q) < 1e-07] *= 1.0
    sample_idx = np.unique(np.r_[np.arange(round(lo * rate), round(hi * rate) + 1, 1), round(hi * rate)]).astype(int)
    sample_times = sample_idx / rate
    centers = np.interp(sample_times, initial_mapping.score_sec, initial_mapping.recording_sec)
    radius = 4.0
    width = round(radius * 2 * arate) + 1
    origins = np.floor((centers - radius) * arate) / arate
    costs = np.empty((len(sample_idx), width), np.float32)
    progress('Building whole-piece acoustic corridor for joint tempo fitting')
    for start in range(0, len(sample_idx), 64):
        stop = min(start + 64, len(sample_idx))
        idxs = sample_idx[start:stop]
        s0 = max(0, int(idxs[0]) - round(2 * rate))
        s1 = min(score_features['chroma'].shape[1], int(idxs[-1]) + round(2 * rate) + 1)
        a0 = max(0, int(np.floor(origins[start:stop].min() * arate)) - round(2 * arate))
        a1 = min(audio_features['chroma'].shape[1], int(np.ceil((origins[start:stop].max() + 2 * radius) * arate)) + round(2 * arate) + 1)
        (C, _) = joint_cost(_slice(score_features, s0, s1), _slice(audio_features, a0, a1), use_structure=True)
        for (local, i) in enumerate(range(start, stop)):
            audio_idx = np.round(origins[i] * arate).astype(int) + np.arange(width)
            good = (audio_idx >= a0) & (audio_idx < a1)
            costs[i] = 2.0
            costs[i, good] = C[idxs[local] - s0, audio_idx[good] - a0]
    pause_by_interval = {}
    for event in pause_events:
        a = float(event['score_sec'])
        b = float(event.get('score_end', a + 1.0))
        duration = float(event.get('duration', event.get('recording_end', 0) - event.get('recording_start', 0)))
        if duration <= 0 or b <= a:
            continue
        overlap = np.maximum(0, np.minimum(knots[1:], b) - np.maximum(knots[:-1], a))
        for j in np.flatnonzero(overlap > 0):
            pause_by_interval[int(j)] = pause_by_interval.get(int(j), 0.0) + duration * overlap[j] / (b - a)
    pause_indices = np.array(sorted(pause_by_interval), dtype=int)
    pause_durations = np.array([min(pause_by_interval[j], 0.85 * (initial[j + 1] - initial[j])) for j in pause_indices])
    for j in pause_indices:
        if j > 0:
            weights[j - 1] = 1.0
        if j < len(weights):
            weights[j] = 1.0
    for q in tq[1:]:
        weights[np.abs(qs[1:-1] - q) < 1e-07] *= 1.0
    stages = []
    current = initial.copy()
    for sigma in (0.1, 0.04):
        progress(f'Joint acoustic and tempo optimization at {sigma:.2f}s cost scale')
        field = gaussian_filter1d(costs, sigma=sigma * arate, axis=1, mode='nearest')
        (current, d) = optimize_cost_times_direct(sample_times, origins, field, 1 / arate, knots, current, nominal, smooth_weights=weights, maxiter=1200, regularization=0.25, pause_indices=pause_indices, pause_durations=pause_durations, regularization_spacings=(np.diff(qs)[:-1] + np.diff(qs)[1:]) / 2)
        d['cost_scale_sec'] = sigma
        stages.append(d)
        if d['accepted']:
            pause_durations = np.asarray(d['pause_durations'])
    raw_before = acoustic_mean(np.interp(sample_times, knots, initial), origins, costs, 1 / arate)
    raw_after = acoustic_mean(np.interp(sample_times, knots, current), origins, costs, 1 / arate)
    acoustic_accepted = raw_after <= raw_before + 0.02
    if not acoustic_accepted:
        current = initial.copy()
    grid = np.unique(np.r_[initial_mapping.score_sec.to_numpy(float), knots])
    grid = grid[np.r_[True, np.diff(grid) > 1e-07]]
    output = pd.DataFrame({'score_sec': grid, 'recording_sec': np.interp(grid, knots, current)})
    if output.recording_sec.iloc[-1] > (audio_features['chroma'].shape[1] - 1) / arate:
        return (initial_mapping.copy(), {'accepted': False, 'reason': 'Optimized endpoint exceeded recording', 'stages': stages})
    return (output, {'accepted': bool(acoustic_accepted and any((d['accepted'] for d in stages))), 'stages': stages, 'raw_acoustic_before': raw_before, 'raw_acoustic_after_candidate': raw_after, 'acoustic_degradation_limit': 0.02, 'acoustic_accepted': acoustic_accepted, 'knots': len(knots), 'seed_reparameterization_shift_sec': seed_reparameterization, 'acoustic_samples': len(sample_times), 'protected_intervals': len(protected_intervals), 'protected_knot_intervals': int(protected.sum()), 'band_radius_sec': radius, 'supported_pause_events': len(pause_events), 'initial_pause_durations': list(pause_by_interval.values()), 'protected_continuity_weight': 0.25, 'converged': bool(all((d['converged'] for d in stages))), 'pause_localization': 'Extra duration spread over coarse hold span; exact onset remains uncertain', 'max_shift_sec': float(np.max(np.abs(output.recording_sec - np.interp(grid, initial_mapping.score_sec, initial_mapping.recording_sec)))), 'limitations': 'Local joint optimization within a disclosed 4-second corridor. Acoustic cost is re-evaluated throughout; convergence is not verified musical accuracy. Unmarked breaths are only represented when provided by the seed pause evidence. No hard inherited marker pins.'})

def _direct_residual_jac(x, *, costs, origins, step, left, fraction, nominal, weights, spacings, regularization, initial, pause_indices, initial_pauses):
    """Sparse local residual/Jacobian in absolute knot times (no cumulative conditioning)."""
    from scipy.sparse import coo_matrix
    n = len(initial)
    times = x[:n]
    pauses = x[n:]
    moving = np.diff(times)
    if len(pauses):
        moving = moving.copy()
        np.subtract.at(moving, pause_indices, pauses)
    safe = np.maximum(moving, nominal * 0.001)
    samples = (1 - fraction) * times[left] + fraction * times[left + 1]
    z = (samples - origins) / step
    j = np.floor(np.clip(z, 0, costs.shape[1] - 1 - 1e-08)).astype(int)
    f = np.clip(z - j, 0, 1)
    ii = np.arange(len(z))
    y0 = costs[ii, j]
    y1 = costs[ii, j + 1]
    m0 = (y1 - costs[ii, np.maximum(j - 1, 0)]) / 2
    m1 = (costs[ii, np.minimum(j + 2, costs.shape[1] - 1)] - y0) / 2
    vals = (2 * f ** 3 - 3 * f ** 2 + 1) * y0 + (f ** 3 - 2 * f ** 2 + f) * m0 + (-2 * f ** 3 + 3 * f ** 2) * y1 + (f ** 3 - f ** 2) * m1
    deriv = ((6 * f * f - 6 * f) * y0 + (3 * f * f - 4 * f + 1) * m0 + (-6 * f * f + 6 * f) * y1 + (3 * f * f - 2 * f) * m1) / step
    deriv[(z < 0) | (z > costs.shape[1] - 1) | (vals < 1e-10)] = 0
    residual = []
    rr = []
    cc = []
    vv = []
    offset = 0

    def append(r, columns, values):
        nonlocal offset
        r = np.atleast_1d(r)
        residual.extend(r)
        for (c, v) in zip(columns, values):
            rr.extend((offset + np.arange(len(r))).tolist())
            cc.extend(np.broadcast_to(c, len(r)).tolist())
            vv.extend(np.broadcast_to(v, len(r)).tolist())
        offset += len(r)
    acoustic = np.sqrt(np.maximum(vals, 1e-10) / len(z))
    g = deriv / (2 * np.sqrt(np.maximum(vals, 1e-10) * len(z)))
    append(acoustic, [left, left + 1], [g * (1 - fraction), g * fraction])
    excess = np.minimum(z, 0) + np.maximum(z - (costs.shape[1] - 1), 0)
    g = np.sqrt(4 / len(z)) * ((z < 0) | (z > costs.shape[1] - 1))
    append(np.sqrt(4 / len(z)) * excess * step, [left, left + 1], [g * (1 - fraction), g * fraction])
    inv = np.where(moving > nominal * 0.001, 1 / safe, 0.0)
    scale = np.sqrt(regularization * weights / (np.maximum(spacings, 1e-07) * max(float(np.sum(spacings)), 1e-07)))
    delta = np.diff(np.log(safe / nominal))
    idx = np.arange(n - 2)
    tempo_offset = offset
    append(scale * delta, [idx, idx + 1, idx + 2], [scale * inv[:-1], -scale * (inv[:-1] + inv[1:]), scale * inv[1:]])
    for (pi, k) in enumerate(pause_indices):
        if k > 0:
            rr.append(tempo_offset + k - 1)
            cc.append(n + pi)
            vv.append(-scale[k - 1] * inv[k])
        if k < n - 2:
            rr.append(tempo_offset + k)
            cc.append(n + pi)
            vv.append(scale[k] * inv[k])
    deficit = np.minimum(moving - 0.05 * nominal, 0)
    g = np.sqrt(1000) / nominal * (deficit < 0)
    barrier_offset = offset
    append(np.sqrt(1000) * deficit / nominal, [np.arange(n - 1), np.arange(1, n)], [-g, g])
    for (pi, k) in enumerate(pause_indices):
        rr.append(barrier_offset + k)
        cc.append(n + pi)
        vv.append(-g[k])
    append(np.sqrt(0.0001) * np.array([times[0] - initial[0], times[-1] - initial[-1]]), [np.array([0, n - 1])], [np.sqrt(0.0001)])
    if len(pauses):
        append(np.sqrt(0.02) * (pauses - initial_pauses), [np.arange(n, len(x))], [np.sqrt(0.02)])
    return (np.asarray(residual), coo_matrix((vv, (rr, cc)), shape=(offset, len(x))).tocsr())

def optimize_cost_times_direct(score_times, audio_origins, cost_rows, audio_step, knot_score_times, initial_knot_times, nominal_durations, smooth_weights=None, maxiter=300, regularization=0.25, pause_indices=(), pause_durations=(), regularization_spacings=None):
    from scipy.optimize import least_squares
    st = np.asarray(score_times, float)
    ks = np.asarray(knot_score_times, float)
    initial = np.asarray(initial_knot_times, float)
    nominal = np.asarray(nominal_durations, float)
    costs = np.asarray(cost_rows, float)
    origins = np.asarray(audio_origins, float)
    n = len(initial)
    pidx = np.asarray(pause_indices, int)
    p0 = np.asarray(pause_durations, float)
    arrays = (st, ks, initial, nominal, costs, origins, p0)
    if not all((np.isfinite(v).all() for v in arrays)) or audio_step <= 0 or np.any(np.diff(ks) <= 0) or np.any(nominal <= 0):
        raise ValueError('Finite positive clocks and acoustic grid required')
    if origins.shape != (len(st),) or len(ks) != n or costs.ndim != 2 or (len(nominal) != n - 1):
        raise ValueError('Inconsistent dimensions')
    if len(pidx) != len(p0) or np.any(pidx < 0) or np.any(pidx >= len(nominal)) or np.any(p0 < 0):
        raise ValueError('Invalid pause configuration')
    moving0 = np.diff(initial).copy()
    if len(pidx):
        np.subtract.at(moving0, pidx, p0)
    if np.any(moving0 <= 0):
        raise ValueError('Pause consumes the moving interval')
    if costs.shape[0] != len(st) or costs.shape[1] < 2 or len(nominal) != n - 1 or np.any(np.diff(initial) <= 0):
        raise ValueError('Invalid optimizer clocks')
    left = np.clip(np.searchsorted(ks, st, side='right') - 1, 0, n - 2)
    frac = np.clip((st - ks[left]) / (ks[left + 1] - ks[left]), 0, 1)
    weights = np.ones(n - 2) if smooth_weights is None else np.asarray(smooth_weights, float)
    spacing = np.ones(n - 2) if regularization_spacings is None else np.asarray(regularization_spacings, float)
    if weights.shape != (n - 2,) or spacing.shape != (n - 2,) or (not np.isfinite(weights).all()) or (not np.isfinite(spacing).all()) or np.any(weights < 0) or np.any(spacing <= 0) or (regularization < 0):
        raise ValueError('Invalid physical continuity weights')
    kw = dict(costs=costs, origins=origins, step=audio_step, left=left, fraction=frac, nominal=nominal, weights=weights, spacings=spacing, regularization=regularization, initial=initial, pause_indices=pidx, initial_pauses=p0)
    x0 = np.r_[initial, p0]
    before = float(np.sum(_direct_residual_jac(x0, **kw)[0] ** 2))
    low = np.r_[np.maximum(0, initial - 4), np.zeros(len(p0))]
    high = np.r_[initial + 4, np.maximum(1, p0 * 2 + 0.5)]
    result = least_squares(lambda x: _direct_residual_jac(x, **kw)[0], x0, jac=lambda x: _direct_residual_jac(x, **kw)[1], bounds=(low, high), method='trf', tr_solver='lsmr', tr_options={'atol': 1e-08, 'btol': 1e-08, 'maxiter': 300}, x_scale='jac', max_nfev=maxiter, ftol=1e-08, xtol=1e-08, gtol=1e-07)
    times = result.x[:n]
    moving = np.diff(times)
    if len(pidx):
        np.subtract.at(moving, pidx, result.x[n:])
    sample = np.interp(st, ks, times)
    excess = np.maximum(origins - sample, 0) + np.maximum(sample - (origins + (costs.shape[1] - 1) * audio_step), 0)
    valid = bool(np.all(moving > 0) and np.all(np.diff(times) > 0) and (2 * result.cost <= before + 1e-08) and (np.max(excess) < 0.02))
    if not valid:
        times = initial.copy()
    return (times, dict(objective_before=before, objective_after=float(2 * result.cost), converged=bool(result.success), accepted=valid, iterations=int(result.nfev), iteration_limit=maxiter, message=str(result.message), gradient_max_abs=float(result.optimality), max_band_excess_sec=float(np.max(excess)), regularization=regularization, max_knot_shift_sec=float(np.max(np.abs(times - initial))), endpoint_prior_weight=0.0001, pause_indices=pidx.tolist(), pause_durations=result.x[n:].tolist(), acoustic_cost_before=acoustic_mean(np.interp(st, ks, initial), origins, costs, audio_step), acoustic_cost_after=acoustic_mean(np.interp(st, ks, times), origins, costs, audio_step), solver='sparse-direct-times'))

def original_coarse(score, audio, end):
    """Expose the original Structure search coarse stage without its refinement."""
    score = _slice(score, 0, round(end * score['rate']) + 1)
    (s2, a2) = (_downsample(score, 2), _downsample(audio, 2))
    (cost, _) = joint_cost(s2, a2, use_structure=True)
    match = _solve_cost(cost, top_k=3, rate=s2['rate'])
    mapping = _mapping(match['path'], s2['rate'])
    if mapping.score_sec.iloc[-1] < end:
        (last, prev) = (mapping.iloc[-1], mapping.iloc[-2])
        slope = (last.recording_sec - prev.recording_sec) / (last.score_sec - prev.score_sec)
        finish = last.recording_sec + slope * (end - last.score_sec)
        if finish <= (audio['chroma'].shape[1] - 1) / audio['rate']:
            mapping.loc[len(mapping)] = [end, finish]
    return (mapping, {'stage': 'Original global 2 Hz match, with no local refinement', 'coarse_cost': match['cost'], 'coarse_alternative_margin': match['joint_margin']})

def package_method(name, mapping, parsed, diagnostics, elapsed, review_positions=()):
    mapping = mapping[['score_sec', 'recording_sec']].copy()
    if not np.isfinite(mapping.to_numpy()).all() or np.any(np.diff(mapping.score_sec) <= 0) or np.any(np.diff(mapping.recording_sec) < 0):
        raise ValueError('Alignment must be finite and monotone')
    (lo, hi) = mapping.score_sec.iloc[[0, -1]].to_numpy()
    measures = parsed['measures'].copy()
    measures['recording_sec'] = np.interp(measures.score_sec, mapping.score_sec, mapping.recording_sec, left=np.nan, right=np.nan)
    rows = []
    for s in review_positions:
        if lo <= s <= hi:
            rows.append({'score_sec': float(s), 'recording_sec': float(np.interp(s, mapping.score_sec, mapping.recording_sec)), 'chord': 'Timing review point', 'accepted': False, 'provisional': True, 'reason': 'Shared review location; no calibrated confidence or confirmed anchor.', 'similarity': None, 'dynamics_score': None, 'attack_score': None, 'rest_score': None})
    return {'algorithm': VERSION + '-' + name, 'mapping': mapping, 'measures': measures, 'anchors': pd.DataFrame(rows, columns=['score_sec', 'recording_sec', 'chord', 'accepted', 'provisional', 'reason', 'similarity', 'dynamics_score', 'attack_score', 'rest_score']), 'accepted_anchors': 0, 'provisional_markers': len(rows), 'runtime': elapsed, 'coverage': {'score_start': float(lo), 'score_end': float(hi), 'recording_start': float(mapping.recording_sec.iloc[0]), 'recording_end': float(mapping.recording_sec.iloc[-1]), 'estimated': True, 'prefix_only': bool(hi < parsed['duration'] - 0.05)}, 'diagnostics': diagnostics}

def evaluate_evidence(score, audio, mapping, step=0.1):
    rate = score['rate']
    arate = audio['rate']
    query = np.arange(mapping.score_sec.iloc[0], mapping.score_sec.iloc[-1] + 1e-08, step)
    match = np.interp(query, mapping.score_sec, mapping.recording_sec)
    si = np.round(query * rate).astype(int)
    ai = np.round(match * arate).astype(int)
    totals = {}
    counts = {}
    costs = []
    for start in range(0, len(si), 32):
        stop = min(start + 32, len(si))
        ss = si[start:stop]
        aa = ai[start:stop]
        s0 = max(0, int(ss.min()) - int(2 * rate))
        s1 = min(score['chroma'].shape[1], int(ss.max()) + int(2 * rate) + 1)
        a0 = max(0, int(aa.min()) - int(2 * arate))
        a1 = min(audio['chroma'].shape[1], int(aa.max()) + int(2 * arate) + 1)
        (cost, meta) = joint_cost(_slice(score, s0, s1), _slice(audio, a0, a1), use_structure=True, details=True)
        ii = ss - s0
        jj = np.clip(aa - a0, 0, a1 - a0 - 1)
        costs.extend(cost[ii, jj].tolist())
        for (key, cue) in meta['cues'].items():
            valid = cue['valid'][ii, jj]
            values = cue['cost'][ii, jj]
            totals[key] = totals.get(key, 0.0) + float(values[valid].sum())
            counts[key] = counts.get(key, 0) + int(valid.sum())
    return {'mean_joint_mismatch': float(np.mean(costs)), 'sample_count': len(costs), 'channels': {k: {'mean_mismatch': totals[k] / counts[k] if counts[k] else None, 'available_fraction': counts[k] / len(costs)} for k in totals}, 'interpretation': 'Internal feature agreement only; not an accuracy score or calibrated confidence.'}

def score_clock(parsed):
    marks = sorted(parsed['tempo_map'], key=lambda x: x['quarter'])
    quarters = np.array([m['quarter'] for m in marks], float)
    seconds = np.array([m['score_sec'] for m in marks], float)
    bpm = np.array([m['bpm'] for m in marks], float)
    if not len(marks) or np.any(bpm <= 0):
        raise ValueError('A positive nominal tempo map is required')

    def to_seconds(q):
        q = np.asarray(q, float)
        i = np.maximum(0, np.searchsorted(quarters, q, side='right') - 1)
        return seconds[i] + (q - quarters[i]) * 60 / bpm[i]

    def to_quarters(s):
        s = np.asarray(s, float)
        i = np.maximum(0, np.searchsorted(seconds, s, side='right') - 1)
        return quarters[i] + (s - seconds[i]) * bpm[i] / 60
    return (to_seconds, to_quarters)

def mapping_arrays(method):
    mapping = method['mapping']
    x = np.asarray(mapping['score_sec'], float)
    y = np.asarray(mapping['recording_sec'], float)
    if len(x) < 2 or len(x) != len(y) or (not np.isfinite(np.r_[x, y]).all()):
        raise ValueError('Mapping must contain at least two finite paired points')
    if np.any(np.diff(x) <= 0) or np.any(np.diff(y) < 0):
        raise ValueError('Mapping score times must increase and recording times cannot decrease')
    return (x, y)

def summary(values):
    values = np.asarray(values, float)
    values = values[np.isfinite(values)]
    if not len(values):
        return dict(count=0, median=None, p95=None, maximum=None)
    return dict(count=int(len(values)), median=float(np.median(values)), p95=float(np.percentile(values, 95)), maximum=float(np.max(values)))

def audit_methods(parsed, methods, parent, *, protected_quarters=(), annotations=()):
    """Return report and interval/landmark rows. Parent is one result, not a bundle.

    annotations entries: score_sec, recording_sec, optional uncertainty_sec.
    protected_quarters entries: (start,end), used only to classify audit intervals.
    """
    (sec, quarter) = score_clock(parsed)
    starts = np.asarray(parsed['measures']['quarter'], float)
    ends = np.r_[starts[1:], float(quarter(parsed['duration']))]
    (parent_x, parent_y) = mapping_arrays(parent)
    anchors = parent.get('anchors')
    landmarks = np.asarray(anchors['score_sec'], float) if anchors is not None and len(anchors) else np.array([], float)
    landmarks = np.unique(np.r_[parent_x[0], landmarks, parent_x[-1]])
    tempo_q = np.array([t['quarter'] for t in parsed['tempo_map']], float)
    report = {'limitation': 'Regularity and displacement are not acoustic accuracy. Only independent annotations measure timing error.', 'methods': {}, 'subdivision_grids': [1, 0.5, 0.25, 0.125, 1 / 3]}
    (interval_rows, landmark_rows) = ([], [])
    for (name, method) in methods.items():
        (x, y) = mapping_arrays(method)
        (ordinary_ratios, boundary_ratios, all_ms) = ([], [], [])
        counts = dict(covered=0, uncovered=0, protected=0, written_tempo_boundary=0)
        worst = []
        for (mi, (start, end)) in enumerate(zip(starts, ends)):
            for step in report['subdivision_grids']:
                q = np.arange(start, end + 1e-08, step)
                s = sec(q)
                previous = None
                for j in range(len(q) - 1):
                    (lo, hi) = (float(s[j]), float(s[j + 1]))
                    covered = lo >= x[0] - 1e-09 and hi <= x[-1] + 1e-09
                    protected = any((q[j] < b - 1e-09 and q[j + 1] > a + 1e-09 for (a, b) in protected_quarters))
                    boundary = bool(np.any((tempo_q > q[j] + 1e-09) & (tempo_q <= q[j + 1] + 1e-09)))
                    counts['covered' if covered else 'uncovered'] += 1
                    counts['protected'] += int(covered and protected)
                    counts['written_tempo_boundary'] += int(covered and boundary)
                    duration = float(np.diff(np.interp([lo, hi], x, y))[0]) if covered else None
                    residual = duration / (hi - lo) if covered else None
                    ratio = None
                    if covered and previous is not None and (residual > 0) and (previous['residual'] > 0):
                        ratio = max(residual / previous['residual'], previous['residual'] / residual)
                        target = boundary_ratios if protected or boundary or previous['protected'] or previous['boundary'] else ordinary_ratios
                        target.append(ratio)
                        if target is ordinary_ratios:
                            worst.append(dict(measure=mi + 1, quarter=float(q[j]), subdivision=step, adjacent_residual_ratio=float(ratio)))
                    interval_rows.append(dict(method=name, measure=mi + 1, start_quarter=float(q[j]), end_quarter=float(q[j + 1]), subdivision=step, covered=covered, protected=protected, written_tempo_boundary=boundary, duration_ms=None if duration is None else duration * 1000, residual_rate=residual, adjacent_residual_ratio=ratio))
                    if covered:
                        all_ms.append(duration * 1000)
                        previous = dict(residual=residual, protected=protected, boundary=boundary)
                    else:
                        previous = None
        use = landmarks[(landmarks >= max(x[0], parent_x[0])) & (landmarks <= min(x[-1], parent_x[-1]))]
        deltas = np.interp(use, x, y) - np.interp(use, parent_x, parent_y)
        for (position, delta) in zip(use, deltas):
            landmark_rows.append(dict(method=name, score_sec=float(position), parent_recording_sec=float(np.interp(position, parent_x, parent_y)), recording_sec=float(np.interp(position, x, y)), displacement_sec=float(delta)))
        common = np.unique(np.r_[x, parent_x])
        common = common[(common >= max(x[0], parent_x[0])) & (common <= min(x[-1], parent_x[-1]))]
        shift = np.interp(common, x, y) - np.interp(common, parent_x, parent_y)
        seams = []
        for (mi, q) in enumerate(starts[1:], start=2):
            positions = sec(np.array([q - 0.25, q, q + 0.25]))
            if positions[0] < x[0] or positions[-1] > x[-1]:
                continue
            rates = np.diff(np.interp(positions, x, y)) / np.diff(positions)
            paused = any((q - 0.25 < b - 1e-09 and q + 0.25 > a + 1e-09 for (a, b) in protected_quarters))
            written = bool(np.any(abs(tempo_q - q) < 1e-08))
            seams.append(dict(measure=mi, quarter=float(q), protected=paused, written_tempo_boundary=written, adjacent_residual_ratio=float(max(rates) / min(rates)) if min(rates) > 0 else None))
        (errors, uncertainty_adjusted) = ([], [])
        for event in annotations:
            if event.get('recording_sec') is None or not x[0] <= event['score_sec'] <= x[-1]:
                continue
            error = abs(float(np.interp(event['score_sec'], x, y)) - float(event['recording_sec']))
            errors.append(error)
            uncertainty_adjusted.append(max(0, error - float(event.get('uncertainty_sec') or 0)))
        by_grid = {}
        own = [r for r in interval_rows if r['method'] == name]
        for step in report['subdivision_grids']:
            subset = [r for r in own if r['subdivision'] == step]
            by_grid[str(step)] = {'covered': int(sum((r['covered'] for r in subset))), 'uncovered': int(sum((not r['covered'] for r in subset))), 'duration_ms': summary([r['duration_ms'] for r in subset if r['covered']]), 'adjacent_ratio_all_boundaries': summary([r['adjacent_residual_ratio'] for r in subset if r['adjacent_residual_ratio'] is not None])}
        report['methods'][name] = dict(by_subdivision=by_grid, coverage=dict(score_start=float(x[0]), score_end=float(x[-1]), score_extent=float(parsed['duration']), recording_start=float(y[0]), recording_end=float(y[-1])), intervals=counts, duration_ms=summary(all_ms), ordinary_adjacent_residual_ratio=summary(ordinary_ratios), boundary_adjacent_residual_ratio=summary(boundary_ratios), worst_ordinary_intervals=sorted(worst, key=lambda r: r['adjacent_residual_ratio'], reverse=True)[:20], landmark_absolute_displacement_sec=summary(abs(deltas)), whole_mapping_absolute_displacement_sec=summary(abs(shift)), barline_seams=seams, zero_recording_increments=int(np.sum(np.diff(y) == 0)), independent_annotation_error_sec=summary(errors), uncertainty_adjusted_error_sec=summary(uncertainty_adjusted), independent_annotations_available=bool(errors))
    return (report, interval_rows, landmark_rows)

def write_audit(output_prefix, report, interval_rows, landmark_rows):
    prefix = Path(output_prefix)
    prefix.parent.mkdir(parents=True, exist_ok=True)
    prefix.with_suffix('.json').write_text(json.dumps(report, indent=2, allow_nan=False))
    for (suffix, rows) in [('-beats.csv', interval_rows), ('-landmarks.csv', landmark_rows)]:
        with Path(str(prefix) + suffix).open('w', newline='') as file:
            if rows:
                writer = csv.DictWriter(file, fieldnames=list(rows[0]))
                writer.writeheader()
                writer.writerows(rows)

def protected_intervals(raw,suffix,expand=True):
    """Same fermata/ensemble-gap extraction, without unused run detection."""
    from music21 import expressions
    score,_=load_score(raw,suffix,expand)
    protected=[];sounding=[]
    for part in score.parts:
        for measure in part.getElementsByClass(stream.Measure):
            for event in measure.recurse().notesAndRests:
                q=float(event.getOffsetInHierarchy(score));d=float(event.quarterLength)
                if d<=0:continue
                if any(isinstance(e,expressions.Fermata) for e in event.expressions):
                    protected.append((q,q+d))
                if not event.isRest:sounding.append((q,q+d))
    end=0.
    for a,b in sorted(sounding):
        if a>end+1e-7:protected.append((end,a))
        end=max(end,b)
    return sorted(set(protected))

def extract_pitch(parsed,audio_bytes):
    import librosa
    from synctoolbox.feature.pitch import audio_to_pitch_features
    from synctoolbox.feature.csv_tools import df_to_pitch_features
    from synctoolbox.feature.chroma import pitch_to_chroma,quantize_chroma
    from synctoolbox.feature.utils import estimate_tuning
    audio,sr=librosa.load(io.BytesIO(audio_bytes),sr=22050,mono=True)
    if not 2<=len(audio)/sr<=2400 or parsed['duration']>2400:
        raise ValueError('Recording must be 2 seconds to 40 minutes; score at most 40 minutes')
    if not np.isfinite(audio).all() or np.max(np.abs(audio))<1e-7:
        raise ValueError('Silent or invalid recording')
    tuning=float(estimate_tuning(audio,sr));rate=50
    ap=audio_to_pitch_features(f_audio=audio,Fs=sr,tuning_offset=tuning,feature_rate=rate,verbose=False)
    sp=df_to_pitch_features(parsed['notes'],feature_rate=rate,ignore_velocity=True)
    frames=int(np.ceil(parsed['duration']*rate))+1
    sp=np.pad(sp,((0,0),(0,max(0,frames-sp.shape[1]))))
    return quantize_chroma(pitch_to_chroma(sp)),quantize_chroma(pitch_to_chroma(ap)),audio,sr,tuning

def run_original_search(score_bytes,audio_bytes,suffix='.mxl',expand=True,progress=print):
    started=time.perf_counter()
    parsed=parse_score(score_bytes,suffix,expand)
    audit=audit_score_prefix(parsed,score_bytes,suffix,expand)
    progress('Extracting direct score and recording features')
    sc,ac,audio,sr,tuning=extract_pitch(parsed,audio_bytes)
    rate=50
    profile,profile_diagnostics=score_envelope(parsed,score_bytes,suffix,expand,rate=rate,detailed=True)
    score=_features(sc,profile,rate)
    heard=_features(ac,audio_profile(audio,sr,ac.shape[1],rate),rate)
    # Match the historical supported-feature extent, including its floor convention.
    end=min(float(audit['score_end']), (min(int(np.floor(audit['score_end']*rate)),sc.shape[1])-1)/rate)
    for f in (score,heard):
        low=_downsample(f,5);novelty=_novelty(low)
        t=np.arange(f['chroma'].shape[1])/rate
        f['novelty']=np.interp(t,np.arange(len(novelty))/low['rate'],novelty).astype(np.float32)
        f['novelty_valid']=(t>=8)&(t<=t[-1]-8)
    progress('Finding original global broad match')
    seed,coarse_diagnostics=original_coarse(score,heard,end)
    protected=protected_intervals(score_bytes,suffix,expand)
    mapping,diagnostics=optimize_mapping(score,heard,parsed,seed,protected_intervals=protected,progress=progress,pause_events=())
    result=package_method('Integrated tempo from original search',mapping,parsed,diagnostics,time.perf_counter()-started)
    # Independent diagnostic evaluation; this never changes the returned map.
    report,beats,landmarks=audit_methods(parsed,{'Integrated tempo from original search':result},{'mapping':seed},protected_quarters=protected)
    result.update(score_audit=audit,profile_diagnostics=profile_diagnostics,tuning_cents=tuning,
                  broad_mapping=seed,broad_diagnostics=coarse_diagnostics,
                  evidence=evaluate_evidence(score,heard,mapping),evaluation=report,beat_intervals=beats)
    return result

if __name__=='__main__':
    import argparse
    parser=argparse.ArgumentParser()
    parser.add_argument('score',type=Path);parser.add_argument('audio',type=Path)
    parser.add_argument('--output',type=Path,default=Path('alignment-output'))
    args=parser.parse_args()
    result=run_original_search(args.score.read_bytes(),args.audio.read_bytes(),args.score.suffix)
    args.output.mkdir(parents=True,exist_ok=True)
    result['mapping'].to_csv(args.output/'mapping.csv',index=False)
    result['measures'].to_csv(args.output/'measures.csv',index=False)
    (args.output/'diagnostics.json').write_text(json.dumps(result['diagnostics'],indent=2,default=str))
    (args.output/'evaluation.json').write_text(json.dumps(result['evaluation'],indent=2,default=str))
```

## Appendix B. Focused dependencies

Use Python 3.12. Save this as a requirements file and install it with pip. These are the direct runtime libraries, with versions verified in the implementation environment. The full experimental application's unrelated packages are deliberately omitted.

```text
music21==9.9.2
synctoolbox==1.4.2
librosa==0.11.0
numpy==2.4.6
pandas==2.3.3
scipy==1.18.1
soundfile==0.14.0
```

For the included tests, also install pytest. No Streamlit, Plotly, notation renderer, MIDI renderer, or soundfont is required to compute this alignment. A web application can consume the returned tables independently.

## Appendix C. Focused verification

Save the following as `test_integrated_original.py` next to the standalone module and run `python -m pytest test_integrated_original.py`. These tests exercise the selected DTW cost normalization and active sparse direct optimizer. They do not import any other project version.

```python
import numpy as np
import pandas as pd
import pytest
from scipy.optimize._numdiff import approx_derivative
from integrated_original import _solve_cost, _direct_residual_jac, optimize_cost_times_direct

def test_uniform_mismatch_is_not_discounted_by_compressing_score_time():
    result = _solve_cost(np.full((101, 250), 0.2), top_k=1)
    assert result['cost'] == pytest.approx(0.2)

def test_worse_later_compressed_passage_cannot_beat_better_earlier_match():
    cost = np.full((101, 260), 10.0)
    cost[np.arange(101), 10 + np.arange(101)] = 0.2
    cost[np.arange(0, 101, 2), 180 + np.arange(51)] = 0.24
    result = _solve_cost(cost, top_k=1)
    assert result['start'] == 10
    assert result['end'] == 110
    assert result['cost'] == pytest.approx(0.2)

def test_sparse_direct_jacobian_with_pause_matches_finite_difference():
    rng = np.random.default_rng(92)
    x = np.r_[0.2, 1.1, 2.3, 3.4, 4.5, 0.2]
    kw = dict(costs=rng.random((7, 40)), origins=np.zeros(7), step=0.2, left=np.array([0, 0, 1, 1, 2, 2, 3]), fraction=np.array([0.1, 0.4, 0.2, 0.7, 0.3, 0.8, 0.5]), nominal=np.ones(4), weights=np.array([1.0, 0.25, 1.0]), spacings=np.array([0.8, 1.0, 1.2]), regularization=0.25, initial=np.array([0.0, 1.0, 2.0, 3.0, 4.0]), pause_indices=np.array([2]), initial_pauses=np.array([0.2]))
    (r, j) = _direct_residual_jac(x, **kw)
    numeric = approx_derivative(lambda p: _direct_residual_jac(p, **kw)[0], x)
    np.testing.assert_allclose(j.toarray(), numeric, rtol=2e-05, atol=1e-07)

def test_direct_optimizer_reaches_correct_audio_not_seed():
    score = np.arange(0, 10.01, 0.05)
    knots = np.arange(11.0)
    audio = np.arange(0, 14, 0.025)
    costs = (audio[None, :] - (score[:, None] + 1.2)) ** 2
    (result, d) = optimize_cost_times_direct(score, np.zeros(len(score)), costs, 0.025, knots, knots + 0.3, np.ones(10))
    assert d['accepted'] and d['converged']
    assert np.max(np.abs(result - (knots + 1.2))) < 0.03

def test_tempo_integral_stable_when_mesh_is_refined():
    penalties = []
    for count in (40, 80, 160):
        q = np.linspace(0, 10, count + 1)
        h = np.diff(q)
        rates = np.exp(0.1 * (q[:-1] + q[1:]) / 2)
        times = np.r_[0, np.cumsum(h * rates)]
        kw = dict(costs=np.ones((1, 2000)), origins=np.zeros(1), step=0.02, left=np.array([0]), fraction=np.array([0.0]), nominal=h, weights=np.ones(count - 1), spacings=(h[:-1] + h[1:]) / 2, regularization=0.25, initial=times, pause_indices=np.array([], int), initial_pauses=np.array([]))
        (r, _) = _direct_residual_jac(times, **kw)
        penalties.append(float(np.sum(r[2:2 + count - 1] ** 2)))
    np.testing.assert_allclose(penalties, [0.0025] * 3, rtol=1e-09)
```

### End-to-end smoke check

The following optional check generates a small score and matching synthesized test signal, then runs the one included method through parsing, features, broad search, and joint optimization. The test signal is a verification fixture only, not an additional alignment method. It checks valid output, not orchestral accuracy. Save as `check_end_to_end.py` and run with Python.

```python
from pathlib import Path
import tempfile,io
import numpy as np
import soundfile as sf
from music21 import stream,note,meter,tempo
from integrated_original import run_original_search
score=stream.Score();part=stream.Part();pitches=[60,64,67,62,65,69,59,62,67,60,64,67]
for bar in range(3):
 m=stream.Measure(number=bar+1)
 if bar==0:m.append(meter.TimeSignature('4/4'));m.append(tempo.MetronomeMark(number=60))
 for pitch in pitches[bar*4:bar*4+4]:m.append(note.Note(pitch,quarterLength=1))
 part.append(m)
score.insert(0,part)
with tempfile.TemporaryDirectory() as d:
 path=Path(d)/'score.musicxml';score.write('musicxml',fp=str(path));raw=path.read_bytes()
sr=22050;y=np.zeros(sr*14)
for i,pitch in enumerate(pitches):
 t=np.arange(sr)/sr;f=440*2**((pitch-69)/12)
 y[sr+i*sr:sr+(i+1)*sr]=.1*np.sin(2*np.pi*f*t)*np.minimum(t/.02,1)*np.minimum((1-t)/.02,1)
buf=io.BytesIO();sf.write(buf,y,sr,format='WAV')
r=run_original_search(raw,buf.getvalue(),'.musicxml',progress=lambda _:None)
a=r['mapping'].to_numpy()
assert np.isfinite(a).all() and np.all(np.diff(a[:,0])>0) and np.all(np.diff(a[:,1])>0)
print('Standalone full pipeline passed:',len(a),'mapping positions; coverage',r['coverage'])
```

### Verification of this focused edition

On November 2, 2026, the module and checks were extracted from this document into an empty temporary directory. All five focused tests and the end-to-end generated-score/audio smoke check passed in the existing Python 3.12 environment, without importing project code from the original checkout. This confirms the included code is self-contained for those checks. The complete Hallé recording was not re-aligned for this documentation-only change; no historical application results were replaced.
