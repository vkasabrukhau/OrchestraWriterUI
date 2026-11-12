# Sync page revamp

Instead of having components be formatted individually and put on the page,
we will have 1 large page window with sections:

Each section border is flexible and allows for more viewing space and navigation between them.
Sections may have a minimum size but can also be minimized.

- **Confidence map** – Top
  - Can reuse the current component but also display markers and current location.
- **Score** – Below confidence map
  - Right-clicking shows a popup that allows you to add a marker: "Add Marker".
  - Shows the standard score view.
- **Joint playback** – Bottom (below score)
  - Note time playback / section follower – need to handle recompute/syncing.
    - Add filters for notes.
    - Add colors or indicators for section?
    - Shows note lengths organized by pitch (Hz).
    - Creates a dotted bar that shows in the audio playback.
      - Has a solid bar in navigation that can be directly dragged (adds a marker).
  - Audio playback
    - Allow zoom in on audio and playback speed.
    - Pause/resume button will also likely be around here.
- **Side bar** – On the right. The following are sections within the side bar.
  These will be collapsible, similar to the Lightroom Classic side bar navigation.
  - Measures
    - Sort by confidence, order.
    - Filter by confidence, order.
    - Shows a list of measures that, when clicked, can jump to their location.
  - Markers
    - Shows a list of markers in order.
    - Clicking on one allows you to:
      - Rename
      - Delete
      - Jump to it
      - Edit timestamp
      - Edit note selection
  - Sync
    - Select measure range.
    - Run a syncing method.
      - Can choose rigid or smooth: at some point there will be 2 syncing
        methods that work slightly differently, and you can choose one or the other.

Whenever a marker is displayed it will have an icon. Upon press you can see its
details and edit them: note selection, timestamp.

Allow the syncing (suggested) markers (the ones that were originally created)
to be visible and editable as well (adopt as a true marker).

## Clarifications (2026-11-09)

- **Right-click, not left-click, opens the "Add Marker" popup on the score.**
  Left-click keeps setting the start point.
- **Joint playback is a piano roll:** score notes as bars by pitch (up/down)
  and time (left/right), colored by section, lined up in time with the
  recording's waveform below. A note's dotted line shows where it lands in
  the recording. Dragging its solid handle to where it really lands adds a
  marker. (Timing: superseded by "Markers are visual until a recompute"
  below; the drag adds a pending marker.)
- **Playback speed is for listening to the real recording only.** It has no
  effect on generated playback, the alignment, or the exported output.
- **Rigid vs smooth:** two syncing methods to come, which work slightly
  differently. The user picks one per run.

- **Smooth = today's tempo-fit aligner; Rigid comes later** (shown as not
  available yet).
- **Suggested markers** are the ones the syncing algorithm made automatically.
  Not a feature of this revamp. Later, the sync function itself will identify
  markers and offer them, and the user can accept or delete them. Postponed
  until that is fully clear. (Supersedes the suggested-marker lines above and
  in Open notes.)
- **The sync function is a black box for now.** How it uses markers (for
  example markers very close together) comes later, when the syncing function
  itself is changed.
- **"Next uncertain" skips bars that have a marker.**
- **Markers are visual until a recompute.** Placing or moving a marker shows
  it (score, roll, waveform) but does not change timing or playback. A
  recompute (the re-sync) applies the pending markers, updating timing and
  confidence together. This avoids far-off timestamps shifting the piece while
  markers are still being placed. After placing certain markers the app may
  suggest a recompute.
- **Bars with markers not yet recomputed get a visible mark** until a
  recompute covers them; it survives a reload. (Supersedes "bars whose timing
  changed since the last sync".)
- **Which method made which bars** isn't stored; the result message is enough
  for now.
- **Markers don't change confidence by themselves**; confidence only changes
  after re-syncing with the markers, and that re-sync's result is the
  confidence shown. (Timing also waits for the recompute; see "Markers are
  visual until a recompute".)
- **The marker icon on a Measures row opens that marker's details**, like
  marker icons everywhere else.

## Open notes

- Suggested (auto) markers exist on every bar. Show them faintly, or only on
  low-confidence bars, with "Adopt" turning one into a real marker.
- Renaming markers needs an optional label field. That is a project file
  change, and old files stay readable.
- Syncing a measure range needs the alignment worker to support partial runs.
- Resizable sections: likely `react-resizable-panels` (MIT), checked before adding.
