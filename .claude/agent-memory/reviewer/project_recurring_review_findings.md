---
name: recurring-review-findings
description: Failure modes found in past reviews (2026-10-26 backend, 2026-11-12 customize editor) to re-check: upload caps, zip bombs, URL expiry, autosave race, MP4 memory, undo history, shortcut conflicts, counter triggers
metadata:
  type: project
---
These checks turned up real problems in past reviews. Re-check them whenever a PR touches the same areas.

From the 2026-10-26 `feat/backend-integration` review:
- **Size caps on server reads.** Presigned S3 PUT size isn't signed; any server read of user bytes needs its own cap; `.mxl` `unzipSync` needs an `originalSize` filter.
- **Unbounded numbers that drive loops** (e.g. `audioLengthSeconds` → chunk count). One shared process serves everyone.
- **Presigned GET TTL 15 min** vs 10-min client cache; audio error recovery calls `refresh()` (so long sessions trigger refresh).
- **Store `refresh()` vs in-flight autosave**; no pagehide flush for debounced edits.
- **MP4 export memory** (`ArrayBufferTarget` + in-memory fastStart; download waits on S3 upload).
- **Public `/api/status`** leaks env/DB/bucket names.

From the 2026-11-12 `feat/customize-redesign` review (display undo/redo + editor chrome):
- **Undo history granularity.** Anything that fires per input event (native `<input type=color>` onChange, key auto-repeat, slider drags) floods the 100-step history unless wrapped in begin/endGesture. Radix Slider skips `onValueCommit` when the value ends where it started, so a gesture opened in `onValueChange` can leak open.
- **`refresh()` clears history by object identity**, so any refresh (incl. audio-URL recovery) wipes undo.
- **Two global keydown listeners** (editor capture-phase + `PlaybackShortcuts` bubble). `PlaybackShortcuts` ignores `defaultPrevented` and Radix roles, so Space/arrows inside menus, menubar and sliders also play/seek.
- **Counter-in-store as an imperative trigger** (`fullscreen`, `searchFocus` ticks) re-fires when the consumer remounts.
- **Narrow widths:** editor chrome hides step nav below lg and the menubar below md; `container-type:size` with no definite height shrinks the stage.

**Why:** Each item was a real defect. Merging to main auto-deploys (`.github/workflows/deploy.yml`).

**How to apply:** Grep for these patterns in new server, export, store or editor code before reading line by line. Related: [[backend-integration-scope-conflict]].
