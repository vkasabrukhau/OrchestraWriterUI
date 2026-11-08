# Handoff log — sulaiman/audio-to-score

Append-only. Newest entry at the bottom. Written by `/handoff`.

---

## 2026-11-08 — Transcribe tested end to end; names, order, exact sync, reload-safe

**Done**
- `ml/server.py`: parts get real names, standard abbreviations ("Hn.", "Cb.", was `name[:6]` → "French", "Contra") and their GM program, in score order (winds → brass → percussion → harp/keys → strings); drums keep their hits (`chordify()` dropped them); unlisted "program <n>" tracks are named by MuScriptor group. Bar lines follow the tracked beats (`tempo_map` back to MuScriptor's default) and the result carries `measureStarts`, each measure's start in recording seconds from the MIDI's tempo map + bar-offset marker.
- `services/transcribe-score.ts`: after the parse, `measureStarts` is saved as the project's sync (method `transcription-beats`, 100%), skipped if measure counts disagree. Starting while one runs answers the running job; `{resume: true}` only reattaches (404 if none).
- `projects.ts` / `domain.ts`: summary has `transcribing` and statusDetail "Transcribing the recording". `ImportPage` reattaches to a running transcription after a reload.
- Tests: `tests/api/transcribe-score.test.ts` (fake service), opt-in `tests/e2e/transcribe.spec.ts` (`E2E_TRANSCRIBE=1`).

**Decisions**
- Sync for a transcribed score comes from the transcription's own beat grid, not the DTW aligner ("Re-run auto-alignment" still switches to DTW). Constant-tempo export was dropped: on a slowing performance it put bar lines up to 1.2 s off the downbeats and notes on wrong beats (synthetic check).

**Open questions / blockers**
- STATE.md open question 6 (keep / surface / remove transcription) still stands; this stays experimental.
- No harpsichord was heard in Brandenburg 3 with "Strings + keyboard"; model limit.

**Next steps**
1. Decide question 6; if kept, an ADR for the ML sidecar (weights are CC BY-NC).
2. Optional: show part count / "aligned from transcription" in the Import card after a transcription.

**Verified by**
- `npm run typecheck`, `npm run lint`, `npm test` (289 passed), `npm run test:api` (60 passed, incl. 3 new).
- `E2E_TRANSCRIBE=1 npx playwright test tests/e2e/transcribe.spec.ts`: orchestral 1:34 MP3 (9 parts, 41 bars, 1.1 min) and Bach Brandenburg 3 / I, 5:19 with `strings` (4 parts, 138 bars, 11.2 min); both pass, including reload mid-transcription and Sync opening at 100%, 0 to check.
- Synthetic MuScriptor MIDI: measure starts within 0.5 ms of the true downbeats (steady and rubato).

## 2026-11-08 — Bar corrections and "approximate" warnings for transcribed scores

**Done**
- `ml/server.py`: `/score` returns the transcription itself (cleaned notes + beat grid) and warnings; new `POST /rebar` rewrites the score from it with corrected bars (time signature, bar lines moved by whole tracked beats, half/double tempo) through the same `_render`, no model. Unknown meter is now 4/4 anchored on the tracker's first downbeat (was: from the first note). `ml/tests/test_render.py` (13 tests, `npm run ml:test`).
- Server: migration `20261108_01_project_transcription.sql` (`app.projects.transcription`); the transcription JSON lives in S3 next to the score; `POST /api/projects/:id/transcription/bars`; uploading a score or changing the recording clears it. `project.transcription` on the summary.
- Import page: "Transcribed from the recording" panel under the parsed score with the warnings and Bars controls (Apply rewrites + re-syncs).

**Decisions**
- Corrections move bar lines, never notes, so the visualization timing never changes; the shift is kept within one bar (one beat earlier = meter − 1 beats later) and counted in tracked beats, not tempo averages (an average drifts off them under rubato).
- Rhythm is flagged "approximate" when MuScriptor finds no beat subdivision the onsets sit on (|R| < 0.5), not guessed at.

**Open questions / blockers**
- STATE.md open question 6 still open (wording updated in this PR).

**Next steps**
1. Optional: a downbeat control on Sync, where you can hear the bars, instead of Import.

**Verified by**
- `npm run typecheck`, `npm run lint`, `npm test` (289), `npm run test:api` (63, 6 for transcription), `npm run ml:test` (13).
- e2e `transcribe.spec.ts` on the orchestral clip: warning shown, 3/4 + 1 beat later → 41 → 57 bars, Sync 100%.
