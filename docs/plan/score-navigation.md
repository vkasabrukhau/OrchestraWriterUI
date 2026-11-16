# Score panel navigation plan

Date: 2026-11-08 · Branch: `feat/integrated-sync` (to move to its own branch)
Scope: MVP requirement 7 ("navigate score pages independently of the playing
measure; click a measure to start; controls and current-measure highlight").
Nothing here touches later-phase items (pitch, articulation, mappings).

## Status (2026-11-08)
Built on `feat/integrated-sync` (ADR 0016):
- Fixed layout with virtualized systems
- Note-level markers and clicks
- Go to (bars, letters, times) and the overview ruler
- Back to playhead
- Note and bar keys
- Passage repeat
- Hover start line
- Bar and beat readout
- Fit-system zoom and a taller panel

P8 (next line) is covered by the continuous layout. Roving focus is not done.

## 0. Constraints (from the team, 2026-11-08)
- **Follower, not editor.** The only editing is placing and adjusting sync markers. Drop editor features: selection models, element navigation.
- **Large scores are the norm:** many parts (up to 64) and hundreds of bars. Anything that scales with score size is built and measured for that case first:
  - Line breaks: compute them once for the whole score, but **draw only the systems near the view** (a virtualized window). Never draw the whole score into the DOM.
  - Spike first: time OSMD layout and render on a large fixture. Add a CC0 symphony from OpenScore to `fixtures/` (the demo is about 330 KB). If full layout is too slow, compute breaks in chunks in the background.
  - Fit-system zoom is unreadable at 30+ staves in 460 px. Pair it with a taller or fullscreen panel, and scroll to the staff group that is playing.
  - The overview ruler aggregates bars at 500+ (ticks for rehearsal letters only). Tooltips and labels must be checked at 64 parts.

## 1. What the reference tools do

| Tool | View vs playhead | Going to a place | What is clickable | Overview / structure | Looping / range |
|---|---|---|---|---|---|
| **Sibelius** | Playback line (green) is separate from the view; "score follows playback line" option | Go to Bar (Ctrl/Cmd+Alt+G) | Click anywhere sets the playback line; Space plays from it; select an object + P plays from it | **Timeline** panel (replaced Navigator in 7.5): bars, rulers, repeats, replay line; outlined box = area in view, drag to scroll; click a ruler moves the playback line | Selection playback |
| **MuseScore 4** | "Pan score during playback" toggle; cursor only follows while playing | Find/Go to (Ctrl/Cmd+F): bar number, `pN` page, `rN` / name for rehearsal mark | Select note/bar, Play starts there; Ctrl/Cmd+←/→ moves one bar; PgUp/PgDn one screen; Home/End | **Navigator** (page thumbnails, blue in-view box, drag) and **Timeline** (meta rows: key, time sig, tempo, rehearsal marks, barlines, jumps; click a cell selects that bar and scrolls the score; eye icon per instrument) | Loop in/out from a selection, flags in the score; Rewind goes to loop start |
| **Dorico** | Playhead following can be switched off; view and playhead move separately | Go to Bar (Cmd/Ctrl+G); **jump bar** takes bars, rehearsal marks, pages, flows | Space plays from the playhead and scrolls to it | Play-mode tracks | Selection |
| **Soundslice** (web, closest to us: notation synced to a recording) | Scroll modes: keep playhead at top / only when necessary / middle / left / off; manual scroll allowed, autoscroll snaps back when playhead leaves screen | — | Click a note: playhead jumps there. **Drag across the music sets a loop** (snaps to notes/barlines); click clears it | Scrollable vs paged layout | Loop, "play loop once", speed, speed trainer |
| **Newzik / forScore / Enote / BEATIK** (readers) | Auto page turn from listening | Bookmarks, page jumps | Tap edges to turn | — | **Half-page turns**: top half shows the next bars while you finish the bottom half |

Keyboard conventions that recur: Space play/pause, Cmd/Ctrl+←/→ by bar,
PgUp/PgDn by page or screen, Home/End, a "Go to" field that accepts bar
numbers *and* rehearsal marks, `<`/`>` for speed (Soundslice).

## 2. What we have now (`EngravedScore.tsx`, ADR 0015)

- One-line pages; ‹ › buttons; header "Bars 9–13".
- Click a bar: seek to the nearest note (Preview) or bar (Sync).
- Current-bar tint, red playhead gliding between onsets, confidence ticks on Sync.
- Follow toggle; manual paging turns Follow off; vertical auto-scroll keeps the reader's staff group.
- Zoom 67–200%. Transport: Space, ←/→ ±5 s, Shift ±30 s, Home, M, rate 1/0.75/0.5, loop the whole piece.

Gaps against the references:
1. No way to type a bar or a rehearsal mark. The info map has no rehearsal marks.
2. No overview of the piece (where am I, where are the sections, what is on screen).
3. After browsing away there is no "back to the playhead". The user has to find the Follow toggle.
4. No bar-wise keyboard navigation; the bars are not keyboard reachable as a group.
5. Loop covers only the whole piece. You can't drill one passage.
6. A click gives no preview of where playback will start, and no bar/time tooltip.
7. You can't see ahead: one line at a time, with no next line.
8. In tall orchestral systems there is no "fit the system" zoom.

## 3. Plan (ordered; each step ships on its own)

### P1. Rehearsal marks and score landmarks in the info map  *(score-engineer)*
- Parse `<direction-type><rehearsal>` into `MeasureInfo.rehearsal?: string` (playback order; repeated bars keep it).
- Expose landmarks via `src/lib/score/landmarks.ts`: rehearsal marks, tempo changes (`timing.tempo`, plus `<words>` like "Allegro" when present), key/time changes, double barlines and repeat starts.
- Old info maps: the field is optional, so landmarks are just empty.
- Tests: fixtures with letters, numbers, boxed marks, repeats.

### P2. Go to bar / rehearsal mark
- A small field in the score header ("Go to…", Cmd/Ctrl+G focuses it). It accepts `42`, a printed label (`12a`), a rehearsal mark (`B`, `rB`), or a time (`1:23`).
- Enter seeks there (playback state unchanged) and draws that page. Esc closes.
- Pure parser `resolveGoTo(query, infoMap)` with unit tests. It shows an error hint, not a toast.

### P3. Overview ruler (a light Timeline/Navigator)
- A thin strip under the header with every bar, proportional to score time:
  rehearsal-mark flags, tempo/key change ticks, the bars on the current page as an
  outlined box (Sibelius/MuseScore), the playhead position, and confidence colors on Sync
  (replacing nothing; ConfidenceStrip stays on Sync).
- Clicking the strip shows that page. It does not seek, so you can browse without losing your place. Shift/double-click seeks. Hover shows "Bar 42 · B · 1:23".
- Draws from the info map only; OSMD is not needed, so it also works with the schematic fallback.

### P4. Browse vs follow, with "Back to playhead"
- Any manual navigation (‹ ›, ruler, Go to without seek, scroll past the system) pauses Follow, as today.
- A pill appears: "Playing bar 57 — Back" (Soundslice-style snap back). The keyboard shortcut is `F`.
- Follow turns back on by itself when the user seeks (click a bar, Go to, transport).
- Keep the toggle for people who never want auto-turns.

### P5. Keyboard and focus
- Cmd/Ctrl+←/→: previous/next bar (seek). PgUp/PgDn: previous/next page (browse). Cmd/Ctrl+Home/End: first and last bar.
- Bar overlay buttons become one roving-tabindex group: Tab enters at the current bar, ←/→ move focus, Enter plays from there.
- Update the Transport tooltips and a shortcut list (the `?` popover).

### P6. Loop a passage (A–B)
- On the engraved score, drag across bars (or Shift-click a second bar) to select a range.
  A floating chip offers "Loop bars 12–16" and "Play from 12". Click elsewhere or Esc clears it.
- `playback` store: `loop: false | { start, end }` in recording time via `useProjectTiming`.
  The whole-piece loop stays as the default loop button. Home and the start button go to the loop start (MuseScore).
- The range is tinted brass on the page and on the overview ruler.
- Sync keeps bar-level selection (markers); the loop works there too, for checking one passage.

### P7. Click affordances
- Hovering a bar shows a faint start line at the onset where a click would start (`fractionAtX` already finds it), plus a tooltip "Play from bar 42, beat 3 · 1:23".
- Rehearsal mark and tempo text are part of their bar's hit area. No new targets: everything clickable stays "start here".
- Transport readout gains the beat: "Bar 42.3 / 502" (MuseScore toolbar).

### P8. See ahead (half-page turn)
- Option "Show next line": draw two lines. When the playhead enters the second line, the top line is replaced by the following one (Newzik half-page turn), so the reader always sees what comes next.
  The cost is one more window render per turn, so it is measured on the 64-part fixture before it becomes the default.

### P9. Fit zoom presets
- The zoom menu gains "Fit width" (default) and "Fit system height", which scales so a whole orchestral system fits the panel's 460 px.
  This addresses ADR 0015's tall-system consequence better than scrolling to the staff group.

### Not doing (and why)
- Page-thumbnail Navigator: our pages are one line, so the ruler (P3) does the job.
- Clicking part names to solo or hide: hiding lives in Customize. Highlighting one part's glow from the score is a later idea; first check it against "match the score".
- Continuous horizontal (Panorama) view: a big OSMD layout change. Revisit after P8.
- Listening-based following: we already align with the recording.

## 4. Verification
- Unit: `resolveGoTo`, landmarks, loop range ↔ recording time, keyboard map.
- Component (jsdom, schematic fallback): ruler click/hover, Back pill, Go to.
- Chromium, by hand plus a Playwright spec: demo fixture and 64-part fixture. Check paging, Go to `B`, A–B loop across a repeat, follow and snap-back during playback, reduced motion.
- Record the decisions in an ADR (0016, score navigation) when P3/P6 land.

## Sources
- MuseScore 4 handbook: [Navigating your score](https://handbook.musescore.org/en_gb/navigation/navigating-your-score), [Timeline](https://handbook.musescore.org/en_gb/navigation/timeline); forum: [Loop playback in MS4](https://musescore.org/en/node/339134), [Following the cursor during playback](https://musescore.org/en/node/333911), [Play from selection](https://musescore.org/en/node/323942)
- Sibelius: [Timeline tips](https://metalworksinstitute.com/sibelius-tips-using-the-new-timeline-feature/), [Keyboard shortcuts (CCARH)](https://wiki.ccarh.org/wiki/Sibelius_Keyboard_Shortcuts), [Timeline (Steinberg forum)](https://forums.steinberg.net/t/timeline/96574)
- Dorico: [Going to bars](https://steinberg.help/dorico/v4/en/dorico/topics/write_mode/write_mode_navigation/write_mode_navigation_go_to_bar_t.html), [Jump bar](https://www.steinberg.help/r/dorico-pro/5.1/en/dorico/topics/user_interface/user_interface_jump_bar_going_to_locations_t.html), [Playhead following](https://www.steinberg.help/r/dorico-pro/5.1/en/dorico/topics/play_mode/play_mode_playhead_following_enabling_disabling_t.html)
- Soundslice: [Looping](https://www.soundslice.com/help/en/player/basic/4/looping/), [Playhead scrolling options](https://www.soundslice.com/help/en/player/advanced/116/playhead-scrolling-options/), [Keyboard shortcuts](https://www.soundslice.com/help/en/player/tips/1/keyboard-shortcuts/), [Keep playhead in middle](https://www.soundslice.com/blog/253/new-keep-playhead-in-middle-of-screen/)
- Readers: [Newzik vs forScore](https://en.blog.newzik.com/blog/newzik-vs-forscore), [Enote page turning](https://www.classicfm.com/music-news/enote-sheet-music-app-turns-pages-digital-scores/), [BEATIK (CORDIS)](https://cordis.europa.eu/article/id/421955-tablet-system-replaces-sheet-music)
