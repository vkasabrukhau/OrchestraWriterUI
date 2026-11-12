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
- Stage stays dark. New neutral "studio" color set (teal accent) on editor pages only. The editor header goes on Customize first; Sync and Preview follow. Recorded in [ADR 0014](../decisions/0014-editor-chrome.md) (proposed).
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
- Needs review: `.claude/rules/ui.md` says Sync, Customize and Preview use "the same component" for playback controls, but `EditorTransport` is a second one. Note this in ADR 0014 or update the rule.
- The teal accent `#22766b` is close to the default Woodwinds `#5cba9a`.
- 64-part performance is not measured. No mock score has 64 loadable parts.

**Next steps**
1. Fix should-fix items 1–5 and 7. Add a test that undo survives `refresh()`.
2. Narrow the tints (about ±15 % lightness) and remove or rework the "Brass tints" palette.
3. Settle the `ui.md` / `EditorTransport` exception and accept ADR 0014.
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
