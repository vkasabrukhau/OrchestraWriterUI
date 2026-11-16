# Orchestra Visualizer: specification

Last updated: 2026-11-16, Milestone 2. This spec describes what is built on
`main` today; work that lives on unmerged branches is listed separately in
§6. The full requirement text and screen descriptions are in
`docs/spec/requirements.md` and `docs/spec/design.md`, and the reasons behind
each technical choice are in `docs/decisions/` (ADRs 0001–0023).

## 1. Purpose

The app shows which parts of an orchestra are playing, and how loud the score
says they are, while a recording plays. Its two audiences are:

- **New listeners**, who want to follow a symphony without reading a score.
- **Musicians short on preparation time**, such as a conductor who needs to know
  whether a passage belongs to the first or the second violins before
  rehearsal.

### Design principles

1. **Match the score.** Light shows which parts play and their *written*
   dynamic. The audio signal never drives brightness.
2. **No training needed.** The display uses plain part names and a legend, so
   a first-time listener can name the section that is playing.
3. **Clear when busy.** Even when many parts are bright, the sections stay
   distinguishable.

### Visual encoding

The stage shows exactly three things:

| What | Encoding |
|---|---|
| A part is playing | its glow is on (with a short fade in and out) |
| Written dynamic | brightness on a fixed ladder: pp, p, mp, mf, f, ff, fff |
| Section | hue (strings, woodwinds, brass, percussion, other); parts within a section get tints within ±15 % lightness |

Each glow has a label with the part name and its current dynamic, set in the
Bravura music font. A pp–fff legend sits on the stage. Pitch, articulation,
dynamic ramps and look-ahead cues are left for a later phase (see the plan in
`MS2-PROGRESS.md` §5 for how we intend to open this up).

## 2. Functional requirements and status

| # | Requirement | What is implemented |
|---|---|---|
| 1 | Upload a score and optional audio | MusicXML (`.musicxml`, `.xml`, compressed `.mxl`) plus an optional MP3. Files go straight to S3 through presigned URLs, with caps of 50 MB per score and 500 MB per recording. The Import page shows the file summary, parse progress, warnings and errors. |
| 2 | Sync score and audio | See §3. An automatic aligner times every bar and gives it a 0–100 % confidence. Users place markers on any **note** (not just bar lines), which stay pending until a recompute; a recompute uses them as fixed anchors inside the aligner and can be limited to a range of bars. |
| 3 | Information map | The parsed per-part note list (time, duration, pitch, dynamic, style marking, measure). Everything downstream reads this map instead of raw MusicXML. The parser handles up to 64 parts, ties, backup/forward, tempo changes, repeats and transposing instruments. |
| 4 | Customize the display | A desktop-style editor (§4). One visual style. Users show or hide each part (hiding changes the picture, not the audio), drag glows on the seating plan, set section and part colors (including a color-blind-safe palette), switch label modes, change glow size, and turn on reduced motion. Undo/redo; settings autosave. |
| 5 | Generate the visual | Preview plays the visualization with the uploaded or generated audio. The engraved score, orchestra and visualizer panels can be collapsed. Preview links back to **Edit display**, and to **Edit sync** when the project has a recording. |
| 6 | Export | A project file (`.ovproj`), or an MP4 at 720p, 1080p or 4K and 30 or 60 fps, with the uploaded or generated audio. Exports show progress, can be cancelled and retried, and are listed in an export history. |
| 7 | Playback | Play/pause, seek, mute, speed (recording only) and keyboard shortcuts, with the current measure highlighted. Clicking a bar or note starts playback there. The score panel follows playback and can be browsed independently. Without a recording, a Web Audio synthesizer plays the score. |
| 8 | Saving and persistence | `.ovproj` save and open (score, audio, markers, display settings). Each signed-in account also keeps its projects on the server, so work comes back across sessions and devices. |

Beyond the eight requirements, the app has accounts (email and password, plus
Google sign-in when it's configured), a project library, programs (concert
programs with an ordered list of pieces), a profile with storage usage, and
settings such as theme, reduced motion and export defaults.

### Out of scope for now

