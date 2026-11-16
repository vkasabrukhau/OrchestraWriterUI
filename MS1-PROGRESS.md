# Milestone 1 progress report: Orchestra Visualizer

**Team:** Megala Sivasankar · Lucas Sasaya · Valiantsin (Val) Kasabrukhau ·
Xuerui (Sherry) He · Zehavi Rodriguez · Stella Wang

**Period:** proposal (signed 2026-10-05) to Milestone 1 (2026-10-26)

## 1. Changes to the proposal

The core idea hasn't changed: users upload a score and a recording, see which
parts play and how loud the score says they are, and export a video. Most of
the changes are in the technical plan. We made each one after we hit a
concrete problem, and each is recorded as an ADR in `docs/decisions/`.

| Proposal said | What we did instead | Why |
|---|---|---|
| "A defined notation format that can be exported from Sibelius" | **MusicXML** (`.musicxml`, `.xml`, `.mxl`), which Sibelius, MuseScore, Dorico and Finale all export | MusicXML is open and documented, and it's the one format every notation program writes. We couldn't find a maintained library that turns MusicXML into timed notes with dynamics, so we wrote our own parser and tested it on 20 quirk fixtures (ADR 0008). |
| An audio recording is required | The recording is **optional**. Without one, the app synthesizes playback from the score. | Users can start from a score alone, and the MP4 can use generated audio. This also follows the professor's suggestion (see §2). |
| Manual correction of sync issues | Automatic alignment, plus a **confidence score (0–100%) for every measure**, color-coded with red for uncertain and a "Next uncertain" button. Corrections use nudge buttons, with millisecond fields under Advanced. | A user can't fix timing they can't find. The confidence colors point them to the measures worth checking. |
| Clerk for authentication | **Better Auth** (MIT) | Our backend already used Better Auth with Postgres, and it runs in our own process with no third-party account (ADR 0007). |
| Heavy processing (audio analysis, note mapping, export) in AWS Lambda | Score parsing runs as a **server job**. **Alignment runs in a browser Web Worker** (chroma DTW), and **MP4 export runs in the browser** (WebCodecs). | The browser has already decoded the audio and already holds the renderer, so exporting there means the MP4 is drawn by the same code as Preview. It also removes the Lambda time and memory limit that our risk analysis flagged for long files (ADRs 0009, 0010). |
| Separate front end and API | **One Next.js app** with the Hono API mounted at `/api` | This gives us one dev server, one Docker image and no CORS. Deployment is to AWS App Runner (ADR 0007). |
| Three.js visuals, with assets from Blender and Illustrator | A **Canvas 2D** renderer behind a `GlowRenderer` interface | Three.js was our top implementation risk. Canvas 2D is enough for one glow per part, and the interface leaves room for PixiJS or Three.js later. We also chose a visual direction: "Concert program" (paper and ink, with a dark stage) is the default, and "One material" (all dark) is a theme (ADR 0005). |
| Local persistence only, no account | A `.ovproj` **project file** (zip) for save and open, plus **accounts with server-side projects**, a library, concert programs and export history | We integrated the team's backend, which already had accounts. The project file still works without the server copy and can be moved between accounts (ADRs 0012, 0013). |

**Features we haven't changed but haven't started:** support for other
formats (Sibelius files, PDF/scanned scores), direct Sibelius integration,
publishing to YouTube, extra visual styles and soloist positions. These are
still possible advanced features.

**Evaluation plan.** We kept the analytics, and following the critique we're
adding interviews (§2). The app already records an activity log of imports,
sync saves, display edits and exports for each user, which we can use as the
quantitative half of the evaluation.

## 2. Response to the other team's critique

**"The idea is compelling; video producers could benefit."** We agree. The MP4
export now offers 720p, 1080p and 4K at 30 or 60 fps, with either the
recording or generated audio, and the export history keeps past renders. That
should serve people who make videos. We still haven't decided between our two
audiences (new listeners vs musicians preparing a piece). This is open question
4 in `docs/STATE.md`, and the user study in §5 is how we plan to settle it.

**Professor's suggestion: map the audio to the sheet music and use the score
to generate a canonical performance.** We built this in two places:
- **Generated playback.** When there's no recording, a Web Audio synthesizer
  plays the score from the parsed information map, and the same audio can go
  into the MP4.
