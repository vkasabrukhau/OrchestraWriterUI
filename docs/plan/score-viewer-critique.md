# Score viewer critique (current implementation vs reference apps)

Date: 2026-11-08. Companion to `score-navigation.md`. Based on reading
`EngravedScore.tsx`, `pages.ts`, `playhead.ts`, `written.ts`,
`useProjectTiming.ts`, `playback.ts` and `Transport.tsx`, compared with Sibelius
(desktop and Cloud viewer), MuseScore 4, Dorico, Soundslice and Notation Composer.
I have not yet checked any of this by hand in the browser. Items marked *(code)* follow directly from the source.

## Findings, worst first

### 1. Line breaks depend on how you got there *(code)*
`pageStartFor` returns the bar itself when no remembered page holds it, so after a
seek, a 30 s skip or a resize, the page **starts at the playing bar**. OSMD then
breaks the lines differently. The same bar can open a line one time and sit
mid-line the next. Every reference app keeps a fixed layout (Sibelius and
MuseScore page view, Soundslice systems), so readers learn where things are on the page.
**Fix:** lay out line breaks once per width, zoom and visible parts, for the whole
score. Render the whole score with OSMD 2.x batched rendering, or compute the
breaks in one pass, then turn pages by scrolling, not by re-rendering.

### 2. The page turns late *(code)*
Follow turns the page only when the current bar leaves it, at the barline.
You never see the next line before it is played. Notation Composer turns a set
number of beats early; Newzik uses half-page turns; Soundslice keeps the playhead
at the top or middle with music visible below; Sibelius Cloud keeps "the music
being heard always visible".
**Fix:** turn about one beat to one bar early, or show the next line (plan P8).

### 3. Follow never comes back *(code)*
‹ › sets `follow = false`, and nothing but the toggle restores it. If you browse,
click a bar and press play, playback runs off the page and the view stays put.
Soundslice's autoscroll snaps back as soon as the playhead leaves the screen, and
MuseScore follows whenever it plays.
**Fix:** re-enable Follow on any seek or on play. When browsing, show the "Back to
playhead" pill (plan P4).

### 4. Hover and the current bar look the same *(code)*
The active bar is `bg-brass/10` and hover is `hover:bg-brass/10`. Moving the mouse
over the score creates a second "current bar". Sibelius and MuseScore separate
the playback line from the selection or hover.
**Fix:** use a stronger tint or an outline for the current bar. For hover, use a
faint tint plus a start-line preview (plan P7).

### 5. Each page turn is a full OSMD render *(code; cost not measured)*
Each turn re-renders a window of 12 bars across all visible parts. At 64 parts
this risks a visible hitch during playback, right when the reader is moving
their eyes. The reference apps scroll a layout that is already drawn.
**Fix:** same as #1. Measure on the 64-part fixture first.

### 6. The page is a single line inside a 460 px box with its own scroll
An orchestral system is taller than the box. The reader gets an inner scroll,
auto-scroll to the system top, and clipping of later lines, three mechanisms
that interact (the `systemRef`/`viewRef` bookkeeping exists to keep them sane).
Sibelius, Dorico and Soundslice offer "fit" zooms and either paged or continuous
layouts, not a clipped single line.
**Fix:** add a "Fit system" zoom (plan P9). Consider a continuous vertical view
of the whole score, scrolled (Soundslice "keep playhead at top").

### 7. Orientation is thin
The header shows "Bars 9–13" with no total and no page count. While you browse,
the playhead simply disappears, with no hint of where playback is. MuseScore's
toolbar shows bar.beat and time, and Sibelius and MuseScore have a Timeline with
an in-view box.
**Fix:** "Bars 9–13 of 120", the overview ruler (P3), and bar.beat in the transport.

### 8. Click semantics differ between screens and from the references
- On Preview a click goes to the nearest onset; on Sync it goes to the bar start.
- Neither shows where playback will start. Sibelius Cloud and Soundslice move a
  visible marker on click; we only seek.
- The nearest onset is chosen across *all* staves' union, so a click on a cello
  note can snap to a flute onset that is horizontally closer.
- Clicking a repeated bar picks the pass nearest the playhead, which is sensible,
  but nothing says which pass you got.

**Fix:** show a hover start-line. Snap to the onsets of the staff that was
clicked. Show "2nd time" in the tooltip.

### 9. The transport ignores the music
←/→ skip 5 s, the rate cycles through only 1, 0.75 and 0.5, and the loop covers the whole piece.
Soundslice: arrows move note by note when paused, Cmd/Ctrl+arrows move by bar,
`<`/`>` change speed in steps, and drag sets a loop. MuseScore: Rewind goes to the loop start.
**Fix:** plan P5 and P6. Offer 25–150 % speed steps.

### 10. Small things
- The zoom shows "100 %" for an internal 0.6. It is relative to our default, not to
  real size, which is fine as long as it is labeled consistently. The step is 0.1
  of the raw zoom, so the percentage jumps unevenly (83, 100, 117…).
- Resize re-layout snaps to 24 px buckets and forgets known pages, so with #1 a
  window resize changes where lines break mid-playback.
- The playhead interpolates linearly in time between onsets, so its speed
  changes with note spacing. Soundslice has the same trait and it is acceptable.
  Keep the stepped mode for reduced motion.
- There is no keyboard path into the bars except Tab through every button; plan P5.

## What is already good (keep)
- The playhead resolved per bar never slides across a system break, and it sits on
  onsets. This is better than OSMD's own cursor and matches Soundslice.
- The written vs playback order mapping and the repeat handling. MuseScore's forums
  are full of loop and repeat bugs we avoid.
- Hidden parts are hidden in the notation too (like MuseScore's timeline eye toggle).
- Reduced-motion stepping, aria labels on bars, a light sheet in both themes.

## Sources
- Sibelius Cloud viewer: [navigation](https://api.sibelius.avid.com/docs/guides/score-viewer-navigation), [playback](https://api.sibelius.avid.com/docs/guides/score-viewer-playback)
- [Notation Composer: anticipating page turns](https://notation.com/ComposerDocs4/anticipating_page_turns.htm)
- [Steinberg forum: playhead not following the scrolling window](https://forums.steinberg.net/t/playhead-not-follow-scrolling-window/669053)
- [MuseScore: page display/playback](https://musescore.org/comment/547851), [following the cursor](https://musescore.org/en/node/333911)
- [Soundslice: playhead scrolling options](https://www.soundslice.com/help/en/player/advanced/116/playhead-scrolling-options/), [keyboard shortcuts](https://www.soundslice.com/help/en/player/tips/1/keyboard-shortcuts/)
- [OSMD 2.0 type declarations (batched rendering)](https://app.unpkg.com/opensheetmusicdisplay@2.0.0/files/build/dist/src/OpenSheetMusicDisplay/OpenSheetMusicDisplay.d.ts), [OSMD options (followCursor)](https://app.unpkg.com/opensheetmusicdisplay@1.9.2/files/build/dist/src/OpenSheetMusicDisplay/OSMDOptions.d.ts)
- More in `score-navigation.md`.