Planned for a later phase: other score and audio formats (Sibelius, PDF,
extracting audio from video), custom mappings from musical data to visual
effects, color and brightness gradients, pitch, articulation and ramp effects,
motif highlighting, account-free mode, public share pages, and publishing
straight to YouTube.

## 3. Sync in detail

The Sync page (ADR 0017) is one window divided by draggable lines:

- a **confidence map**: one cell per bar, colored by confidence (red =
  uncertain), with **Next uncertain**;
- the **engraved score** (OpenSheetMusicDisplay, ADRs 0015–0016), laid out
  once as pages, following playback, with clickable bars and notes;
- **joint playback** (ADR 0020): a piano roll of the score's notes at sounding
  pitch, colored by section, drawn over a zoomable waveform of the recording.
  Each note onset is a handle that can be dragged to where it is heard;
- a **sidebar** with Measures, Markers and Sync (method, range, recompute).

How a correction flows through the system:

1. The user places or moves a marker on a note. It is drawn immediately but
   is **pending**: timing and confidence don't change yet (ADR 0018). Bars
   with pending markers are hatched, and the sidebar suggests a recompute once
   the edits are large enough.
2. A recompute runs `runSync` (ADR 0019), by default on each pending bar ± 2
   bars, or on a range the user selects, or on the whole piece. A range run
   aligns only that slice of score against a padded window of the recording
   and splices the result back.
3. Inside the aligner, every applied marker is a **fixed anchor** (ADR 0021):
   the coarse search may not cross it, the fine search corridor passes through
   it, and the tempo fit holds a knot on it and re-fits the tempo between and
   after anchors against the audio. So a correction also improves the bars
   around it instead of only moving its own bar.
4. A final monotonic merge pins the timing to the markers. Confidence always
   comes from the aligner, never from a marker.

The default aligner is the **integrated tempo** method (ADR 0014), ported to
TypeScript from a Python pipeline in Score Sync Lab, a research prototype that
compared alignment methods (`docs/research/score-sync-lab/`). It combines chroma, expected vs heard
loudness, attacks and ensemble rests; searches the whole piece at 2 Hz, then a
±4 s corridor at 50 Hz; and fits one continuous clock that penalizes tempo
jumps except at fermatas and rests. Chroma DTW (ADR 0009) is the fallback.

## 4. Customize in detail

Customize is a desktop-style editor (ADRs 0022–0023) in the same window frame
and header as Sync:

- a tool bar with menus (File, Edit, View, Playback, Parts, Help), select and
  lock tools, undo/redo (100 steps; drags and slider gestures are one step),
  reset positions and **Continue to Preview**; one command list drives the
  menus, buttons and keyboard shortcuts;
- an **Instruments** panel with search, filters and a live "Playing · dyn /
  Rest / Hidden" line per part;
- the **Stage** (the same renderer as Preview and the MP4), which can go full
  screen;
- a **Properties** panel: per part (color, tint, section, X/Y position,
  visibility) or for the stage (section colors, glow, labels, brightness);
- **Part lanes**: each part's activity over time from the info map;
- draggable borders between panels, remembered per browser.

Narrow windows collapse the menus into one button and stack the stage above
the panels. 64 parts play at 60 fps on a fast machine.

## 5. System architecture

The app is one Next.js 16 application with two halves: the pages, and an
HTTP API mounted at `/api` that runs in the same process. Postgres stores
accounts and project data, and S3 stores files. Heavy work that needs the
decoded audio or the renderer (alignment and MP4 export) runs in the browser;
score parsing runs on the server.

