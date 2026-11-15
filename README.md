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

Every library starts with **Sample · Tchaikovsky 6 (Hallé)**: the first
movement's score, the Hallé recording and a finished sync (no markers), ready
at Customize. It is the shared baseline for manual testing. It is created once
per user the first time the library loads (deleting it does not bring it back),
from `fixtures/sample/`. Set `SAMPLE_PROJECT=off` to disable it.

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
