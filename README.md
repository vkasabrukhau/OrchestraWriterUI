# Orchestra Visualizer

**Team:** Megala Sivasankar · Lucas Sasaya · Valiantsin (Val) Kasabrukhau ·
Xuerui (Sherry) He · Zehavi Rodriguez · Stella Wang · Sulaiman Khydyr uulu

A web app that shows which parts of an orchestra are playing, and how loud the
score says they are, while a recording plays. You upload a MusicXML score and,
if you have one, an MP3 of a performance. The app lines the score up with the
recording, lights up each part on a labeled orchestra seating plan, and lets
you export the result as a project file or an MP4 with audio.

The rule behind the display: **the light shows the written dynamic in the
score, not the loudness of the recording.** Brightness is the dynamic (pp to
fff) and color is the section (strings, woodwinds, brass, percussion). We built
it for listeners who don't read scores, so they can follow a symphony, and for
musicians who need to learn quickly who plays what before a rehearsal.

The workflow is **Import → Sync → Customize → Preview → Export**. Sync only
appears when you upload a recording; without one, the app plays audio it
synthesizes from the score. On Sync, an automatic aligner times every bar
against the recording and rates its confidence; you correct it by placing
markers on notes in the engraved score or the piano roll, and each recompute
uses your markers as fixed anchors.

- [SPEC.md](SPEC.md): specification and system architecture
- [MS2-PROGRESS.md](MS2-PROGRESS.md): Milestone 2 report
- [MS1-PROGRESS.md](MS1-PROGRESS.md): Milestone 1 report

## Set up

Requirements: **Node.js 24** (the version CI uses), npm, and Docker (for
Postgres and a local S3).

```bash
git clone https://github.com/vkasabrukhau/OrchestraWriterUI.git
cd OrchestraWriterUI
npm install
npx playwright install chromium   # only needed for the end-to-end tests
```

You don't need a `.env` file to run locally, because every setting has a local
default. `.env.example` lists the variables used in production.

## Run

```bash
docker compose up -d      # Postgres 17 on localhost:5433, S3Mock on localhost:9090
npm run dev               # http://localhost:3000 (database migrations run on boot)
```

1. Sign up with any email and a password of 8 or more characters.
2. Click **New project** and drop `fixtures/scores/orchestra-demo.musicxml`.
   To try the Sync step, also drop `fixtures/audio/orchestra-demo.mp3`.
3. On **Sync**, the aligner runs on the first visit. Click a bar or note in
   the score, or drag a handle in the piano roll, to place a marker; then
   **Recompute** to re-run alignment with it.
4. On **Customize**, drag glows, recolor parts and sections, hide parts, and
   undo/redo (`⌘Z` / `⇧⌘Z`).
5. Watch it in **Preview**, then export a `.ovproj` project file or an MP4
   from **Export**.

MP4 export uses WebCodecs, so use Chrome or Edge. Firefox exports video
without audio, and we haven't tested Safari yet.

To try the UI without Docker, run `NEXT_PUBLIC_API_MOCK=1 npm run dev`. The
front end then uses an in-memory mock API.

To develop against the team's shared AWS database and bucket instead of
Docker, run `npm run aws:env` once (needs your own AWS credentials) and then
`npm run dev:aws`. See `infra/README.md`.

| Route | Screen |
|---|---|
| `/sign-in`, `/sign-up` | accounts (email and password; Google when configured) |
| `/library`, `/programs`, `/profile`, `/settings` | the user's home |
| `/projects/<id>/import` → `sync` → `customize` → `preview` → `export` | the workflow; Sync only with a recording |

Keyboard shortcuts on any playback screen: `Space` play/pause, `←`/`→` skip
5 s (`Shift` for 30 s), `M` mute, `Home` jump to the start. Customize also has
menu shortcuts (see **Help** in its menu bar).

## Test

```bash
npm run lint
npm run typecheck     # next typegen + tsc --noEmit
npm test              # unit and component tests (Vitest)
npm run test:api      # API integration tests; needs `docker compose up -d`
npm run test:e2e      # Playwright end-to-end tests in Chromium; starts the dev server
npm run build         # production build
```

On every pull request, CI (`.github/workflows/ci.yml`) runs lint, typecheck,
and the unit, API and end-to-end tests on Node 24. On older Node versions the
jsdom component tests that read fixtures from disk fail to load.

Alignment accuracy has its own scripts, run with `npx tsx`:
`scripts/eval-align.ts` checks the aligner on the synthetic demo recording.

## Project layout

- `src/app/`: Next.js routes, split into the `(auth)`, `(app)` and
  `(workflow)` groups, plus `api/[[...route]]`, where the server is mounted.
- `src/server/`: the HTTP API (Hono, Better Auth, Postgres, S3). See
  `docs/backend/README.md` and `docs/backend/API.md`.
- `src/shared/`: code and types shared by server and browser, including the
  MusicXML parser, the information map, the project file, sync and API types.
- `src/lib/`: browser logic, including the API client, stores, the alignment
  worker (`align/`), audio engines, MP4 export and the visualizer.
- `src/components/`: UI components, with one folder per screen (`sync/`,
  `customize/`, `editor/`, …) and the shared primitives in `ui/`.
- `tests/`: unit, API and end-to-end tests. Test inputs are in `fixtures/`.
- `docs/`: the spec, design decisions (`decisions/`, ADRs 0001–0023), plans,
  research and handoff notes.
- `infra/`, `scripts/`: AWS resources and deploy scripts.

## Deploying

When code is pushed to `main`, `.github/workflows/deploy.yml` builds the Docker
image and deploys it to AWS App Runner (Aurora Postgres and S3 behind it). The
workflow fails if App Runner rolls the deploy back. The one-time setup is
`scripts/deploy-init.sh`; the resources are listed in `infra/README.md`.