- **Alignment.** The aligner synthesizes what the score *should* sound like
  (chroma features from the notes, weighted by written dynamic) and matches it
  against the recording with dynamic time warping. That produces each
  measure's start time and the confidence score. On our demo piece (14 parts,
  56 bars, warped tempo), 55 of 56 measures land within 150 ms on the
  committed MP3, and all 56 land within 300 ms (ADR 0009).

**"They haven't thought about the nitty-gritty of the implementation."** That
was fair at the proposal stage. Since then we have written 13 architecture
decision records covering the stack, parser, alignment method, export pipeline,
file format and UI library. `SPEC.md` describes the architecture as it is built
today.

**Evaluation: combine analytics with interviews or short open-ended
questions.** We agree, and we've changed the plan. For each session we'll keep
the in-app activity log and pair it with a short task-based interview: "Which
section is playing now?", "Did the sync look right?", and "What confused
you?". The numbers show *where* users drop off, and the interviews tell us
*why*.

**Privacy: reusing uploads to save work, versus keeping compositions private.**
We are keeping data private and not reusing uploads between users.
- Every file is stored under `users/<id>/projects/<pid>/` in S3, and every
  database query is filtered by the signed-in user. A request for another
  user's project returns 404.
- Files are uploaded and downloaded through short-lived (15-minute) presigned
  URLs. Nothing is public, and public share pages are later-phase work.
- Deleting a project, or the account, deletes its rows and every S3 object
  under its prefix.
- The project file lets users keep their work entirely on their own machine.

**Stored user information and credit cards.** We don't take payments or store
any payment data. Better Auth stores accounts with hashed passwords and
HttpOnly session cookies. Profiles hold only what the user enters (name,
handle, role, optional bio and ensemble).

**Security against bad actors.** Beyond standard practice, the code review on
our integration branch added these protections:
- Size caps on every upload, signed into the presigned PUT: 50 MB per score,
  500 MB per recording and 2 GB per export.
- A 4 MB cap on API request bodies.
- `.mxl` decompression that only inflates the score's root entry, with a size
  cap, so a zip bomb can't exhaust memory.
- A status endpoint that, in production, hides infrastructure details
  (database host, bucket names) from anyone who isn't signed in.

Known gaps we will close before release:
- The sign-in rate limit trusts a client-supplied `x-forwarded-for` header
  until we configure it for the App Runner proxy.
- There is no per-user storage quota yet.
- Password reset needs an email provider.

## 3. Progress since the proposal

The full workflow works end to end on a local stack. A user can sign up,
create a project, import a score and recording, sync them, customize the
display, preview with audio, and export both a project file and an MP4.
Requirements 1–8 are all implemented and in review (`docs/STATE.md`).

**What exists**

- **Front end:** Next.js 16, TypeScript and Tailwind v4.
  - Screens: sign-in, sign-up, library, programs, profile and settings, plus
    the five workflow screens (Import, Sync, Customize, Preview, Export).
  - Accessible UI primitives (Radix), with loading, empty and error states on
    every screen.

- **Score engine:** a MusicXML and `.mxl` parser that produces the
  information map. It handles divisions, backup/forward, ties, tempo changes,
  repeats, transposing instruments and up to 64 parts, and classifies each
  instrument into a section.

- **Sync:** a chroma DTW aligner in a Web Worker that computes per-measure
  confidence. Manual markers are merged with the automatic result and saved,
  and re-running the aligner keeps them.

- **Visualizer:** a Canvas 2D glow renderer.
  - A labeled seating plan with drag-to-move positions and section colors.
  - Brightness follows the written dynamic, with the dynamic shown in a music
    font beside each glow.
  - A pp–fff legend and a reduced-motion mode.

- **Playback:** recording playback, or a score synthesizer when there's no
  recording. Includes current-measure highlight, click a measure to start, and
  keyboard shortcuts.

- **Export:** MP4 export in the browser (H.264 video, AAC audio), and the
  `.ovproj` project file (save and open).

- **Backend:** the team's OrchestraWriter backend (Hono, Better Auth,
  Postgres, S3), now running inside the Next.js app.
  - Stores projects, programs, exports, the activity log and storage usage.
  - Runs the score-parsing job.

