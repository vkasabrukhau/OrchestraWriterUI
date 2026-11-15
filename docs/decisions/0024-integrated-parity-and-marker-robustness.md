# 0024. Integrated aligner: parity with the Python reference, a 10 Hz pass, DTW jumps and local marker runs

Date: 2026-11-15
Status: proposed (amends 0014 and 0021)

## Context
On the same score and recording (Tchaikovsky 6 first movement, Hallé, 354
bars, 18 minutes), the Python "Integrated tempo from original search"
(`docs/research/score-sync-lab/`) aligned much better than our port. Against
the reference's own result the port was off by a mean of 16 s (max 81 s).
Markers (ADR 0021) also had gaps:
- a set of markers could leave the DTW no path ("No path within the tempo constraints"), so the app fell back to chroma DTW;
- a marker could move bars far from it.

How we measured. There is no hand-annotated truth, so:
- **Parity**: per-bar difference from the reference's `measures.csv` (run with the reference venv), and stage-by-stage feature diffs against its dumped arrays.
- **Accuracy**: bars where two independent methods agree within 150 ms are a consensus truth.
  - Tchaikovsky 6: the reference and Sync Toolbox MrMsDTW with DLNCO onsets, 290 bars.
  - Romeo and Juliet, held out: a live concert recording. The reference crashes on that score (music21 `PercussionChord`), so the consensus is MrMsDTW and our redline port, 426 bars.
- **Markers and structure**: the Hallé recording edited with ffmpeg, either with 30 s played twice or with 30 s cut. The truth is the consensus shifted by the edit.

`scripts/eval-real.ts` runs an aligner on a real pair and compares it with a reference table.

## Decision

### 1. Parity fixes (cause → fix)
- **Score clock** (the 16 s): the parser ignored `<direction><offset>`.
  - Stepped ritardandos written at the end of a bar landed on the next barline, and "first part wins" dropped the following tempo. Bar 161 stayed at 32 bpm for 62 bars, so the score clock was 1313 s instead of 963 s.
  - Directions now sit at cursor + offset.
- **Mixed meter** (bars 130–142, 12/8 against 4/4): the exported `<duration>` values do not add up.
  - In bars whose parts use different meters, each voice is now re-timed from its note types onto the shared bar, as the reference's `normalized_xml` does.
- **Recording chroma**: Sync Toolbox's multirate elliptic filterbank with integer-cent tuning, ported exactly (`filterbank.ts`).
  - With the same decoded samples it is bit-identical to the reference; with ffmpeg decoding the correlation is 0.998.
  - The old 186 ms STFT had 5.4 Hz bins and could not separate semitones below about MIDI 50.
- **Score chroma**: Sync Toolbox `df_to_pitch_features` with `ignore_velocity`.
  - Each sounding pitch marks every 40 ms window it touches once, so unisons across parts count once.
  - Unpitched percussion is excluded (new `Note.unpitched`).
  - A chroma frame with no entry above 0.001 quantizes to zeros, not the uniform vector: silence is no evidence.
- **Score loudness**: per staff (new `Note.staff`), dynamic marks with music21 scalars (ppp–ffff and sf/fp kept apart) and hairpins.
  - These live in the optional, sync-only `infoMap.timing.expression`. Info maps saved before it fall back to the notes' dynamics.
  - **Deliberate difference**: music21 completes a wedge stop against the first open wedge of that number anywhere in the score. Once one wedge is left open, every later hairpin in a part ends at the next one's stop, and some reference hairpins last over 100 s. Ours span their own start and stop.

Result (`44c3f5a`): median 4 ms from the reference, 312/354 bars within 50 ms. Where we still differed, MrMsDTW sided with us on bars 76–77, 185–188 and 340, and with the reference on 233–236 and 302–303.

### 2. A 10 Hz banded pass between the broad match and the joint fit (`refineSeed`)
- On bars 232–236 the 2 Hz broad path settled 1.5–2 s off, although the right timing costs less under the same joint cost (0.275 vs 0.293).
- The fit searches ±4 s around its seed with tempo continuity, so it stayed in that basin.
- The same cost and DTW steps at 10 Hz, inside ±4 s of the broad path, fix it.