```
Browser (Next.js pages, React 19)                 Server (same Next.js process)
┌───────────────────────────────────────┐         ┌──────────────────────────────────┐
│ Screens ── zustand stores ── ApiClient│──HTTP──▶│ /api/* → Hono app (src/server)   │
│   Sync workspace, Customize editor    │         │   Better Auth   /api/auth/*      │
│ Score panel: OSMD (engraved MusicXML) │         │   routes → services → db/storage │
│ Visualizer: Canvas 2D GlowRenderer    │         │   parse-score job (shared parser)│
│   + FrameEngine (fades, dynamics)     │         │   migrations + seeds on boot     │
│ Audio: recording engine + Web Audio   │         └──────────┬───────────────┬───────┘
│   synth for score playback            │                    │ pg            │ AWS SDK
│ Alignment Web Worker: runSync         │                    ▼               ▼
│   integrated tempo (default),         │                 Postgres           S3
│   chroma DTW fallback, anchors        │                    ▲               ▲
│ MP4 export: WebCodecs + mp4-muxer     │                    │               │
│ .ovproj pack/unpack (zip)             │──presigned PUT/GET─┼───────────────┘
└───────────────────────────────────────┘                    │
                                     production: AWS App Runner + Aurora PostgreSQL
```

### Components

| Component | Where | What it does |
|---|---|---|
| Screens and UI | `src/app`, `src/components` | App Router routes in three groups: `(auth)`, `(app)` (library, programs, profile, settings) and `(workflow)` (the five steps). Radix UI primitives, sonner toasts, Lucide icons, Tailwind v4 design tokens. In-house resizable panes (`ui/Panes.tsx`, `ui/Splitter.tsx`). |
| Client state | `src/lib/store` | zustand stores for the project (info map, display settings with undo history, sync markers, autosave), playback (one transport clock every screen shares), the editor, preferences and session. |
| API client | `src/lib/api` | A typed `ApiClient` with an HTTP implementation and an in-memory mock for tests and design review. Long-running work is a job the UI polls. `sync-run.ts` splices range results into the saved sync. |
| Shared contracts | `src/shared` | Types and logic used by server and browser: the info map, the project file and its migrations, sync state (`manual` and `applied` markers, the monotonic merge, strict validation) and API DTOs. |
| MusicXML parser | `src/shared/score` | Walks the XML with `fast-xml-parser` and unzips `.mxl` with `fflate`. Runs on server and browser, classifies each instrument into a section, and reports warnings (repeats expanded, jumps ignored, more than 64 parts). |
| Score panel | `src/components/music`, `src/lib/score` | Renders the uploaded MusicXML with OpenSheetMusicDisplay as fixed pages, follows playback, and maps clicks on bars and notes to score time. Falls back to a schematic strip if OSMD can't draw the file. |
| Aligner | `src/lib/align` | `runSync` (`sync-function.ts`) is the single entry point: whole piece or a range, with the markers as anchors (`anchors.ts`). `integrated/` is the default method (features, coarse search, cost, joint tempo fit, heuristic confidence); `dtw.ts`/`chroma.ts` are the chroma DTW fallback. Runs in a cancellable Web Worker. |
| Audio engines | `src/lib/audio` | Plays the uploaded recording (with speed control) and builds a min/max peak pyramid for the zoomable waveform. A Web Audio synthesizer plays the score when there's no recording and renders audio offline for MP4 export. |
| Visualizer | `src/lib/visualizer`, `src/components/visualizer` | A Canvas 2D implementation of the `GlowRenderer` interface. The `FrameEngine` turns the info map and the playback time into what each part shows, including fades and reduced motion, and places labels on the seating layout. |
| MP4 export | `src/lib/export` | Renders frames with the same renderer and label layout as Preview, encodes H.264 with `VideoEncoder` and AAC with `AudioEncoder` (where available), and muxes with `mp4-muxer`. Downloads in the browser and uploads to the export history. |
| HTTP API | `src/server` | A Hono app mounted by `src/app/api/[[...route]]/route.ts`. Routes (validation) → services (logic) → db/storage. Every query is filtered by the signed-in user. |
| Auth | `src/server/auth.ts` | Better Auth with email and password, plus Google when configured. HttpOnly session cookies. |
| Database | Postgres 17 (Aurora in production) | `auth` schema: users, sessions, accounts. `app` schema: profiles, projects (sync and display as JSON), programs, program_projects, jobs, exports and activity. SQL migrations run on boot. |
| Object storage | S3 (S3Mock locally) | Keys under `users/<id>/projects/<pid>/` hold scores, recordings, info-map JSON and exports. The browser transfers files through presigned URLs, so file bytes never pass through the app server. |

### Key data flows