- **Quality:**
  - At the merge, 289 unit and component tests, 57 API integration tests and
    12 Playwright end-to-end tests were passing (both the score-only and the
    recording workflows).
  - CI runs lint, typecheck and all test suites on every pull request, and
    there's a deploy workflow for AWS App Runner.

- **Docs:**
  - 13 ADRs, the API reference, and a research note on sync and instrument
    identification.
  - Handoff logs for every working session.

**Manual check (Chrome, local stack).** We imported the demo score (14 parts,
56 bars) and MP3. Auto-alignment averaged 99% confidence and correctly flagged
the general-pause bar as uncertain (45%). A +100 ms nudge saved a manual
marker. Dragging and recoloring both persisted, and the recording played in
Preview with the bar counter advancing. The project file came out at 787 KB,
and the 720p/30 MP4 (14.7 MB, about 70 s to render) had audio. There were no
console errors.

## 4. Contributions in this period

> **TODO (team):** each person, please check your row and add anything missing
> before we submit. The rows below come from the proposal's section owners and
> the repository history. Work done outside the repo (Figma, Jira, meetings,
> research) isn't in git, so it isn't captured here yet.

| Teammate | Contributions |
|---|---|
| Megala Sivasankar | Set up Jira epics, stories, and tasks, organized team communication and project timelines, helped plan the development roadmap, and contributed to app requirements and UI library testing. |
| Lucas Sasaya | Guided project directions and design choices based on musical background. Wrote detailed app requirements, including the complete process on how a user would use the app. Created figma screenflow. Conducted product market fit research, interviewed potential users, and narrowed project scope. |
| Valiantsin (Val) Kasabrukhau | Proposal architecture, evaluation and risk sections. Built the Next.js front end (all screens, visualizer, design tokens) and merged the OrchestraWriter backend into it: API inside Next.js, MusicXML parser, alignment, audio engines, MP4 export, project file, unit/API/e2e test suites, CI and deploy workflows, ADRs 0004–0013 (PR #1). |
| Xuerui (Sherry) He | Tested UI libraries for frontend animation and produced preliminary demos. Extracted loudness and pitch from audio. Compared library performances with stress tests. |
| Zehavi Rodriguez | Guided project direction and design choices based on musical background. Contributed to app requirements and user workflows. Worked on improving the preliminary app’s functionality and overall design. Conducted user discovery. |
| Stella Wang | Designed a spec sheet for the app that includes scope, design principles, visual directions, screen sequence, and color choices. Listed design tools and assets to direct future development. |
| Sulaiman Khydyr uulu | Wrote OrchestraWriter backend. Designed an architecture using AWS cloud and PostgreSQL.|

## 5. Plan for Milestone 2

**Make it real-world reliable**
1. **Real recordings.** Align at least three commercial orchestral recordings
   of pieces with MusicXML scores. Measure how many measures land within
   150 ms of hand-placed markers, and retune the confidence thresholds, which
   so far are tuned on synthetic audio only. If chroma DTW falls short, try the
   server-side Sync Toolbox aligner behind the existing `Aligner` interface.
2. **Real scores.** Run full symphonic scores from MuseScore and Sibelius
   exports through the parser. Add a fixture and a test for every new quirk,
   and check the 64-part limit and the 64-part seating layout.
3. **Browsers.** Test Safari (version 26 and later) and Firefox, covering
   playback, alignment and MP4 export, and update the browser-support notes.

**Finish what's open**

4. **Readable labels at 64 parts.** Add a compact "name + dynamic" label for
   crowded columns so labels stop overlapping.
5. **Deploy.** Run `scripts/deploy-init.sh` from `main` and put the app on App
   Runner with RDS Postgres and S3.
   - Configure the rate limiter for the proxy (`advanced.ipAddress`).
   - Add per-user storage quotas and a cleanup rule for abandoned uploads.
6. **Password reset.** Choose an email provider and enable it.
7. **Decide on the transcription pipeline:** surface it, keep it hidden, or
   remove it.

**Evaluate**

8. **User study.** Run sessions with both audiences (new listeners and
   musicians), pairing the in-app activity log with short task-based
   interviews (§2).
   - Can a first-time listener name the playing section?
   - Can a musician tell first from second violins in a passage?
   - Where does sync correction feel slow?

   The results settle the audience question and set the priorities for the
   final milestone.