| | Tchaikovsky 6 (290 consensus bars) | Romeo and Juliet (426) |
|---|---|---|
| ≤ 100 ms before | 281, mean 50 ms | 366, mean 75 ms |
| ≤ 100 ms after | **288**, mean 21 ms | **393**, mean 39 ms |

### 3. DTW jumps
Both DTWs may jump over:
- recording material the score lacks: from row i − 1, any column ≤ j − 3;
- score the recording skips: from column j − 1, any row ≤ i − 3.

A jump costs 4 cost·s, plus 0.5 per skipped score row (no evidence), plus the cell. The joint fit drops tempo continuity across a jump in its seed: it is a break in the music, not a tempo change.
- **Normal recordings**: unchanged, bit-identical results on both pieces for penalties 2–5. A penalty of 10 never fired.
- **30 s played twice**: aligns without markers; bars off by more than 300 ms go from 13 to 1, mean 619 → 22 ms.
- **30 s cut**:
  - Compression (2× score speed) still absorbs it without markers, with 7 bars off.
  - One marker after the cut fixes everything after it; markers on both sides give 283/285 within 100 ms.
  - Before this change, that marker pair left no path and fell back to chroma DTW.

### 4. Markers re-time as far as they reach, and no further
- `anchorMapping` fades a marker's correction out over 30 s beyond the outermost marker. Before, it shifted the whole piece by the coarse path's slack at the marker.
- **`localizeMarkerRun`** (in `runSync`, when only the markers changed and the method did not):
  - The new timing is taken across the stretch connected to each changed marker: the bars that moved more than 50 ms from the previous run, plus one bar.
  - The previous timing stands elsewhere.
  - A marker that exposes a large error re-times as far as the departure runs, up to the whole piece.
- Simulated user on Romeo and Juliet (mark the worst consensus bar, rerun):
  - Without locality, a marker could make up to 2 other bars worse by more than 50 ms, one of them 70 bars away.
  - With it, none after the second marker; 393 → 399 bars within 100 ms after 8 markers.
- On Tchaikovsky 6, two markers give 290/290.

### Investigated and not adopted
- **Instrument overtones in the score chroma** (a better "synth"): each note given its family's harmonic spectrum, projected onto the filterbank's pitch bands.
  - It raised score/recording chroma similarity at the true timing (0.794 → 0.803) but lowered the margin against timings 0.25–2 s off by 8–10%.
  - End to end, every variant was worse:
    - Tchaikovsky 6: 277–282 vs 288 bars.
    - Romeo and Juliet: 388–391 vs 393.
    - Variants tried: overtone gain 1, 0.3 and 0.1, with and without dynamics weighting.
  - On real orchestral recordings the harmonics blur pitch classes more than they help. This matches the research repo's FluidSynth reference result.
- **A pitch-class onset cue** (DLNCO-like: the recording's rise in log pitch-band energy against the score's note starts).
  - In isolation it separates the true timing from ±0.1–0.5 s far better than the broadband attack cue, whose margin is slightly negative.
  - End to end, weight 0.15 was neutral. At 0.3 and above it hurt: the duplicated-passage recording went from 281 to 230 of 285.
- **Exponents for the score attack/level model**: an exponent of 1 instead of 2 fixed Tchaikovsky bars 233–236 but was worse on Romeo and Juliet. It was superseded by the 10 Hz pass.

## Consequences
- **Run time**: about 21 s for 18 minutes in Node, up from 14–17 s (the filterbank takes 11 s). The 10 Hz pass adds about 1 s.
- **Memory**: jumps add an Int32 origin per broad-match cell (up to 32 MB at the 8 M cell limit) and a Float64 per band cell.
- **Re-import needed**: scores imported before this change keep their old info map (no direction offsets, no mixed-meter re-timing, no `timing.expression`). Re-import a score to get the fixed clock; the Tchaikovsky 6 clock was 36% too long.
- **The parser fixes reach beyond sync**: generated playback and score-time positions now follow `<offset>` tempo and dynamics marks and mixed-meter bars.
- **Confidence** is still the heuristic of ADR 0014. It is computed against the 10 Hz seed.
- **Open**:
  - The remaining errors are model-limited. On Romeo and Juliet bars 264–267 and 33, our timing costs no more than the consensus under our own cost.
  - A cut without markers is still spread over the neighbouring bars.
  - Redline does not take markers.
  - Hand-annotated bars for one real recording would replace the consensus truth.
