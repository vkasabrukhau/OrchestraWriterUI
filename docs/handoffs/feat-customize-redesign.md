# Handoff log — feat/customize-redesign

Append-only. Newest entry at the bottom. Written by `/handoff`.

---

## 2026-11-12 — Customize redesigned as a desktop-style editor (Figma mockup)

**Done**
- Editor header (`src/components/editor/*`, `src/lib/editor/commands.ts`, `src/lib/store/editor.ts`, `src/components/ui/Menubar.tsx`):
  - Menu bar with File, Edit, View, Playback, Parts and Help.
  - Toolbar with select, lock layout, undo/redo, reset positions, the bar counter, step tabs, Save and Continue to Preview.
  - One command list drives the menus, the toolbar and the keyboard shortcuts.
  - `WorkflowFrame` uses this header on `/customize` only; the other steps keep `WorkflowNav`. Both share `StepTabs` and `useSaveStatus`.
- Customize page (`src/components/customize/*`):
  - Instruments panel: search, filter, and a live "Playing · dyn / Rest / Hidden" line per part.
  - Stage that fits the space left over and can go full screen.
  - `EditorTransport` and `PartLanes` (per-part activity from the info map).
  - Properties panel: part mode (color, tints, section, X/Y %, visibility) and stage mode (section colors, glow, labels, brightness).
- Store (`src/lib/store/project.ts`): display undo/redo (100 steps, gestures group drags into one step), `resetPart` and `rename`. `Stage` gained `onMoveStart`/`onMoveEnd`, `locked` and keyboard focus.
- Tokens (`src/app/globals.css`): an editor color set under `html[data-surface="editor"]`, with a dark variant. The stage keeps the brass accent through `--stage-accent*`.
- Tests:
  - Unit: `tests/unit/api/display-history.test.ts`, `tests/unit/editor/*`, `src/components/editor/useEditorShortcuts.test.tsx`.
  - End-to-end: `tests/e2e/customize-editor.spec.ts`; `workflow-recording.spec.ts` now picks the level-2 heading.

**Decisions**
- Stage stays dark. New neutral "studio" color set (teal accent) on editor pages only. The editor header goes on Customize first; Sync and Preview follow. Recorded in [ADR 0022](../decisions/0022-editor-chrome.md) (proposed).
- Left out the mockup's later-phase items: pitch, articulation, harmony background, Mappings tab, note trails, visual forms, Dynamic glow toggle, opacity, and the Adobe logo.
- Glow size stays global. A per-part size would read as loudness.
- No Hand or Move tools until the stage can zoom and pan.
- "Open project file…" goes to Import, and "Export…" goes to the Export page.

**Open questions / blockers**
- Should-fix items from the reviewer (not fixed yet):
  1. `PlaybackShortcuts` reacts to Space and arrow keys inside menus and sliders. Space on Playback > Play toggles playback twice, so nothing happens.
  2. Undo history floods or stays merged:
     - native color picker input events
     - auto-repeat when an arrow key is held to nudge
     - the glow slider gesture stays open when its value ends where it started
  3. `refresh()` (also run on audio error recovery) clears undo because it compares objects by identity. Compare by value instead.
  4. The `fullscreen` and `searchFocus` counters run again when Customize remounts.
  5. Below `lg` the step tabs are hidden, below `md` the menu bar is hidden, and the stage shrinks below `lg`.
  6. Dark/light tints of ±35–55 % compete with brightness, and the "Brass tints" palette puts every section in one hue.
  7. Disabled shortcuts still swallow their keys (e.g. Escape with nothing selected).
- Needs review: `.claude/rules/ui.md` says Sync, Customize and Preview use "the same component" for playback controls, but `EditorTransport` is a second one. Note this in ADR 0022 or update the rule.
- The teal accent `#22766b` is close to the default Woodwinds `#5cba9a`.
- 64-part performance is not measured. No mock score has 64 loadable parts.

**Next steps**
1. Fix should-fix items 1–5 and 7. Add a test that undo survives `refresh()`.
2. Narrow the tints (about ±15 % lightness) and remove or rework the "Brass tints" palette.
3. Settle the `ui.md` / `EditorTransport` exception and accept ADR 0022.
4. Fix the nits:
   - Set `data-surface` before first paint.
   - Bind the editor store during render.
   - Give `useEditor` selectors in `useEditorCommands`.
   - Use `role="group"` on the stage instead of `application`.
   - Match letter shortcuts by `key`, not by physical key.
5. Measure a 64-part score at 60 fps, then open the PR and update the Customize row in STATE.md in that PR.
6. Follow-up branch: move Sync and Preview to the editor header.

**Verified by**
- `npm run lint`: clean. `npm run typecheck`: clean. `npm test`: 38 files, 320 tests passed.
- `npx playwright test`: 13/13 passed. Run in system Chrome (`channel: "chrome"`, video off) through a temporary config, because Playwright's browsers aren't installed here.
- Manual, on the mock API: screenshots at 1600×1000 and 1440×900 in light and dark.
- Frame rate while playing, headless (22 parts): Customize 29.3 fps vs Preview 28.8 fps, after moving part activity out of the page's state (it was 9 fps before).
- Reviewer agent: no blockers; the should-fix items are listed above.

---

## 2026-11-12 — Reviewer should-fix items, tints, responsive header, 64-part measurement

