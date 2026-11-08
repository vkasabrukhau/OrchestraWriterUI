# HTTP API

The Hono app in `src/server/app.ts`, mounted inside Next.js at
`src/app/api/[[...route]]/route.ts`. Everything is under `/api` on the site
origin (`http://localhost:3000` in development, the App Runner URL in
production). Wire types live in `src/shared/api.ts`; ids are **strings** on the
wire (Postgres integers underneath).

All bodies are JSON. Files never pass through the API: the browser PUTs them
to S3 with a presigned URL, then registers the key (see "Upload flow").

## Conventions

- **Sessions** are HttpOnly cookies set by Better Auth
  (`better-auth.session_token`; `__Secure-better-auth.session_token` when the
  site is https). A same-origin page sends nothing special. A page on another
  origin needs the server started with `CORS_ORIGINS=<its origin>` and must
  call `fetch` with `credentials: "include"`.
- **Errors** from our routes: `{ "error": "message", "code": "..." }`.
  Errors from Better Auth (`/api/auth/*`): `{ "code": "SOME_CODE", "message": "..." }`.

  | Status | code | When |
  |---|---|---|
  | 400 | `invalid` | malformed body or field (message names the field) |
  | 401 | `unauthenticated` | no valid session: `{ "error": "Not signed in" }` |
  | 403 | `forbidden_key` | a registered S3 key is not under this project's folder |
  | 403 | `forbidden_origin` | a form-style request (urlencoded, multipart, text/plain) from another origin (CSRF check) |
  | 404 | `not_found` | the record does not exist **or is not yours** (never 403, which would confirm the id) |
  | 409 | `conflict` | handle taken; key already registered |
  | 413 | `too_large` | JSON body over 4 MB; score over 50 MB; recording over 500 MB |
  | 503 | `db_unreachable` | Postgres is down: `{ "error": "Database unreachable" }` |
  | 503 | `storage_unconfigured` | `S3_AUDIO_BUCKET` not set |
  | 500 | `internal` | anything else; the detail is logged on the server, never returned |

- **Ownership**: every query filters by the session's user id. User ids never
  come from a body or query string.
- **Database readiness**: `src/instrumentation.ts` applies migrations and
  seeds on boot. Until they have run, DB routes wait; while Postgres is
  unreachable they answer 503 and retry the connection every 5 s.

## Health and status (no session)

| Method | Path | Returns |
|---|---|---|
| GET | `/api/health` | `{ ok: true }`; liveness, no DB. App Runner's health check. |
| GET | `/api/health/db` | `{ ok: true }` or 503 `{ ok: false }` |
| GET | `/api/config` | `{ googleEnabled: boolean }` |
| GET | `/api/status` | self-checks, below |

`GET /api/status`:

```json
{
  "ok": true,
  "server":   { "env": "production", "time": "2026-10-26T06:20:42.189Z", "baseUrl": "https://..." },
  "database": { "ok": true, "latencyMs": 12, "instruments": 31, "detail": "PostgreSQL 17.9, 31 instruments seeded, host orchestra-db-1" },
  "storage":  { "ok": true, "latencyMs": 80, "bucket": "orchestra-audio", "detail": "bucket orchestra-audio reachable in us-east-1" },
  "pipeline": { "mode": "inline", "stateMachine": null },
  "auth":     { "googleEnabled": false, "signedIn": true, "user": { "id": "1", "name": "Ada", "email": "ada@example.com" } }
}
```

## Auth (Better Auth, under `/api/auth`)

Better Auth's standard endpoints (https://www.better-auth.com/docs/concepts/api).

| Method | Path | Body | Returns |
|---|---|---|---|
| POST | `/api/auth/sign-up/email` | `{ name, email, password }` (password ≥ 8) | `{ token, user }` and sets the session cookie |
| POST | `/api/auth/sign-in/email` | `{ email, password }` | `{ token, user }` and sets the cookie; 401 `INVALID_EMAIL_OR_PASSWORD` |
| POST | `/api/auth/sign-in/social` | `{ provider: "google", callbackURL: "/" }` | `{ url }`; navigate the browser to it |
| GET | `/api/auth/get-session` | | `{ session, user }` or `null` |
| POST | `/api/auth/sign-out` | `{}` | `{ success: true }` and clears the cookie |

`user`: `{ id, name, email, emailVerified, image, createdAt, updatedAt }`.

Better Auth checks that browser requests carry an `Origin` matching
`BETTER_AUTH_URL` or one of `CORS_ORIGINS` (browsers do this automatically;
curl and tests must send it). Google sign-in appears only when
`GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET` are set; register
`<site>/api/auth/callback/google` as a redirect URI.

## Profile (`/api/me`, session required)

