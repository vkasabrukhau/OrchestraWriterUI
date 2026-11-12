# Project state

Edited only on `main` (or in the PR that merges). Everything Claude needs to
know about *where we are* lives here; *what we're building* lives in `docs/spec/`.

Last updated: 2026-11-12 (branch `feat/customize-redesign`, in review)

## Status by requirement

| # | Requirement | Status | Branch / owner | Notes |
|---|---|---|---|---|
| 1 | Upload score (MusicXML) + optional MP3 | in review | feat/backend-integration | Presigned S3 uploads; server parse-score job with the shared parser (`src/shared/score`); `.mxl` supported |
| 2 | Sync score and audio (auto + manual, confidence) | in review | feat/backend-integration | Chroma DTW in a Web Worker (ADR 0009); manual markers merged and persisted; 56/56 bars within 150 ms on synthesized audio, 55/56 on the committed MP3 (ADR 0009) |
| 3 | Information map | in review | feat/backend-integration | Parser + 20 quirk fixtures; stored as `info-map-<job>.json` in S3; types in `src/shared/info-map.ts` |
| 4 | Customize display (one style, colors, positions, 64 parts) | in review | feat/customize-redesign | Desktop-style editor (ADR 0014): menu bar, tool bar, undo/redo, part lanes; settings autosave to `projects.display`; 64 parts at 60 fps on a fast machine |
| 5 | Generate the visual | in review | feat/backend-integration | Canvas 2D renderer; labels drawn on canvas for export |
| 6 | Export (project file, MP4) | in review | feat/backend-integration | Browser WebCodecs + mp4-muxer (ADR 0010); history in `app.exports` |
| 7 | Playback (controls, measure highlight, click-to-play) | in review | feat/backend-integration | `<audio>` engine for recordings, Web Audio synth when there is no recording |
| 8 | Local saving (manual project file) | in review | feat/backend-integration | `.ovproj` zip (ADR 0012); open re-creates the project on the server |

Accounts (Better Auth, ADR 0007), library, programs, profile, settings,
activity and usage are backed by Postgres on the same branch.

Status values: not started · in progress · in review · done · blocked

## Screens

| Screen | Status | Notes |
|---|---|---|
| Sign in / Sign up | wired | email + password; Google when configured |
| Library, Programs, Profile, Settings | wired | real data; decluttered |
| Import | wired | real uploads, parse job, open `.ovproj` |
| Sync | wired | auto-aligns on first visit; nudge default, ms advanced |
| Customize | wired | Editor chrome (ADR 0014); narrow layouts collapse the menus and steps |
| Preview | wired | real audio, collapsible panels |
| Export | wired | project file + MP4, history |

## Open questions (need a human decision)

1. ~~Rendering library for export~~ – Canvas 2D in the browser (ADR 0010); PixiJS/Three still possible behind `GlowRenderer`.
2. ~~Alignment method~~ – chroma DTW in the browser (ADR 0009); Sync Toolbox server-side is the upgrade path.
3. ~~Visual direction~~ – A by default, B as a theme (ADR 0005).
4. **Audience** – new listeners following a symphony vs musicians maximizing prep time; needs confirmation.
5. ~~MP4 export~~ – in-browser WebCodecs (ADR 0010).
6. **Transcription pipeline** – the backend's audio-to-score pipeline is kept under `/api/transcriptions` but has no UI. Keep, surface, or remove?
7. **Hosting the Next.js image** – `scripts/deploy-init.sh` targets App Runner; run it once from `main`.
8. **Password reset** – needs an email provider (Better Auth `sendResetPassword`); until then a lost password loses the account.
9. **Storage quotas** – uploads are capped per file (50 MB score, 500 MB recording, 2 GB export) but there is no per-user quota or lifecycle rule for abandoned uploads yet.

## Known breakage

- MP4 export needs WebCodecs: Chrome/Edge (AAC audio), Safari 26+ (AAC);
  Firefox has no AAC encoder, so exports there are video-only with a warning.
  Safari and Firefox have not been exercised yet.
- Alignment confidence thresholds were tuned on synthetic audio only.
- In "parts" label mode with 64 parts, 32 labels per side overlap (about
  17 px apart); a compact "name + dynamic" label for crowded columns is the
  follow-up.
- While playing, Preview re-renders React work every frame: with 64 parts at
  4× CPU throttle it runs about 10 fps (Customize 18). Needs a perf pass.
- Better Auth's production rate limit trusts a client-supplied
  `x-forwarded-for`; set `advanced.ipAddress` for the App Runner proxy.

## Later-phase backlog (not in scope)

Account-free mode and public share pages (ADR 0013) · Other score/audio formats (incl. extracting audio from MP4) · custom mappings
and gradients · pitch, articulation, ramps, look-ahead ring · browser
auto-restore · engraved notation (OSMD) · audio-based instrument
identification (see `docs/research/sync-and-instrument-identification.md`).
