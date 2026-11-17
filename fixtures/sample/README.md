# Sample project: Tchaikovsky 6, first movement · Hallé

> **Temporary, remove before an official launch.** For team testing only:
> the recording is a commercial Hallé release and the score's license is
> unclear, so neither may ship. To remove: the `fixtures/sample/` folder (and its `COPY` line in the `Dockerfile`),
> `src/server/services/sample-project.ts`, the `ensureSampleProject` call and the
> `/:id/sample-files` route in `src/server/routes/projects.ts`, `api.addSampleFiles`
> (`src/lib/api/types.ts`, `http.ts`, `mock.ts`), the "Use the sample files" card in
> `src/components/import/ImportPage.tsx`, `env.sampleProject` and `SAMPLE_PROJECT`,
> `tests/api/sample-project.test.ts`, and add a migration that drops
> `app.sample_projects`.

Put in each user's library once by `src/server/services/sample-project.ts`
(disable with `SAMPLE_PROJECT=off`), as the shared baseline for manual testing.

| File | What |
|---|---|
| `tchaikovsky-6-mvt1.mxl` | the score (354 bars, 17 parts) |
| `halle-tchaikovsky-6-mvt1.mp3` | the Hallé recording (17:54, variable bitrate) |
| `recording.json` | its duration and the 420 overview peaks the client computes at upload |
| `sync.json` | a known-good sync from the integrated aligner (no markers); it matches the score-sync-lab result at bars 17–26 and 85–93 |

To refresh `sync.json` after aligner changes, sync a fresh project in the app,
check it, and copy its `sync` from the database (`app.projects.sync`).