| Method | Path | Body | Returns |
|---|---|---|---|
| GET | `/api/me` | | `{ profile: ProfileDto }`. The profile row is created on the first call: handle from the email's local part (`ada.lovelace@x` → `ada-lovelace`, then `-2`, `-3`... if taken), role `Music director`. |
| PUT | `/api/me` | `ProfileUpdate` (any subset) | `{ profile }`. `name` 1–100; `handle` 3–30 of `[a-z0-9-]`, unique (409); `role` one of `Music director`, `Educator`, `Conductor`, `Listener`, `Student`; `ensemble`/`location` ≤ 120; `bio` ≤ 1000; `website` `http(s)://…` ≤ 200 or `null`; `preferences` a partial `Preferences` (unknown keys are 400), merged into the stored ones. |
| DELETE | `/api/me` | | 204. Signs out (expires the cookie), deletes the user (cascades to every row the user owns) and every S3 object under `users/<id>/`. |
| GET | `/api/me/usage` | | `UsageDto`: `{ scores: { count, bytes }, recordings: { count, bytes }, exports: { count, bytes }, totalBytes }` |

`ProfileDto`: `{ id, name, handle, email, role, ensemble, location, bio, initials, joinedAt, website?, image, preferences }`.
`preferences` is always complete: stored values merged over `DEFAULT_PREFERENCES`.

## Upload flow

1. `POST /api/uploads` with `{ kind, filename, contentType, projectId? }`. The
   server checks the content type and that the project is yours, mints a key,
   and signs a PUT (15 min).
2. `PUT <uploadUrl>` with the raw file as the body and the **same**
   `Content-Type` header. This goes straight to S3.
3. Register the key: `POST /api/projects/:id/score`, `/audio` or `/exports`.
   The server only accepts a key of the exact shape it minted for that project
   and folder (else 403), and reads the real size from S3 (HeadObject).
4. To read a file back: `GET /api/projects/:id/urls` or
   `GET /api/exports/:id/download-url` (presigned GET, 15 min).

| Method | Path | Body | Returns |
|---|---|---|---|
| POST | `/api/uploads` | `UploadRequest` | `UploadTarget` `{ key, uploadUrl, expiresInSeconds: 900 }` |

| `kind` | `projectId` | Accepted `contentType` | Key |
|---|---|---|---|
| `score` | required | `application/vnd.recordare.musicxml+xml`, `application/vnd.recordare.musicxml`, `application/xml`, `text/xml`, `application/octet-stream` | `users/<uid>/projects/<pid>/score/<uuid>-<name>` |
| `audio` | required | `audio/*` | `users/<uid>/projects/<pid>/audio/<uuid>-<name>` |
| `export` | required | `video/mp4`, `application/zip`, `application/octet-stream` | `users/<uid>/projects/<pid>/exports/<uuid>-<name>` |
| `project` | ignored | `application/zip`, `application/octet-stream` | `users/<uid>/imports/<uuid>-<name>` |

`<name>` is the filename lowercased, `[a-z0-9._-]` only, at most 80 characters.
Browsers report an empty type for `.mxl` and sometimes `.musicxml`; send
`application/octet-stream` then.

## Projects (`/api/projects`, session required)

| Method | Path | Body | Returns |
|---|---|---|---|
| GET | `/api/projects` | | `{ projects: ProjectSummary[] }`, most recently updated first |
| POST | `/api/projects` | `ProjectCreate` `{ title? }` (or empty) | 201 `{ project: ProjectDto }`; title defaults to `Untitled project` |
| GET | `/api/projects/:id` | | `{ project: ProjectDto }` (includes `sync`, `display`, `audioPeaks`) |
| PATCH | `/api/projects/:id` | `ProjectPatch` `{ title?, subtitle?, composer?, movement?, stage?, programIds? }` | `{ project }`. `programIds` replaces the project's program memberships (new ones go to the end of that program's running order); every id must be your program (else 404). |
| DELETE | `/api/projects/:id` | | 204. Deletes the project, its jobs, exports, activity, running-order entries, its recording row, and every S3 object under `users/<uid>/projects/<pid>/`. |
| POST | `/api/projects/:id/score` | `RegisterScoreRequest` `{ key, filename }` | 202 `RegisterScoreResponse` `{ project, job }`; starts the parse-score job (below) |
| POST | `/api/projects/:id/audio` | `RegisterAudioRequest` `{ key, filename, durationSec, peaks? }` | `{ project }`. Records the recording (replacing and deleting any previous one), stores `peaks` (≤ 4096 numbers in 0–1), clears `sync`, sets `stage` to `sync`. |
| DELETE | `/api/projects/:id/audio` | | `{ project }`. Deletes the recording row and object, clears peaks and sync; `stage` `sync` becomes `customize`. |
| GET | `/api/projects/:id/urls` | | `ProjectUrls` `{ score, audio, infoMap, expiresInSeconds: 900 }` (presigned GETs; `null` when absent) |
| PUT | `/api/projects/:id/sync` | `SyncState` | `{ project }`. Checked: `method` string, `averageConfidence` 0–100, `auto[]` of `{ n, startSec, confidence }`, `manual[]` of `{ id, measure, startSec }` (≤ 20 000 each). Logs a `sync` activity line. |
| PUT | `/api/projects/:id/display` | `DisplaySettings` | `{ project }`. Checked: `visibleParts` string[], `positions`/`colors`/`sectionColors`/`sections` objects, `sections` values are sections, `showLabels`/`reducedMotion` booleans, `labelMode` `sections`/`parts`, `glowScale` 0.6–1.4. Logs an `edit` line at most once per 10 minutes per project. |
| GET | `/api/projects/:id/exports` | | `{ exports: ExportDto[] }`, newest first |
| POST | `/api/projects/:id/exports` | `RegisterExportRequest` `{ kind, filename, key, bytes, resolution?, frameRate? }` | 201 `{ export: ExportDto }`. `bytes` is read from S3 regardless of what is sent. Logs an `export` line. |

