# Orchestra visualization: musical features and customization

Compiled November 2, 2026 from the latest feature discussion.

This document describes the agreed product direction and starting visual behaviors for a teammate implementing the visualization. It records design intent, not verified implementation status. Details marked for artistic input remain flexible.

## Product direction

The primary experience is watching a visualization that reflects the music, with options to customize its appearance. The visualization has two layers: individual musical parts in the foreground, and a second layer combining key, chord, volume, and harmonic tension attributes.

## 1. Individual parts: activity, dynamics, and layout

Each musical part has its own labeled glow in the orchestra layout. The glow shows when the part is playing, and its brightness follows the written dynamics: brighter for louder passages and dimmer for quieter passages.

Users can customize each part's position, visibility, and color. Hiding a part changes the visualization without changing the audio.

Color is a flexible visual property. Users can assign a fixed color to a part or map color to a musical feature such as pitch. Color should therefore not be restricted to identifying instruments or parts.

Further artistic input:

- Refine the appearance of the part visuals and their customizable properties.
- Make a range of possible movements and animations based on score and sound file as to remain exciting.

## 2. Articulation

Articulation changes the behavior of the part visualization so that differences in how notes are played have a visual counterpart. The outer layer and inner layer of a part are used to create many modes of movement.

The starting map is:

| Articulation | Starting visual behavior |
| --- | --- |
| Staccato | Short, distinct pulses with quick fade-outs. |
| Marcato | Stronger, bolder pulses. |
| Accent | Brief emphasis at the start of a note. |
| Tenuto | A steady, sustained glow through the note. |
| Slurs and legato | Smooth, connected transitions between notes. |

Users can customize how each articulation is visualized. These are starting behaviors, rather than finished artistic designs.

Further artistic input:

- Refine each behavior's shape, intensity, and transitions while preserving recognizable differences between articulations.

## 3. Pitch

Pitch-based coloring is optional. When enabled, a part's color follows the pitches it plays instead of remaining fixed. Users can customize the pitch-to-color mapping.

Further artistic input:

- The palette and transitions between colors.
- How simultaneous pitches within one part are represented.

## 4. Melody highlighting (experimental)

Users can select a passage within a part, or individual notes, and label the selection as melody. The marked passages receive a specific visual treatment during playback, allowing the melody to be followed as it moves between parts.

Melody can have a unique visual attribute through color, animation, or glow. Users can customize how it is visualized. The specific artistic treatment remains open for further input.

Automatic melody detection is not required for this feature.

## 5. Recurring themes (experimental)

Users can label passages as belonging to the same theme, including passages in different parts. Those passages share a recognizable visual attribute when the theme returns.

As with melody, the attribute can use color, animation, or glow, and users can customize its treatment. The precise artistic treatment needs further input.

Automatic theme detection is not required for this feature.

## 6. The second layer: key, chords, and harmonic tension

The second layer sits behind the individual parts. Key, chords, and harmonic tension are attributes of this layer, rather than separate visualization systems.

### Key and chord colors

The working direction is for the key to establish a color palette and for chords to determine the current color within that palette. When the key changes, the palette shifts. Users can customize the mappings.

A chord describes a combination of notes at a particular moment; the key provides the broader tonal context. Several chords can occur while the music remains in the same key.

Calvin's interview provides a specific reference: a core color is assigned to a chord, with more dissonant notes moving farther from that color. His notes also discuss treating chord extensions, such as sevenths and ninths, differently. The relationship between this reference and the key-based palette still needs development.

The earlier proposal described as multiple interacting note colors is removed from this direction.

Further research and artistic input:

- Established or historical mappings between pitches, keys, chords, and colors.
- The reasoning behind those mappings and how widely they are used.
- How the key palette, chord color, and Calvin's approach can work together.
- Exact palettes and transitions, with user customization retained.

These color relationships are a working design direction, not a claim that music has universally established colors.

### Harmonic tension (experimental)

The app estimates harmonic tension from the score. Users can override the estimates and customize how tension appears. Music21 is a candidate for supporting the analysis; no analysis method has been selected.

Tension can influence the second layer's texture and movement, including surface smoothness and the fluidity of motion. One possible direction is a fluid, organic quality becoming more rigid and constrained as tension rises, then becoming more fluid as tension resolves. 

There could also be a visual connection, an abstract line connecting the parts in tension.

This is an open artistic direction rather than a fixed effect. Users can customize the visual treatment.


Further input:

- The analysis method and how users override its results.
- The precise texture and movement treatment and user experimentation and customization.
- How the tension, harmony, and melody treatment combines with key and chord colors.

## 7. Musical sections and visual modifiers

Users can mark passages with section labels such as introduction, exposition, development, recapitulation, and coda. They can also create custom labels.

Each section can optionally have visual modifiers that apply to everything displayed during that passage. The modifiers build on the existing visual mappings. Examples discussed include multiplying brightness or adjusting movement intensity across the section.

When the section ends, its modifiers stop applying. This gives a section a distinct visual character without requiring users to edit every note or part individually.

Section markings are user-defined. Automatic section recognition is outside the agreed scope.

Further input:

- The available modifiers and their controls.
- The artistic treatment of changes between sections.

## 8. Combining the two layers

The foreground shows individual parts. The second layer combines key, chord, and tension attributes. Section modifiers can affect what is displayed during a passage.

The specific approach to balancing the layers remains open. No fixed balancing rule or set of controls was selected in this discussion.

## Research follow-up

The next research pass should investigate color mappings for pitches, keys, and chords and attach references that explain their origins, reasoning, and use. Research findings should be distinguished from artistic choices.

This document records the discussion before that additional research pass. It does not select a research-based palette or add further musical features.
