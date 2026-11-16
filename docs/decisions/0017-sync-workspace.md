# 0017. Sync workspace: one window, sections divided by lines

Date: 2026-11-10
Status: proposed

## Context
The owner asked for the Sync page as one window with flexible, minimizable sections:
- a confidence map, the score and joint playback;
- a Lightroom-style sidebar with Measures, Markers and Sync (`docs/plan/sync-page-revamp.md`).

During the build they asked for as little buffer as possible:
- no title row and no section title bars;
- one box, with one line between sections;
- the score controls floating over the score;
- a help button instead of hint text.

## Decision
- **The workspace (`src/components/sync/workspace/`)** is one bordered box.
  - The left column stacks the sections in `ui/Panes.tsx`.
  - Each 1 px line is the resize handle, usable by drag or by keyboard (arrows, Home/End; Enter minimizes the section below).
  - A section minimizes to a thin strip that restores it, and its room goes to the others.
- **The sidebar** is on the right.
  - Its sections open and close independently; Alt-click opens only one.
  - Its header holds Continue, Help, the counts and the recompute suggestion.
  - Cmd/Ctrl+\ hides it, leaving a thin rail.
- **Panes are built in-house**, not with `react-resizable-panels`. The stack is small: about 150 lines, no new dependency, and full control of the score's width.
- **The layout is remembered per browser** in localStorage (`ov:sync-layout:v1`).
  - It is written only on user changes.
  - It is not in the project or the profile.
- **The score fills its section** (`EngravedScore` `fill`).
  - Its controls float over its top.
  - The overview ruler is hidden on Sync, because the confidence map is the overview.

## Consequences
- The score's width now has to be constrained explicitly (`min-w-0` up the tree). Without it, zooming widened the score's own container in a loop.
- No overlay sidebar for narrow windows yet; the sidebar can be hidden instead.
