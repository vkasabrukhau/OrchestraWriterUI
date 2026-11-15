# 0023. Customize uses the Sync page's header, colors and window frame

Date: 2026-11-15
Status: proposed

## Context
ADR 0022 gave the Customize editor its own token set: neutral grays and a
teal accent. Sync, the step just before it, uses Direction A (paper, ink,
brass) or B, and shows its workspace as one bordered window. Going from Sync
to Customize felt like moving into a different app: a different header
(menu bar plus tool bar with its own step tabs and Save), and a teal accent
that sat next to the Woodwinds hue (an open question in ADR 0022).

## Decision
- `html[data-surface="editor"]` no longer remaps colors. Customize uses the
  same paper, ink and brass as Sync, in both themes. The editor keeps its
  tighter radii (4–12 px) and lighter shadows for the dense tool chrome.
- Customize uses the same workflow header as every other step
  (`WorkflowNav`: back to library, logo, step tabs, save status, Save,
  account menu), at the same size.
- Below it, the editor sits in one bordered, rounded window, like the Sync
  workspace. The window's top row is the editor tool bar: the menus (File,
  Edit, View, Playback, Parts, Help), the select and lock tools, undo/redo,
  reset positions, the project name (click to rename, at `xl` and up) and
  "Continue to Preview", the same `Button` as Sync's "Continue to
  Customize". Below `sm` its label shortens to "Preview".
- The "Bar N of M · K of N parts shown" readout is dropped from the tool bar:
  the transport shows the bar and the Stage header shows the parts count.
  The editor's step tabs and step dropdown are removed; the header's step
  list replaces them at every width.
- Panel titles (Instruments, Stage, Properties, Part lanes) use the Sync
  sidebar's uppercase section style. The play button is ink, like Sync's.
- Side by side (`lg` and up), the borders of Instruments, Properties and
  Part lanes drag to resize them (`Splitter`; arrow keys when focused,
  double-click or Enter resets). The 16:9 stage refits the space left over.
  Limits: instruments 200–440 px, properties 260–480 px, lanes 120–640 px;
  the stage keeps at least 420 px of width and 340 px of height, and side
  panels shrink (properties first) when the window can't fit them. Sizes are
  remembered per browser (localStorage `ov:editor-layout:v1`), never in the
  project, like the Sync layout (ADR 0017).
- Panels, part lanes, keyboard shortcuts and every command otherwise stay as
  ADR 0022 describes them.

## Consequences
- Two token sets (A and B) instead of three; the editor's dark variant is
  now Direction B.
- A selected Woodwinds part no longer has two close greens side by side.
- Brass on the chrome is now the same hue as the stage accent. The stage is
  still framed and dark, so the two stay apart.
- Supersedes the colors and the header layout of ADR 0022; the rest of it
  stands.
