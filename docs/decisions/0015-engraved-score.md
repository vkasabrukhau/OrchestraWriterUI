# 0015. Score panel: engraved notation with OpenSheetMusicDisplay

Date: 2026-11-03
Status: proposed (moves "engraved notation (OSMD)" out of the later-phase backlog); paging and clicks amended by 0016

## Context
The score panel on Sync and Preview (`ScoreStrip`) was schematic. It drew five
decorative lines per part and bar, with note dots spaced by their index
(not their time) and pitch mapped linearly from MIDI 40–96 with no clef.
The SVG was stretched with `preserveAspectRatio="none"`. It could not be
read as music. The team asked for real notation. ADR 0008 kept rendering
separate from the info map so it could be added from the same MusicXML.

Options from `docs/research/sync-and-instrument-identification.md`:
OpenSheetMusicDisplay (BSD-3-Clause) renders MusicXML to SVG in the browser.
Verovio is LGPL-3.0 and excluded by the license policy.

## Decision
Render the uploaded MusicXML with **opensheetmusicdisplay 2.2.1** (pinned).
Its runtime dependencies are vexflow 1.2.93 (MIT), jszip 3.10.1 (MIT or
GPL-3.0; used under MIT), loglevel (MIT) and typescript-collections (MIT).
It is loaded with a dynamic `import()`, so it only downloads with the score
panel.

- `ScoreView` fetches the score text (`api.fetchScoreXml`; `.mxl` is
  unzipped by the shared decoder). It shows `EngravedScore` when OSMD can
  load and draw the file, and falls back to the schematic `ScoreStrip` when
  there is no file (mock API) or OSMD fails.
- A page is **one line** of written bars, measured as it is drawn: each
  page draws a window of up to 12 bars (`drawFromMeasureNumber` /
  `drawUpToMeasureNumber`), keeps the line OSMD put first and clips the rest.
  The next page starts after that line, and known pages are remembered
  until the width, zoom or hidden parts change (`src/lib/score/pages.ts`).
  So the bars per page follow the music and the panel width, at the cost of
  one window render per page, as before; nothing is laid out ahead. The
  page count is unknown up front, so the header shows "Bars 9–13". A jump
  to a bar on no known page starts a page there, and "previous" from it
  steps back about one line; paging forward never skips a bar.
- An overlay positioned from OSMD's graphical measures gives click-to-play,
  the current-bar highlight and the Sync confidence colors. It does not use
  OSMD's cursor.
- A red playhead (`--score-playhead`) follows the score clock inside the
  bar, after Score Sync Lab's continuous cursor: it sits on each note onset
  (OSMD staff entries) and glides between them, resolved per bar so it
  never slides across a system break. Whole-bar rests are engraved centered,
  so a bar where every visible part rests sweeps from the end of the
  clef/key/time area instead. With reduced motion it steps from onset to
  onset (`src/lib/score/playhead.ts`). It is geometry only; alignment and
  audio times are unchanged.
- The panel scrolls to the system being played when playback reaches a new
  one (Follow on), so a manual scroll within a system is kept. A zoom
  control (67–200% of the default) redraws the page.
- On Preview a click starts from the nearest note in the bar
  (`seekScoreTime`). Sync keeps bar-level clicks, since markers are per bar.
- Notation is in written order; playback and sync are in playback order
  (repeats expanded). The parser now records `MeasureInfo.writtenIndex`
  when the two differ. Info maps saved earlier fall back to the printed
  labels (`src/lib/score/written.ts`). A click on a repeated bar goes to
  the occurrence nearest the playhead.
- Hidden parts (Customize) are hidden in the notation too
  (`Instrument.Visible`, matched by MusicXML part id).
- The sheet uses a `--score-paper` token and stays light in both themes
  (OSMD draws in black).

## Consequences
- Adds about 2.3 MB unpacked (OSMD plus vexflow) to `node_modules` and a
  lazily loaded client chunk. The server bundle is unchanged.
- OSMD cannot render in jsdom: component tests cover the fallback, and the
  engraved path was checked in Chromium on the demo fixture (Sync and
  Preview, paging, repeat, click, follow during playback).
- A full orchestral system is taller than the panel (14 staves at zoom 0.6),
  so lower staves need scrolling. Auto-scroll lands on the top of the
  system; scrolling to the staff group that is playing is a possible
  follow-up.
- The playhead reads OSMD's graphical staff entries, which are not public
  API guarantees; an OSMD upgrade should re-check the playhead in Chromium.
- D.C./D.S. jumps are not followed by the parser (0008), so written and
  playback order differ only for simple repeats.
