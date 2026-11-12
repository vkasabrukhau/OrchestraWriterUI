# 0016. Score panel as a follower: fixed layout, note-level targets and markers

Date: 2026-11-08
Status: proposed (amends the paging and click parts of 0015)

## Context
The score panel (ADR 0015) drew one line of bars at a time and re-rendered on
every page turn. Compared with Sibelius, MuseScore, Dorico and Soundslice
(`docs/plan/score-navigation.md`, `docs/plan/score-viewer-critique.md`) it had
these problems:
- Line breaks depended on how you reached a bar.
- Pages turned late, at the barline.
- Follow never came back after browsing.
- Hover and the current bar looked the same.
- Every turn cost a full OSMD render. On a 42-part, 480-bar stress score that
  is about 0.5 s per render, whatever the window size.

The team set two constraints:
- The panel is a **follower, not an editor**. Its only editing is placing sync markers.
- **Large orchestral scores are the norm.**

They also asked for markers and navigation at the **note** level, not the bar.

## Decision
- **Page view, as in MuseScore, Sibelius and Dorico.** Systems are set on
  pages (A4 proportions, 1000 × 1414 layout px, as the most a page holds)
  once, and the panel shows them as sheets of paper on a desk. A page ends
  just below its music, so there is no blank space at the bottom.
  - Zooming and resizing only scale the pages (a CSS transform), so nothing
    is laid out again. Zoom is relative to fitting the page width; "Fit page"
    shows a whole page.
  - The staff size is decided once per set of visible parts, as a printed
    full score is. A system too tall for a page is made smaller. A system
    that can only go one to a page is made larger to fill it. Scores whose
    systems fit two or more to a page keep OSMD's usual size.
  - ‹ › and PgUp/PgDn turn pages. When a whole page fits the panel,
    following turns pages; otherwise it brings each system to the top and
    keeps the reader's place inside a tall one.
- **The engraver's layout first.** A score looks right in MuseScore mostly
  because the file carries its engraver's line and page breaks
  (`<print new-system/new-page>`), so we honor them too (OSMD
  `newSystemFromXML`, `newSystemFromNewPageInXML`; file page breaks start our
  pages).
  - When a file's line does not fit our page width, OSMD adds a break and
    leaves a short line. The staff size is lowered until every line starts
    where the file says, up to 5 tries.
  - Files without breaks: a chunk ends near 24 bars, at the most natural page
    turn: a final or double barline, a repeat, a fermata held by much of the
    orchestra, a rehearsal mark, or a key, time or tempo change
    (`LayoutHints.strength`). Chunk ends that would leave a short last line
    are avoided, using the bars per line seen in the first layout.
  - Every line is stretched to the full width (`stretchLastSystemLine`)
    except the score's last.
- **Laid out in chunks, on demand.** The score is laid out in chunks of 24
  written bars around the reader, and the rest as they come into view
  (`src/lib/score/sheet.ts`).
  - Each chunk starts a page and ends one, so chunks can be laid out in any
    order with the same result. Pages not laid out yet are blank placeholders.
  - A chunk is laid out from a slice of the MusicXML (`slice.ts`): the bars of
    the chunk, plus the divisions, key, time, clefs and transposition carried
    in from earlier bars, with the carried time signature hidden.
    OpenSheetMusicDisplay's cost per render grows with the whole file (about
    0.4 s on the stress score even for 8 bars). Slices make it grow with the
    chunk instead. A file that cannot be sliced is loaded whole.
  - The sheet is cut into one SVG per system (`engrave.ts`). Systems are kept
    as markup and parsed into the page only near the view.
- **Start point and playhead.** Clicking a note makes it the start point
  (`usePlayback.cue`) without moving playback.
  - Play (Space) resumes from the playhead. "Play from …" (Enter, or the
    transport chip) starts at the start point.
  - A double click plays from the note at once.
  - On Sync, the selected note is the start point.
- **Quiet indicators.** The playing bar gets a thin strip above it. The start
  point is a small ink flag with a dotted hairline. Markers are brass pins
  with a hairline. All keep their on-screen size at any zoom.
- **Every note is a target.** A click snaps to the nearest onset on the staff
  under the pointer, and a dashed line with a label shows where it will start.
  Shift-click a second note to repeat the passage from the start point. The playback store has a
  `range`, in transport time.
- **Note-level markers.** `ManualMarker.position` (0–1, fraction of the bar in
  score time; absent = the downbeat). `mergeAlignment` treats every marker as
  an anchor, re-timing between anchors proportionally as before. Markers
  inside a bar become `MeasureAlignment.points`, and the clock maps are
  piecewise linear through them. The aligner still works per bar, and
  confidence stays per bar.
- **Navigation:**
  - Go to (Cmd/Ctrl+G) takes printed bar numbers, rehearsal marks
    (`MeasureInfo.rehearsal`, now parsed) and recording times.
  - An overview ruler shows the whole piece: rehearsal marks, tempo changes,
    the bars on screen, the repeated passage, markers and the playhead.
    A click browses; Shift-click or a double click plays.
  - ←/→ step note by note, Cmd/Ctrl+←/→ bar by bar, Shift+←/→ ±5 s,
    PgUp/PgDn browse lines.
  - Browsing pauses Follow and shows "Playing bar N · Back". Any seek or Back
    resumes it.
- Zoom presets add "Fit system", and the panel has a "taller" toggle.

## Consequences
- Measured on the 42-part, 480-bar stress score (Chromium, dev build):
  - About 4 s to the first page.
  - Zoom and resize take 0.3–0.4 s, with no new layout.
  - Go to bar 400 takes about 2–3 s, because its pages are laid out on arrival.
  - A chunk takes about 0.35 s.
  - No redraws while following.
- The demo score lays out at once (two chunks).
- Each chunk starts a page, so the last page of a chunk can be short.
- Page numbers are exact once every chunk is laid out. Until then the
  header shows "Page n" without a total.
- The page's JS heap is about 0.9 GB on the stress score whether or not the
  score panel is open. That memory is outside this change and should be
  looked at separately (synth audio and info map are the likely holders).
- The marker format gained an optional field. Old projects and `.ovproj`
  files read as downbeat markers, and the server validates `position` in [0, 1].
- `src/lib/score/pages.ts` (one-line paging) is gone.
- The geometry still reads OSMD's graphical model, which is not public API.
  An OSMD upgrade should re-run `tests/e2e/score-navigation.spec.ts`.
- Beats in labels come from the score's first time signature. A piece that
  changes meter labels beats by that signature.
- The schematic fallback (`ScoreStrip`) keeps bar-level clicks.
