# Milestone 2 progress report: Orchestra Visualizer

**Team:** Megala Sivasankar · Lucas Sasaya · Valiantsin (Val) Kasabrukhau ·
Xuerui (Sherry) He · Zehavi Rodriguez · Stella Wang · Sulaiman Khydyr uulu

**Period:** Milestone 1 (2026-10-26) to Milestone 2 (2026-11-16)

Most of this period went into the two things the feedback pointed at: making
sync work on real orchestral recordings, and making each user correction feed
back into the matching. We also redesigned Customize and put the app on AWS.
Where a result lives on a branch that hasn't merged yet, we say so.

## 1. Response to the course staff's Milestone 1 feedback

**1. Use confirmed points to constrain the matching. Done on `main`.**
- A marker is now a fixed anchor *inside* the aligner (ADR 0021). The search
  can't cross it, and the tempo is re-fitted around it. At MS1, markers only
  re-timed nearby bars afterwards.
- A recompute can run on just a range of bars (ADR 0019), so two markers
  define a smaller segment to rematch.
- Markers can be placed on any note, in the engraved score or on a piano
  roll over the waveform. They wait for a recompute (ADRs 0018, 0020).
- On `feat/redline-sync`, each correction changes only the stretch it
  affects (ADR 0024). We simulated a user who corrects the worst bar of a live
  *Romeo and Juliet*, eight times. After the second marker, no correction made
  another bar worse, and bars within 100 ms went from 393 to 399 of 426.

**2. Does confidence point to the mistakes? Repeated passages? Partly done.**
- We now test on real recordings (`scripts/eval-real.ts`):
  - **Tchaikovsky 6/I** (Hallé, 354 bars): 288/290 bars within 100 ms. At
    MS1, the mean error was 16 s, mostly from two parser bugs we fixed.
  - **Live *Romeo and Juliet*:** 393/426 bars within 100 ms.
- We stress-tested with an edited recording:
  - *30 s played twice:* the aligner can now skip extra material. With no
    markers, bars off by more than 300 ms dropped from 13 to 1.
  - *30 s cut:* one marker on each side of the cut gives 283/285 bars within
    100 ms.
- **Not yet measured:**
  - whether low confidence lands on the wrong bars;
  - how many corrections, and how much time, a user needs.

  Our current truth is two methods agreeing, not hand-placed bars. Hand
  annotation and these metrics are in the final plan (§5, must-haves 2–3).

**3. Instrument signals and source separation. Small experiments done;
separation not tried.**
- We tested two richer instrument cues: family overtones in the expected
  sound, and a pitch-class onset cue. Both made accuracy worse end to end
  (ADR 0024).
- A separation run on the disputed stretches is listed as optional (§5).

**4. A small language for mapping musical events to visuals. Design work
only so far.**
- The Sync piano roll already shows the same info map a second way, close
  to the Music Animation Machine: time → x, pitch → y, section → color.
- A pitch-encoding mockup compares pitch → lightness with pitch → seat
  position.
