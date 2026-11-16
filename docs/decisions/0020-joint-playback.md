# 0020. Joint playback: piano roll over the waveform

Date: 2026-11-10
Status: proposed

## Context
The owner wants a note follower: note lengths by pitch, colored by section, lined up with the recording. A dotted line shows where a note lands, and a handle can be dragged to add a marker. The owner also asked for audio zoom and playback speed, with speed for listening only.

## Decision
- **Placement** (`src/lib/sync/roll.ts`).
  - Notes are placed at sounding pitch on the recording's clock through the audible timing.
  - Colors come from the display settings, so the roll matches Customize.
  - Each distinct onset is a handle.
- **Drawing.** One canvas (`joint/PianoRoll.tsx`) draws:
  - a pitch gutter with note names;
  - the handle lane;
  - the roll;
  - a resizable waveform lane.
- **Interaction.**
  - Time zoom is shared by the roll and the waveform.
  - Vertical zoom works separately for pitch and for waveform amplitude.
  - The playhead moves by ref.
  - Dragging a handle or pin places or moves a pending marker (ADR 0018), with no re-merge during the drag.
- **Detailed waveform.** A min/max peak pyramid (`src/lib/audio/peaks.ts`) is built once per recording. The mock falls back to the overview peaks.
- **Speed.** It reaches only the recording engine; generated playback stays at 1×.

## Consequences
- Large scores need the planned time-sliced index build and level-of-detail bins. Today the index is built in one pass when the timing changes.
- The pins on the canvas are not separate tab stops. The roll is one stop with keyboard stepping, and the marker list carries their names.
