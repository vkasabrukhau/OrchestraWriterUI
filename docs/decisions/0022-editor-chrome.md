# 0022. Editor pages use a neutral "studio" surface; the stage stays dark

Date: 2026-11-11
Status: accepted

## Context
The Customize redesign (Figma "Customization Page Mockup", frame `3:6325`) aims
for a clean, technical look like professional editing software: a menu bar, a
tool bar, docked panels, hairline borders, small type and a teal accent. ADR
0005 made Direction A (paper, ink, brass, serif titles) the default everywhere.
The mockup also puts the glows on a light stage.

## Decision
- Editor pages set `html[data-surface="editor"]`. Under it, `globals.css`
  remaps the surface, ink, line, radius and accent tokens to neutral grays,
  `#dfe3e6` hairlines, 3–6 px radii and a teal accent (`#22766b`, dark variant
  `#3fb3a1`). The `brass*` tokens keep their role as "the accent", so existing
  primitives follow without changes.
- The stage stays dark and framed. Inside `.stage-frame` the accent is reset to
  the page's original brass (`--stage-accent*`), so what Customize shows matches
  Preview and the exported MP4. A light stage would need a second brightness
  ladder and would make quiet dynamics harder to see.
- The attribute is set before first paint: an inline script in the root
  layout sets it on a full page load (`src/components/shell/editor-steps.ts`),
  and `WorkflowFrame` sets it in a layout effect on client navigation.
- Editor pages use `EditorTransport`, a compact layout of `Transport` with
  the same controls, store and `PlaybackShortcuts` (`.claude/rules/ui.md`).
- Below `md` the menu bar becomes one "Menu" button whose menus are labelled
  groups in a single list; below `lg` the step tabs become a step dropdown and
  the stage takes the full width above the other panels.
- Library, auth, Settings and the other workflow pages keep Direction A or B
  until they move to the editor chrome.
- Customize is the first editor page. Sync and Preview follow in a later branch.

## Consequences
- One codebase, three token sets (A, B, editor). The editor also has a dark
  variant when the user has chosen theme B.
- The teal accent sits near the default Woodwinds hue (`#5cba9a`). It only
  appears on the light chrome, never on the stage. The selected row in the
  Instruments panel does put a section-color dot on the teal-tinted
  highlight, so a selected Woodwinds part has two close greens side by side;
  the part name and the Properties panel still say which part it is.
- Part tints stay within ±15 % HSL lightness of the section color, so a
  tint never reads as a different dynamic. Every built-in palette gives each
  section its own hue (a test checks this).
- The mockup's 9–10 px text is raised to 10–11 px for legibility.
- Later-phase items in the mockup (pitch, articulation, harmony background,
  mappings, note trails, visual forms) are left out, per ADR 0001.
