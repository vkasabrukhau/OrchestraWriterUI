---
name: plan-review-pitfalls
description: Traps found reviewing the 2026-11-09 Sync revamp plan; jsdom is a local Node version problem (CI is Node 24), e2e specs pin Sync card names, Next 16 build has no gzip size output, keyboard claims to verify
metadata:
  type: project
---
Found while reviewing `docs/plan/sync-page-revamp-plan.md` on 2026-11-09. Re-check these when reviewing plans or PRs:

- **jsdom "broken" is only local.** jsdom 30 needs Node `^22.22.2 || ^24.15`. The local machine had 22.14.0. CI (`.github/workflows/ci.yml`) uses Node 24 and runs `npm test`, which includes the `dom` project. So "DOM tests are blocked" is wrong, and any `.test.tsx` that is edited but never run locally will still run in CI. The fix is an `.nvmrc`/`engines` pin, not a move to Playwright.
- **Existing e2e specs pin Sync page names.** `tests/e2e/workflow-recording.spec.ts` and `score-navigation.spec.ts` use the "Manual markers" region, "+10 ms"/"+100 ms" buttons, "Bar N" headings, "Re-run auto-alignment" and "Manual markers were kept." Any Sync restructure has to list these updates.
- **Next 16.4 `next build` prints no First Load JS gzip numbers.** It writes `.next/route-bundle-stats.json` with uncompressed sizes. A bundle-size gate needs a script.
- **Keyboard claims need checking against code.** The plan listed an "F" score key that does not exist. Shift+F10 does not fire `contextmenu` in Chrome on macOS. Alt+Left/Right is browser Back on Windows/Linux.

- **Round 2 (same plan).**
  - Playwright `testDir` is `tests/e2e` and has no grep filter, so any `@perf` spec under `tests/e2e/perf/` runs in CI unless the config excludes it.
  - React `<Profiler onRender>` doesn't fire in a production build without `next build --profile`.
  - `PlaybackShortcuts` (Transport.tsx) handles Enter and Home on any non-button target, so listboxes and canvases conflict with it.
  - A data-basis migration (such as `positionBasis`) has to land in the same task as the code that writes and reads the new basis.

- **Round 3 (same plan).**
  - Playwright `webServer` is set for the whole config, not per project, so a perf server needs its own config file.
  - On the score, ←/→ in `PlaybackShortcuts` only seek and never set the cue. A keyboard-activated "Select bar N" button picks only at keyboard-click coordinates. So there is no keyboard way to select a single note today.
  - An interactive MarkerIcon inside a listbox option recreates the ARIA nesting problem.

**Why:** Each of these made a plan's verification step unrunnable, or would have broken CI on merge.

**How to apply:** Before scoring testability, check the CI Node version, grep the e2e specs for the UI names a change removes, and grep the shortcut handlers for each key the plan says already exists. Related: [[recurring-review-findings]].