### Project status (derived, never stored)

| `status` | When | `statusDetail` |
|---|---|---|
| `importing` | no score yet, or the parse-score job is running | `Waiting for a score` / the job's current message |
| `failed` | the last parse-score job failed | the job's error |
| `needs-sync` | a recording exists and `sync` is null | |
| `exported` | at least one export | |
| `ready` | otherwise | |

`stage` (`import` → `sync` → `customize` → `preview` → `export`) is stored and
moved by the client with PATCH; the server sets it to `import` when a score
parses, `sync` when a recording is registered.

### The parse-score job

`POST /api/projects/:id/score` answers 202 at once and runs the job in the
server process:

1. "Reading score": read the object from S3.
2. "Building the information map": `parseMusicXml({ bytes, filename })` from
   `src/shared/score`; more than 64 parts fails the job.
3. "Saving": write the info map JSON to
   `users/<uid>/projects/<pid>/info-map-<jobId>.json`; update the project
   (title/composer/movement when the score names them, parts, measures,
   duration, tempo, time signature, warnings, thumbnail, default display
   settings if it has none, `stage: "import"`); job `succeeded` with a
   `ParseScoreResult` `{ title, composer, movement, parts, measures, durationSec, warnings }`;
   an `import` activity line.

If the parser returns `{ ok: false, error }`, the job fails with that error and
the project's status becomes `failed` with the same detail. An unexpected
exception is logged; the user sees a generic message. Registering a different
score replaces the old one: its object and info map are deleted, `sync` and
`display` are cleared, and a still-running older job discards its result.

To read the information map: `GET /api/projects/:id/urls`, then `fetch(urls.infoMap)` (JSON `InfoMap`).

### Transcribing a score from the recording (experimental)

Needs the local MuScriptor service (`npm run ml:serve`, `ml/README.md`) at
`TRANSCRIBER_URL` (default `http://127.0.0.1:8333` locally). Both routes answer
202 `{ job }` with a server job of kind `transcribe`; when it succeeds its
result is a `TranscribeScoreResult` `{ parts, bpm, model, seconds, parseJobId, synced }`,
and `parseJobId` is the parse-score job that imports the written score.

| Method | Path | Body | Response |
|---|---|---|---|
| POST | `/api/projects/:id/transcribe-score` | `{ ensemble?: "orchestra" \| "strings" \| "any", resume?: boolean }` | Transcribes the recording (400 without one). A transcription already running on the project is answered instead of starting another; `resume: true` only answers a running one (404 when there is none). |
| POST | `/api/projects/:id/transcription/bars` | `TranscriptionBars` `{ beatsPerBar: 2–7 \| null, shiftBeats: -16–16, beatScale: 0.5 \| 1 \| 2 }` | Rewrites a transcribed score with corrected bars from the saved transcription (no model run): time signature, bar lines moved later by whole beats (kept within one bar), half/double tempo. 400 when the score was not transcribed, 409 while a transcription runs. |

The job writes the MusicXML to the score folder and registers it like an
upload, then, once it is parsed, saves the measure starts the service reported
as the project's `sync` (`method: "transcription-beats"`, confidence 100) when
the measure counts agree. The transcription itself (the model's notes and the
beat grid) is kept in S3; `project.transcription` (`TranscriptionInfo`)
carries what the UI needs: `{ model, detected: { beatsPerBar, bpm }, bars, bpm, beatsPerBar, warnings }`.
Registering an uploaded score, a new recording or removing the recording
clears it. `project.transcribing` is `true` while a transcription runs, and
`statusDetail` reads "Transcribing the recording".

