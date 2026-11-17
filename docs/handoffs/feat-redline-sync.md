# Handoff log — feat/redline-sync

Append-only. Newest entry at the bottom. Written by `/handoff`.

---

## 2026-11-15 — Integrated aligner matches the Python reference; markers can re-time any stretch

**Done**
- Score parser (`src/shared/score/parse.ts`, `info-map.ts`):
  - honours `<direction><offset>`. This was the main cause: the Tchaikovsky 6 clock was 1313 s instead of 963 s;
  - re-times mixed-meter bars (12/8 against 4/4) per voice from note types;
  - emits `Note.staff`, `Note.unpitched` and the optional `timing.expression` (per-staff dynamic marks as music21 scalars, plus hairpins).
- Aligner features:
  - `integrated/filterbank.ts`: an exact port of Sync Toolbox's pitch filterbank and tuning for the recording chroma;
  - `features.ts`: score chroma and loudness follow the reference;
  - `range.ts`: slices `timing.expression`.
- Aligner search:
  - a 10 Hz banded pass between the broad match and the fit (`refineSeed`, `bandedDtw`);
  - DTW jumps for recording material the score lacks or score the recording skips;
  - fit continuity dropped across jumps.
- Markers:
  - `anchors.ts`: anchor correction tapers out over 30 s; new `localizeMarkerRun` and `changedMarkerBars`;
  - `sync-function.ts` and `lib/api/http.ts`: `runSync` gets the previous markers and method, and keeps a marker-only run's changes where the markers reach.
- Tools and docs:
  - `scripts/eval-real.ts`: compares an aligner on a real pair with a reference table;
  - ADR 0024, and the sync rule updated.

**Decisions**
- ADR 0024 (amends 0014 and 0021).
- Hairpins deliberately do not copy the reference's music21 wedge-pairing bug.
- Rejected after measurement, with numbers in the ADR: instrument-overtone score chroma (a "better synth"), a pitch-class onset cue, and a lower attack exponent.

**Open questions / blockers**
- Scores imported before this branch keep the old info map. Re-import them to get the fixed clock. Should the app re-parse on load when `timing.expression` is missing?
- There is no hand-annotated truth: accuracy is measured against a consensus of two independent methods. Hand-marking bars of one real recording would settle the remaining disputed bars (Tchaikovsky 270–275, Romeo and Juliet 264–267).
- Redline still ignores markers (ADR 0023).
- The redline source license is still unconfirmed.
- An independent reviewer was still running at the time of this entry. Its notes in `.claude/agent-memory/reviewer/` are uncommitted; commit them in this branch's PR.

**Next steps**
1. Act on the reviewer's findings, then rerun the commands below.
2. Try the Sync page in the browser on the Tchaikovsky pair: re-import the score, run Smooth, add a marker, recompute, and check that only nearby bars move.
3. Decide on re-parsing old info maps.
4. If accuracy work continues, hand-annotate about 50 bars of one recording, then retest the onset cue against that truth.

**Verified by**
- `npx vitest run tests/unit`: 407 passed (35 files).
- `npm run typecheck` and `npm run lint`: clean (only untracked `scripts/_tmp_*` fail, and they are not committed).
- `npx tsx scripts/eval-real.ts <T6 score> <Hallé mp3> --ref <python measures.csv> --rate 44100`: median 4 ms from the Python reference.
  - Consensus (reference + MrMsDTW, 290 bars): 288 within 100 ms, mean 21 ms. Before the branch it was off by a mean of 16 s.
- Romeo and Juliet (live, held out; consensus of MrMsDTW + redline, 426 bars): 393 within 100 ms, mean 39 ms (366, 75 ms before the 10 Hz pass).
- Edited recordings: 30 s played twice aligns without markers (1 bar off by more than 300 ms). A 30 s cut reaches 285/285 within 100 ms after 4 simulated markers.
- `npx tsx scripts/eval-align.ts`: synthetic demo 55–56/56 bars within 150 ms.

## 2026-11-15 — Review fixes (f00c593)

**Done**
- An independent review found nothing blocking. Its two should-fix bugs are fixed, with tests:
  - fit breaks come from the banded DTW's actual jump steps (slope guessing switched continuity off in marker-corrected stretches);
  - hairpins that stop at the next barline are no longer dropped.
- Also fixed:
  - fallback flag on localized marker runs;
  - `resampleTo` moved to `src/lib/align/resample.ts`, so the integrated aligner no longer depends on redline;
  - filterbank work buffer in float32 (still bit-identical to the reference);
  - license attribution for the ported filterbank code;
  - linear dynamic fill;
  - band-limited jump tracker;
  - end extension that ignores a final jump;
  - capped fence-only band.
- The reviewer's agent memory is committed with it.

**Decisions**
- ADR 0024 updated: licenses, `<offset>` following music21, memory, breaks.

**Open questions / blockers**
- Review nits left open (all minor):
  - Mixed-meter bars take part 0's time signature as the bar length, which is wrong for a pickup bar in a mixed-meter score.
  - `<forward>` in a 12/8 voice isn't counted in that voice's typed length.
  - In a range run, a hairpin that starts before the slice reads its start level at the slice edge.
  - The mock API doesn't model localized marker runs.
- Earlier questions still stand: re-parsing old info maps, hand-annotated truth, markers in redline.

**Next steps**
1. Try it in the browser (re-import the Tchaikovsky score, run Smooth, add a marker, recompute).
2. Open the PR for this branch when ready (not done here).

**Verified by**
- `npx vitest run tests/unit`: 410 passed.
- typecheck and lint clean.
- Fresh `scripts/eval-real.ts --rate 44100` on both real recordings:
  - Tchaikovsky 6: 288/290 consensus bars within 100 ms, mean 21 ms, median 4 ms from the Python reference, 22 s.
  - Romeo and Juliet: 393/426, mean 40 ms, 26 s.
- Edited recordings: passage played twice 281/285; cut with two markers 283/285.
