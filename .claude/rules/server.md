---
paths:
  - "src/server/**"
  - "src/app/api/**"
  - "src/shared/api.ts"
  - "tests/api/**"
---
# The server (Hono inside Next.js)

- Layers: `routes/` validate input, call a service, shape the response.
  `services/` hold logic and call `db/` and `storage/`. Nothing else reads
  `process.env` except `config/env.ts`.
- Every query that returns or changes a user's data filters by `user_id`.
  A missing or foreign row is a 404, never a 403 that confirms existence
  (except the upload-key prefix check, which is 403 by design).
- Wire shapes live in `src/shared/api.ts`; ids are strings on the wire.
- Schema changes: dated file in `src/server/db/sql/migrations/`, never edit an
  applied file. New tables are schema-qualified (`app.`); auth tables belong
  to Better Auth.
- Files never flow through the server: presigned PUT/GET only, except the
  parse-score job reading the score and writing `info-map.json`, and the
  experimental transcribe job (`services/transcribe-score.ts`) reading the
  recording to send it to the MuScriptor service (local, or the AWS GPU
  instance; `services/transcriber.ts`) and writing the score.
- Local stack: `docker compose up -d`; tests in `tests/api` run against it
  with `npm run test:api`.