## Jobs (`/api/jobs`, session required)

| Method | Path | Returns |
|---|---|---|
| GET | `/api/jobs/:id` | `{ job: JobDto }` (404 unless it is yours) |

`JobDto` (same shape as the browser `Job`): `{ id, kind: "parse-score", status: "queued" | "running" | "succeeded" | "failed", progress: 0–1, message, result?, error?, startedAt, updatedAt }`.
Job ids are numeric strings (`"42"`). Poll every 0.5–2 s until `succeeded` or `failed`.

## Exports (`/api/exports`, session required)

| Method | Path | Returns |
|---|---|---|
| GET | `/api/exports/:id/download-url` | `{ url }`: presigned GET (15 min) that downloads under the export's filename |

`ExportDto`: `{ id, projectId, kind: "mp4" | "project", filename, key, bytes, resolution, frameRate, createdAt }`.

## Programs (`/api/programs`, session required)

| Method | Path | Body | Returns |
|---|---|---|---|
| GET | `/api/programs` | | `{ programs: ProgramDto[] }`, by date (undated last) |
| POST | `/api/programs` | `ProgramCreate` `{ name, season?, date?, venue?, description?, color? }` | 201 `{ program }` |
| GET | `/api/programs/:id` | | `ProgramResponse` `{ program, projects: ProjectSummary[] }`, projects in running order |
| PATCH | `/api/programs/:id` | `ProgramPatch` (any of the above, `notes?`, `projectIds?`) | `{ program }`. `projectIds` is the full ordered list and replaces the running order; every id must be your project (else 404). |
| DELETE | `/api/programs/:id` | | 204 (the projects stay) |

`ProgramDto`: `{ id, name, season, date ("YYYY-MM-DD" or ""), venue, description, projectIds, color (a section), notes, createdAt }`.
`date` accepts `YYYY-MM-DD`, or `null`/`""` to clear.

## Activity (`/api/activity`, session required)

| Method | Path | Returns |
|---|---|---|
| GET | `/api/activity` | `{ activity: ActivityDto[] }`, the last 25, newest first |

`ActivityDto`: `{ id, kind: "import" | "sync" | "export" | "edit" | "share", projectId, text, at }`.

## Transcription pipeline (kept from the backend repo; not in the visualizer UI)

Session required. Turns a recording into sheet music through AWS Step Functions
in production, or the same steps in-process locally.

| Method | Path | Body | Returns |
|---|---|---|---|
| GET | `/api/files` | | `{ files: File[] }`, newest first |
| POST | `/api/files/upload-url` | `{ filename, contentType }` (`audio/*`, `video/*`, `application/octet-stream`) | `{ key, uploadUrl }` (key `users/<uid>/<uuid>-<name>`) |
| POST | `/api/files` | `{ name, key, audioLengthSeconds }` | 201 `{ file }`; 403 if `key` is not under your prefix |
| GET | `/api/files/:id/download-url` | | `{ url }` (15 min) |
| DELETE | `/api/files/:id` | | 204 |
| POST | `/api/transcriptions` | `{ audioFileId }` | 201 `{ job: Transcription }`, status `running` |
| GET | `/api/transcriptions` | | `{ jobs: Transcription[] }`, newest first, at most 50 |
| GET | `/api/transcriptions/:id` | | `{ job: Transcription }`, with `sheets` once `succeeded` |
| GET | `/api/sheets/:id/download-url` | | `{ url }`, presigned MusicXML download (15 min) |

`File`: `{ id: number, name, key, audioLengthSeconds, createdAt }`.
`Transcription`: `{ id, audioFileId, audioName, status, chunkCount, setId, error, createdAt, startedAt, finishedAt, sheets?: { id, name, instrument }[] }`.
(These two keep the backend's numeric ids.) The model is a placeholder until
the model team replaces `src/server/pipeline/model.ts`.

## Trying it with curl

```bash
B=http://localhost:3000
curl -s -c jar -b jar -H "Origin: $B" -H 'content-type: application/json' \
  -X POST $B/api/auth/sign-up/email -d '{"name":"Ada","email":"ada@example.com","password":"long-enough-1"}'
curl -s -b jar $B/api/me
curl -s -b jar -H "Origin: $B" -H 'content-type: application/json' -X POST $B/api/projects -d '{"title":"Test"}'
```

`scripts/smoke-test.sh [base-url]` runs the whole flow (sign-up, project,
score upload, parse job, display, delete, recordings, transcription, sign-out,
account deletion). `npm run test:api` runs the integration tests in
`tests/api/` against `docker compose up -d`.