**Done** (uncommitted on the branch)
- Shortcuts (`Transport.tsx`, `useEditorCommands.ts`, `lib/editor/commands.ts`):
  - `PlaybackShortcuts` leaves Space, the arrow keys and Home to menus, sliders, lists and dialogs. It also leaves Space to keyboard-focused buttons, ignores ⌘/Ctrl/Alt combinations, and doesn't repeat Space while it's held.
  - A disabled plain-key shortcut now passes its key through. A disabled ⌘/Ctrl shortcut is still consumed, so the browser's ⌘S doesn't open.
  - Letter shortcuts match by `key`. The `code` fallback applies only when Alt is held (for ⌥1 on macOS).
  - `useEditorCommands` uses `useEditor` selectors.
- Undo (`lib/store/project.ts`, new `lib/utils/equal.ts`):
  - New `EditOptions.merge` key: edits with the same key less than 1 s apart (`MERGE_WINDOW_MS`) become one undo step. Used for the color pickers, the glow slider (which replaces the gesture that could stay open), and held arrow keys (one step per key press).
  - `refresh()` compares the display by value, ignoring the key order that jsonb changes, and keeps the history and the local object when nothing changed.
- Editor store and surface (`lib/store/editor.ts`, `WorkflowFrame.tsx`, new `shell/editor-steps.ts`, `app/layout.tsx`):
  - `useEditorRequest` subscribes to the `fullscreen`/`searchFocus` counters, so a remount no longer replays an old request.
  - `bind` and `data-surface` are now set in layout effects, and an inline `<head>` script sets the surface on a full page load.
  - The stage uses `role="group"`.
- Responsive (`EditorChrome.tsx`, `ui/Menubar.tsx`, `StepTabs.tsx`, `CustomizePage.tsx`):
  - Below `md` there is one "Menu" button. Its submenus show as labelled groups in one scrolling list (`inlineSubs`).
  - Below `lg` the step tabs become a `StepMenu` dropdown and the stage is full width.
  - Below `sm`, Save is icon-only, the Continue button reads "Preview", and the `EditorTransport` scrubber wraps to its own row.
- Color (`customize/color.ts`, `palettes.ts`):
  - Tints are 5 steps within ±15 % HSL lightness.
  - "Brass tints" is replaced by "Color-blind safe" (Okabe–Ito hues). A test checks that every palette has one distinct hue per section.
- Performance (`music/Waveform.tsx`): the bar `<rect>`s are memoized, so the per-frame re-render while playing only moves the clip.
- Docs: `.claude/rules/ui.md` names `EditorTransport` as the editor variant. ADR 0022 records the surface script, the transport, the narrow layouts, tints, and that teal sits next to the Woodwinds dot on a selected row.

**Decisions**
- Undo coalescing is time-window based (merge key + 1 s), not open/close gestures, so a missed end event can't leave a step open. Drags still use gestures.
- `bind` runs in a layout effect, not during render. This avoids zustand "update while rendering another component" warnings, and the stale first render is never painted.
- On a disabled shortcut, ⌘/Ctrl combinations are still consumed and plain keys pass through.
- ADR 0022 was updated but is still **proposed**. Accepting it needs a human.

**Open questions / blockers**
- Accept ADR 0022 (including the `EditorTransport` exception now in `ui.md`)?
- Is "Color-blind safe" the right replacement for "Brass tints", or should the palette just be dropped?
- Teal accent next to the Woodwinds dot on a selected row: accept or change the selection color?
- Preview still does a lot of per-frame React work while playing. At 4× CPU throttle with 64 parts it runs about 10 frames/s (Customize 18). The same happens with fewer parts. Track it as its own perf task, which would cover the remaining `usePlayback(s => s.time)` subscribers.

**Next steps**
1. Get the decisions above, then commit and open the PR. Update the Customize row in STATE.md in that PR.
2. Follow-up perf branch: profile Preview's per-frame renders with 64 parts on a slow CPU.
3. Follow-up branch: move Sync and Preview to the editor header.
4. Optional: commit a 64-part fixture (cycle the demo parts, as done by hand this session in `/tmp`) so the perf check can be re-run.

**Verified by**
- `npm run lint`: clean. `npm run typecheck`: clean. `npm test`: 38 files, 336 tests passed (16 new: merge keys, refresh keeps undo, held vs tapped arrows, Space in menus, arrows in sliders, disabled shortcuts, layout-aware letters, no replay on remount, tint range, palette hues).
- `npx playwright test`: 13/13 passed, in system Chrome through a temporary config. `customize-editor.spec.ts` gained two steps: Space on Playback > Play starts playback once, and the 390 px layout (Menu button groups, step menu, full-width stage).
- Screenshots at 390, 820 and 1440 px: no horizontal scroll at 390 (`scrollWidth` 390).
- 64-part score (demo parts cycled), playing, headless Chrome, CDP metrics. Before → after the Waveform fix: Customize 1× was 67 % busy at about 55 frames/s, now 50 % busy at 60 frames/s; 4× went from about 11 to 18 frames/s. Preview 1×: 73 % → 50 % busy, 56 frames/s; 4× about 10 frames/s. Per-frame rAF work stayed small (p95 < 1 ms at 1×).

**Addendum (same day):** ADR 0022 accepted and the "Color-blind safe" palette kept (decided by the user). STATE.md rows 4 and Customize updated for the PR. Still open: teal accent beside the Woodwinds dot on a selected row; Preview per-frame perf (now in STATE.md known breakage).