1. **Import.** The browser gets a presigned PUT from `POST /api/uploads` and
   uploads the score to S3, then calls `POST /api/projects/:id/score`, which
   starts the parse-score job. The job runs the shared parser and writes
   `info-map-<job>.json` to S3 while the browser polls `GET /api/jobs/:id`.
   A recording goes through the same upload.
2. **Sync.** The browser decodes the MP3 and runs `runSync` in the worker
   (§3). It saves the per-bar results and both marker lists with
   `PUT /api/projects/:id/sync`. Every screen reads timing as the merge of
   the aligner's result with the *applied* markers.
3. **Customize, Preview.** Display settings autosave with
   `PUT /api/projects/:id/display`. Playback drives one shared clock. Each
   frame, the `FrameEngine` looks up the active notes and their dynamics in
   the info map, using the sync map to convert recording time to score time.
4. **Export.** The browser renders and encodes the MP4 frame by frame,
   uploads it to S3, and registers it with `POST /api/projects/:id/exports`.
   A `.ovproj` file is a zip of `project.json` with the original score and
   audio. Opening one creates a new project and the server parses the score
   again.

The full route list is in `docs/backend/API.md`.

### Why this shape

- **One process.** The API inside Next.js means one dev server, one Docker
  image and no CORS (ADR 0007).
- **Alignment and export in the browser.** The browser already holds the
  decoded audio, the info map and the renderer, so the MP4 uses exactly the
  same drawing code as Preview, and there are no Lambda time or memory limits
  (ADRs 0009, 0010). The `Aligner` and `GlowRenderer` interfaces leave room to
  move either to the server later.
- **The sync function is a black box** (ADR 0019): new methods plug in behind
  `runSync` without touching the UI.
- **Parser shared by server and browser** (ADR 0008).

### Deployment

`Dockerfile` builds a standalone Next.js image. On a push to `main`,
`.github/workflows/deploy.yml` pushes it to ECR and AWS App Runner (1 vCPU /
2 GB) rolls it out, with Aurora PostgreSQL and S3 behind it; the workflow
fails if App Runner rolls back. CI runs lint, typecheck, unit, API and
Playwright tests on every pull request. Locally, `docker compose` provides
Postgres and S3Mock; `npm run dev:aws` points a local server at the shared
AWS resources. Resources are listed in `infra/README.md`.

## 6. Work on branches (not yet on `main`)

| Branch | What it adds |
|---|---|
| `feat/redline-sync` | Aligner parity with the Python reference on real recordings (score-clock and mixed-meter parser fixes, Sync Toolbox's filterbank for recording chroma), a 10 Hz refinement pass, DTW jumps for repeated or cut passages, markers whose correction stays local, `scripts/eval-real.ts`, recording playback from decoded audio (exact playhead after seeks), a second selectable aligner ("Redline"), and a Tchaikovsky 6 sample project. ADRs 0023–0025 on that branch (to be renumbered on merge). |
| `sulaiman/audio-to-score` | Experimental: transcribe a score from a recording alone with MuScriptor on an on-demand GPU instance; the transcription's beat grid becomes the project's sync. |
| `test/ui-orchestra-screen` | A standalone mockup comparing two pitch encodings on the stage (`docs/mockups/pitch-encoding-study.*`); no app code. |

## 7. Known limitations

- MP4 export needs WebCodecs. Chrome and Edge are tested. Firefox exports
  video only, because it has no AAC encoder. Safari hasn't been tested.
- Confidence is a heuristic and is not yet calibrated against hand-annotated
  bars of a real recording.
- On `main`, the browser seeks variable-bitrate MP3s inexactly, so after a
  jump the heard audio can be a few seconds off the playhead (fixed on
  `feat/redline-sync`, ADR 0025).
- In part-label mode with 64 parts, labels overlap.
- Preview does too much React work per frame: with 64 parts at 4× CPU
  throttle it runs about 10 fps.
- Password reset needs an email provider, which isn't set up yet.
- Each file has a size cap, but there is no per-user storage quota yet.
- The sign-in rate limiter trusts a client-supplied `x-forwarded-for` behind
  the App Runner proxy until `advanced.ipAddress` is configured.
