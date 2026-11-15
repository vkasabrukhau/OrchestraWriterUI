# Orchestra Visualizer

Shows which parts of an orchestra are playing, and how loud the score says
they are, while a recording plays. Brightness = written dynamic, color =
section. Upload a MusicXML score and an optional MP3, check the sync, set up
the display, preview, export a project file or an MP4.

One Next.js app: the pages, and the API (Hono + Better Auth + Postgres + S3)
mounted at `/api`. Score parsing runs on the server; alignment and MP4 export
run in the browser. See `docs/decisions/` for the why.

## Run

```bash
npm install
docker compose up -d      # Postgres on localhost:5433, S3Mock on localhost:9090
npm run dev               # http://localhost:3000 (migrations run on boot)
```

No `.env` is needed locally; `.env.example` lists every variable for
production. Sign up with any email and password (8+ characters).

> **Temporary, remove before an official launch.** The sample project and the
> "Use sample files" option exist only for team testing. The recording is a
> commercial Hallé release and the score's license is unclear, so neither may
> ship. To remove: the `fixtures/sample/` folder (and its `COPY` line in the `Dockerfile`),
> `src/server/services/sample-project.ts`, the `ensureSampleProject` call and the
> `/:id/sample-files` route in `src/server/routes/projects.ts`, `api.addSampleFiles`
> (`src/lib/api/types.ts`, `http.ts`, `mock.ts`), the "Use the sample files" card in
> `src/components/import/ImportPage.tsx`, `env.sampleProject` and `SAMPLE_PROJECT`,
> `tests/api/sample-project.test.ts`, and add a migration that drops
> `app.sample_projects`.

Every library starts with **Sample · Tchaikovsky 6 (Hallé)**: the first
movement's score, the Hallé recording and a finished sync (no markers), ready
at Customize. It is the shared baseline for manual testing. It is created once
per user the first time the library loads (deleting it does not bring it back),
from `fixtures/sample/`. Set `SAMPLE_PROJECT=off` to disable it. To start a
fresh project from the same files, use **Use sample files** on the Import page.

For a small project of your own: **New project** → drop
`fixtures/scores/orchestra-demo.musicxml` and, if you want the Sync step,
`fixtures/audio/orchestra-demo.mp3`.

Design review without a backend: `NEXT_PUBLIC_API_MOCK=1 npm run dev`.

| Route | Screen |
|---|---|
| `/sign-in`, `/sign-up` | accounts (email + password, Google when configured) |
| `/library`, `/programs`, `/profile`, `/settings` | the director's home |
| `/projects/<id>/import` → `sync` → `customize` → `preview` → `export` | the workflow; Sync only with a recording |

Keyboard on any playback screen: `Space` play/pause, `←`/`→` 5 s (`Shift` 30 s), `M` mute, `Home` start.

## Checks

```bash
npm run lint
npm run typecheck
npm test              # unit + component tests
npm run test:api      # API integration tests (needs docker compose)
npm run test:e2e      # Playwright, Chromium
npm run build
```

## Where things are

- `src/server/` — the API; `docs/backend/README.md` and `API.md`.
- `src/shared/` — contracts shared by server and browser (info map, project file, sync, API DTOs, MusicXML parser).
- `src/lib/` — api client, auth, stores, jobs, align, audio, export, visualizer.
- `src/components/` — `ui` primitives (Radix), `music`, `visualizer`, one folder per screen.
- `docs/` — spec, decisions (ADRs), plan, research, handoffs. `CLAUDE.md` holds the working rules.
- `fixtures/` — demo score and recording, parser quirk fixtures (`npm run fixtures` regenerates the generated ones), and `sample/` (the library's sample project).

## Deploying

Push to `main`: `.github/workflows/deploy.yml` builds the Docker image and
rolls it out on AWS App Runner (one-time setup: `scripts/deploy-init.sh`).
`ci.yml` runs lint, typecheck, unit, API and e2e tests on every pull request.