- For the final, we'll add rules of the form `event filter → feature →
  visual channel` and ship two visualizations built from them (§5,
  must-have 4).

**5. Motifs. Not started.** This is planned as an advanced feature (§5):
first, mark a motif and its occurrences by hand, then search for them
automatically. The search matches interval and rhythm, so transposed
returns still count.

**6. What does the visualization help people understand? Study not run
yet.** We'll compare tasks **with and without** the visualization:
- name the section that's playing;
- follow instrument entrances;
- recognize a returning theme;
- answer rehearsal-prep questions;
- fix the sync on a real recording.

The results should settle which audience we design for (§5, must-have 3).

## 2. Changes to the project idea since Milestone 1

The core idea is unchanged. These are the changes to scope and approach:

| Area | At MS1 | Now | Why |
|---|---|---|---|
| Sync method | Chroma DTW (ADR 0009) | **Integrated tempo aligner** (ADR 0014): chroma, loudness, attacks and rests, with a whole-piece search and a tempo-continuity fit. Chroma DTW is the fallback. | Chroma DTW alone was not reliable on a full 18-minute movement |
| Corrections | Bar-level nudges, merged after the run | **Note-level markers** that are pending until a recompute, used as **anchors inside** the aligner, with range recomputes (ADRs 0018, 0019, 0021) | Staff feedback 1, and markers that moved timing on every edit were hard to use |
| Score view | Schematic strip; engraved notation was later phase | **Engraved score** (OpenSheetMusicDisplay, BSD-3) laid out as pages that follow playback (ADRs 0015, 0016) | A schematic strip couldn't be read as music, and users place markers on real notes |
| Sync page | One column of controls | A **workspace** with resizable panes: confidence map, score, piano roll over the waveform, sidebar (ADRs 0017, 0020) | Users need to see and hear the score and the recording together |
| Customize | A settings form | A **desktop-style editor** with menus, undo/redo, part lanes and a properties panel, matching the Sync frame (ADRs 0022, 0023) | Built from the team's Figma mockup; 64 parts need real editing tools |
| Visual mapping | Fixed: brightness = dynamic, hue = section | Still the default, but we now plan a **small rule language** with a second visualization for the final | Staff feedback 4 |
| Musical structure | Not planned | **Motif highlighting** planned as an advanced feature | Staff feedback 5 |
| Score-less projects | Score required | Experimental **transcription** from audio alone, on a branch | Lets someone without a score start a project; whether to keep it is still open (STATE.md question 6) |
| Deployment | Deploy workflow written, never run | Running on **AWS App Runner** with Aurora Postgres and S3, deployed from `main` by GitHub Actions | Needed for the user study |

## 3. Progress since Milestone 1

**Merged to `main`** (PRs #3, #4, #6, #7, #8, #9 and the Customize redesign):

- **Sync, rebuilt:**
  - integrated tempo aligner in the Web Worker;
  - markers as anchors, pending-until-recompute, range runs;
  - Sync workspace with a confidence map, engraved score and piano roll
    over a zoomable waveform (min/max peak pyramid);
  - marker popover, right-click menu, undo, recompute suggestion and
    continue guard;
  - playback speed for the recording;
  - ADRs 0014–0021.
- **Engraved score:**
  - OpenSheetMusicDisplay pages laid out once, so zoom and resize don't
    re-render;
  - follows playback, can be browsed independently, note-level click
    targets;
  - schematic fallback.

  This was tested on a 42-part, 480-bar stress score.
- **Customize, redesigned as an editor:**
  - menus and tool bar driven by one command list;
  - 100-step undo/redo with gesture grouping;
  - Instruments panel with live per-part status, Properties panel, part
    lanes, draggable panel borders;
  - narrower tints, a color-blind-safe palette, responsive layouts down to
    390 px;
  - 64 parts at 60 fps on a fast machine;
  - ADRs 0022–0023.
- **Infrastructure:**
  - the repo connected to the shared AWS stack (Aurora, S3, ECR, App
    Runner, GitHub OIDC deploy role);
  - App Runner right-sized to 1 vCPU / 2 GB;
  - the image build fixed;
  - deploys fail on an App Runner rollback;
  - a health response on `GET /`;
  - `npm run dev:aws` for local development against AWS.

**On branches, to merge for the final:**

- `feat/redline-sync`:
  - aligner parity with the Python reference;
  - parser fixes for `<offset>` and mixed meter;
  - an exact port of Sync Toolbox's filterbank;
  - a 10 Hz refinement pass, DTW jumps and localized marker runs;
  - `scripts/eval-real.ts`;
  - recording playback from decoded audio;
  - a second selectable aligner;
  - a Tchaikovsky 6 sample project.

  Results are in §1 (point 2). These are ADRs 0023–0025 on that branch; they need
  renumbering, because `main` also has a 0023.
- `sulaiman/audio-to-score`:
  - transcription with MuScriptor on an on-demand g4dn GPU instance that
    stops itself after 15 idle minutes;
  - instrument presets;
  - bar corrections;
  - the transcription's beat grid as the project's sync.

  It was tested end to end on an orchestral clip and Bach's Brandenburg 3/I.
- `test/ui-orchestra-screen`: the pitch-encoding study (§1, point 4).

**Quality:**

- `npm test` today: **466 unit and component tests** pass in 51 files, up
  from 289 at MS1. The 52nd file, a jsdom suite, needs Node 24 as in CI.
- The redline branch adds tests and passes 410 unit tests.
- At the sync-revamp merge, 57 API integration tests and the Playwright
  suite passed. The suite is now 15 tests, including new
  `sync-workspace` and `customize-editor` specs.
- CI runs lint, typecheck and all suites on every pull request.
- Every branch has a handoff log in `docs/handoffs/`, and every non-trivial
  decision has an ADR (23 on `main`, up from 13).

## 4. Contributions in this period

> **TODO (team):** each person, please check your row and add anything
> missing before we submit. Rows marked *(from git)* were drafted from the
> repository history. Work outside the repo (Figma, Jira, meetings,
> interviews, research) isn't in git, so it isn't captured yet.

| Teammate | Contributions since MS1 |
|---|---|
| Megala Sivasankar | Designed high-fidelity UI/UX mockups and interactive prototypes in Figma for the music notation editor. Developed reusable components, navigation flows, and interface specifications for the Customize and Sync workspaces. Collaborated with the development team to translate designs into functional requirements and ensure UI consistency. |
| Lucas Sasaya | Ported the integrated tempo aligner to the browser. Added the engraved score (OSMD) and score navigation. Rebuilt the Sync page as a workspace: confidence map, piano roll over the waveform, note-level markers, pending markers, range runs, markers as anchors inside the aligners. On `feat/redline-sync`: real-recording evaluation (Tchaikovsky 6, *Romeo and Juliet*, edited repeat/cut recordings), parser fixes, aligner parity with the Python reference, DTW jumps, localized marker runs, playback from decoded audio, the Redline aligner port and the sample project. Wrote ADRs 0014–0021 and the branch's 0023–0025, and the visualization feature brief and product spec in `docs/research/390-sharing/`. |
| Valiantsin (Val) Kasabrukhau | Worked on making sure that CI was pulled in properly, conducted subtractive changes on the code and streamlined the repo. Helped Lucas with audio syncing and merged Lucas’s changes for the mechanics in with the rest of the UI and AWS CI/CD changes. |
| Xuerui (Sherry) He | Redesigned Customize as a desktop-style editor from the Figma mockup: menu bar and tool bar on one command list, undo/redo, Instruments, Properties and part-lane panels, narrow layouts, tints and the color-blind-safe palette. Fixed the reviewer's findings, measured 64-part performance, and made Customize consistent with Sync with draggable panel borders. Wrote ADRs 0022–0023. Built the pitch-encoding study mockup. Prepared the MS1 and MS2 submissions. |
| Zehavi Rodriguez | **TODO** |
| Stella Wang | Updated the UI design principles and color choices, worked closely with Lucas to iterate on multiple different visual directions, prototyped interactions to get a feel for the user experience |
| Sulaiman Khydyr uulu | Connected the repo to the shared AWS stack. Right-sized and fixed the App Runner deployment: image build, rollback detection, `0.0.0.0` binding, `GET /` health. Added `dev:aws`. On `sulaiman/audio-to-score`: built the experimental transcription pipeline, with MuScriptor on an on-demand GPU instance, part naming and ordering, beat-grid bar lines, bar corrections, sync from the transcription, and API and e2e tests. |

## 5. Plan for the final submission

### Must-have (basic) features

1. **Merge the sync accuracy work.** Merge `feat/redline-sync` into `main`.
   - Renumber its ADRs.
   - Re-parse old info maps that lack the new timing data.
   - Decide whether the Redline aligner stays (its license is unconfirmed).
   - Check it in the browser on the Tchaikovsky project.
2. **Ground truth and confidence calibration (staff feedback 2).**
   - Hand-annotate about 50 bars of at least two real recordings, including
     a repeated passage.
   - Report the timing error and the precision and recall of
     "Next uncertain".
   - List the confidently-wrong bars and retune the confidence heuristic.
3. **User study (staff feedback 6).** Run the with/without protocol in §1 (point 6)
   with both audiences on the deployed app, and log corrections and time on
   Sync. The results settle the audience question and rank items 4–6 and
   the optional list.
4. **Visual mapping rules, version 1 (staff feedback 4).**
   - Write an ADR that replaces the fixed encoding with a small,
     declarative rule set read by the `FrameEngine`.
   - Ship two built-in visualizations of the same info map: the seating-plan
     glow (the default, with brightness = dynamic as now) and a scrolling
     piano-roll view.
   - Both export to MP4.
5. **Finish what's open from MS1.**
   - A compact label for 64-part crowded columns.
   - A Preview performance pass (10 fps at 4× throttle today).
   - Safari and Firefox checks.
   - The rate limiter behind the App Runner proxy.
   - A per-user storage quota.
6. **Decide on transcription** (STATE.md question 6). Merge it as an
   experimental Import option, or drop it. Either way, record the decision
   in an ADR; the model weights are CC BY-NC.

### Optional (advanced) features

1. **Motif highlighting (staff feedback 5):**
   - mark a motif and its occurrences manually in the engraved score;
   - highlight each occurrence on the stage as it moves between instruments;
   - then suggest occurrences automatically, with transposition-invariant
     interval and rhythm search over the info map.
2. **More mapping rules:** pitch → height in seat or lightness (from the
   pitch study), articulation → motion, and user-editable rule sets saved
   in the project file.
3. **Source-separation experiment (staff feedback 3):** separate stems for
   the disputed stretches only, and add per-section chroma as an aligner
   cue. Adopt it only if it moves the hand-annotated numbers.
4. **Rigid sync method** (shown disabled today), and markers for the Redline
   aligner.
5. **Password reset** with an email provider.
6. **Earlier backlog:** public share pages, other score formats
   (Sibelius, PDF), publishing to YouTube.
