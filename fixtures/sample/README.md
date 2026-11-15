# Sample project: Tchaikovsky 6, first movement · Hallé

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
