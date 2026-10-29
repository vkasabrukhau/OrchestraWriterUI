# Pitch encoding study

Companion notes for `pitch-encoding-study.html`. Open the HTML file directly in
a browser; it is self-contained apart from Lora and Inter from Google Fonts.

The mockup plays one excerpt on two stages side by side, so the team can
compare two ways of adding pitch to the visual:

- **A · Brightness = pitch** (the proposal): the core's size shows the written
  dynamic, and its lightness shows pitch within each instrument's own range.
- **B · Height in seat = pitch** (the alternative): the core's size shows the
  written dynamic, and its distance from the conductor shows pitch.

## Scope status

Pitch is a later-phase item (CLAUDE.md scope table, ADR 0002). Both versions
also move the written dynamic from brightness to area, which changes the core
rule "brightness = dynamic, color = section". Building either one in `src/`
needs a new ADR that supersedes 0002, plus updates to CLAUDE.md,
`docs/spec/design.md` and `.claude/rules/visualizer.md`. This mockup changes
no app code.

## What maps to what

Every input comes from the **score**, not from the recording. Neither version
analyzes audio. The sound in the mockup is synthesized from the same notes,
only so you can listen along.

| Score feature | Current app (ADR 0002) | A · Brightness = pitch | B · Height in seat = pitch |
|---|---|---|---|
| Part is playing | Glow fades in and out | Core fades in and out (opacity) | Core fades in and out (opacity) |
| Written dynamic (pp–fff) | Brightness, plus a small size change and whitening toward white | **Area of the solid core**, 10%–100% of the seat | **Area of the solid core**, 5%–50% of the seat |
| Pitch (sounding) | Not shown | **Lightness of the core** (OKLCH L), scaled between that instrument's floor and ceiling | **Distance from the conductor** inside the seat: inner edge = bottom of range, outer edge = top |
| Instrument / section | Color = section | Hue = instrument by default (low instruments blue/purple), or hue = section with the switch | Color = section, using the app's current defaults |
| Seat position | Labeled seating plan | Same seats | Same seats |
| Blur | Part of the glow | Edge decoration only; not counted as area | Edge decoration only; not counted as area |
| Articulation, ramps, recording loudness | Not shown | Not shown | Not shown |

### Dynamic → core area

The area is the solid core only, as a share of the seat it sits in.

| Dynamic | *pp* | *p* | *mp* | *mf* | *f* | *ff* | *fff* |
|---|---|---|---|---|---|---|---|
| A | 10% | 18% | 28% | 40% | 55% | 75% | 100% |
| B | 5% | 9% | 14% | 20% | 27.5% | 37.5% | 50% |

B uses half of A's table so the core has room left in the seat to move and show
pitch.

### Pitch → position in range

Pitch is first turned into a place in the instrument's own range:

```
place = clamp((sounding MIDI − range low) / (range high − range low), 0, 1)
```

Notes outside the range are clamped to the nearest end. When a part plays more
than one note at once (a chord or double stop), the highest note is used.

- **A** uses it for lightness: `L = floor + (ceiling − floor) × place`.
- **B** uses it for position: `0` puts the core against the inner edge (nearest
  the conductor) and `1` puts it against the outer edge.

## Version A in detail

**Core shape.** The core is the seat's own shape (an arc-shaped band around
the conductor), scaled about the seat's middle by `k = √area` in both depth and
width. The core always stays centered in the seat and never moves.

**Color.** `oklch(L, 0.15, hue)`. When a color falls outside sRGB, its chroma
is reduced in steps of ×0.88 until it fits, so very light or very dark cores
get less saturated rather than shifting hue.

**Per-instrument ranges.** Each instrument has its own lightness floor and
ceiling. Low instruments get lower ceilings and darker-looking hues, so even at
the top of their range they stay dimmer than the high instruments.

| Part | Hue (register mode) | Lightness floor–ceiling | Sounding range |
|---|---|---|---|
| Violin I | 88 | 0.74–0.95 | G3–E7 |
| Violin II | 70 | 0.72–0.93 | G3–C7 |
| Viola | 18 | 0.62–0.84 | C3–E6 |
| Cello | 250 | 0.52–0.74 | C2–E5 |
| Bass | 302 | 0.46–0.66 | E1–C4 |
| Flute | 105 | 0.80–0.97 | C4–D7 |
| Oboe | 132 | 0.74–0.92 | B♭3–G6 |
| Clarinet | 182 | 0.66–0.88 | D3–F6 |
| Bassoon | 268 | 0.50–0.70 | B♭1–E♭5 |
| Horn | 42 | 0.62–0.84 | B♭1–F5 |
| Trumpet | 58 | 0.74–0.94 | F♯3–C6 |
| Trombone | 325 | 0.56–0.76 | E2–C5 |
| Tuba | 290 | 0.46–0.64 | E1–B♭3 |
| Timpani | 240 | 0.50–0.68 | D2–A3 |

In "Hue by section" mode the hues become Strings 80, Woodwinds 165, Brass 32
and Percussion 278 (OKLCH hues close to the app's section colors). Lightness
still follows pitch.

**Halo.** A blurred copy of the core's color is drawn around it with screen
blending. Its blur radius is `(10 + 14k)` px at a 640 px-wide stage, so
louder cores also get a slightly wider halo. Cores themselves are drawn
opaque on top, so overlapping cores never add up to a brighter color.

## Version B in detail

**Core shape.** For a share of seat `f`, the core takes `rf = min(0.92,
√f × 0.8)` of the seat's depth and `af = min(0.95, f / rf)` of its width, so
`rf × af ≈ f`. This favors width over depth, so the core keeps room to move
toward or away from the conductor.

**Position.** The core's center moves from the inner edge to the outer edge
as pitch goes from the bottom to the top of the range. The room to move is
whatever depth the core doesn't fill: about 82% of the seat's depth at *pp*,
about 43% at *fff*.

**Color and brightness.** The section's hex color, at fixed brightness:
Strings #e2b04c, Woodwinds #5cba9a, Brass #e8705e, Percussion #9298e0.

**Halo.** Same as A, with `k = √f`.

### Known issues in B

1. **Higher notes look bigger.** The core keeps the same angle as it moves
   outward, and the seat widens with distance from the conductor, so pixel
   area grows with pitch. In the string seats (radius 0.12–0.29 of stage
   width), a *pp* note at the top of the range covers about 2× the area of the
   same *pp* at the bottom (about 1.4× at *fff*). The table above is exact
   only when the core is at the middle of the range. Fix: narrow the angle in
   proportion to `seat middle radius / core center radius`.
2. **Loud passages show less pitch movement.** Because the room to move
   shrinks as the core grows, a melody at *fff* travels about half as far as
   the same melody at *pp*.

Version A has neither issue, because its core never moves.

## Timing (both versions)

| | Value | App today |
|---|---|---|
| Fade in (attack) | exponential, τ = 80 ms | 120 ms |
| Fade out (release) | exponential, τ = 250 ms | 240 ms |
| Pitch glide (A's lightness, B's position) | exponential, τ = 120 ms | — |
| Reduced motion | all three snap instantly | fades snap instantly |

When a part stops, the core fades out at its last size, lightness and
position.

## The excerpt

16 bars written for the mockup, D minor, 96 bpm, 4/4 (40 s). All pitches are
sounding pitches. It opens paused at bar 9.

| Bars | What happens |
|---|---|
| 1–4 | Cellos, basses, timpani roll and bassoon, *pp* rising to *mp*, low in their ranges |
| 5–8 | Violin I melody at *p*; Violin II, viola, clarinet fill in; flute enters at bar 7 (*mp*) |
| 9–12 | Everyone at *mf*–*f*; melody climbs; horn, tuba, trombone (bar 11) and trumpet (bar 11) enter; flute rises to C♯7 |
| 13 | *fff* tutti; Violin I on D7, flute on D7 at *ff* |
| 14–15 | *ff* falling to *f* |
| 16 | Violin I holds D6 at *pp* over horn, timpani roll, quiet low strings |

The synth is only for listening: sawtooth for strings and brass, triangle for
woodwinds, a short sine for timpani, with gain from the app's brightness ladder
(`BRIGHTNESS_LADDER`). It does not drive the visual.

## Controls

- **Transport.** Play/pause, scrub, speed (0.5×, 0.75×, 1×), sound on/off.
- **Display toggles.** Seat outlines, part labels (name plus current dynamic),
  note names beside the dynamic, reduced motion (starts on if the OS asks
  for it).
- **Test frames.** Freeze both stages on a fixed state: *fff* tutti mid-range;
  everyone *pp* near the top of their range; everyone *fff* near the bottom;
  the bass line alone at *f*; Violin I *ff* high over *pp* strings.
- **Hue switch (A only).** Hue by register (14 hues, one per instrument) or hue
  by section (4 hues).
- **Inspect a part.** Pick a part from the menu or click its seat. Shows the
  note, dynamic, place in range, A's lightness and core area, and B's height
  in seat. Moving the Dynamic or Pitch slider holds that part at those values
  and pauses playback; Release clears all holds.
- **Legends.** Size dots for each dynamic (both versions); for A, a lightness
  range bar per instrument on a 0.40–1.00 axis with a live marker; for B, a
  height key and section colors.

## Questions to answer with it

1. **Bars 1–4.** With A's lower ceilings for bass instruments, is the quiet
   opening still readable?
2. **Bar 13.** At *fff* every A core fills its seat. Do the rows stay separate,
   or do the halos join up?
3. **Bar 16.** In A, Violin I's high *pp* D is a small, bright core. Does it
   read as quiet?
4. **Size against brightness.** Compare "Everyone pp, high" with "Everyone fff,
   low". Can you tell which is louder without reading the labels?
5. **Number of hues.** A's register palette uses 14 hues; the project rule
   allows 8–10. Is "Hue by section" enough?
