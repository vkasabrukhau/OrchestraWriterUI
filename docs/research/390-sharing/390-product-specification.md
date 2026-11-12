# Orchestra Visualizer

## What the product is

A tool musicians use to create visualizations of music and export finished MP4 videos, including for YouTube releases.

The musician brings in a score and an optional recording, customizes how the music looks, previews it, and exports the video with audio. They can also save the project and return to it later.

The people watching the finished video may be general listeners or educated musicians. The main purpose is to enjoy a visualization that reflects the music, with room for the creator to customize its appearance.

## How users use it

1. **Import:** Upload a MusicXML score and, optionally, an MP3 recording. If there is no recording, generate playback from the score. Users can also open a saved project.
2. **Sync:** Automatically line up the score with the recording. Show confidence for each measure using percentages and colors, and let users add or adjust timing markers where corrections are needed.
3. **Customize:** Arrange the parts, choose colors and visibility, and customize the musical features described below.
4. **Preview:** Watch and listen, navigate score pages, and click a measure to play from it. Return to editing as needed.
5. **Export:** Download an MP4 with audio or save an editable project file. The project preserves the score, recording, alignment, and visual settings.

## First layer: individual parts

Each musical part has a labeled glow in an orchestra layout. The glow shows when the part is playing. Brightness follows the written dynamics: brighter for louder passages and dimmer for quieter ones.

Users can move parts, change their colors, and choose which are visible. Hiding a part does not change the audio. The original scope supports up to 64 parts.

### Color and pitch

Color is flexible. It can be a fixed color for an individual part or follow a musical feature such as pitch.

Pitch-based coloring is optional. Users can customize which colors correspond to which pitches.

**Further input:** Palettes, transitions between colors, and how multiple pitches played at once appear within one part.

### Articulation

Different articulations have different visual behaviors:

| Articulation | Starting behavior |
| --- | --- |
| Staccato | Short pulses with quick fade-outs |
| Marcato | Stronger, bolder pulses |
| Accent | Brief emphasis at the start of a note |
| Tenuto | A steady, sustained glow |
| Slurs and legato | Smooth, connected transitions between notes |

Users can customize how each articulation is visualized.

**Further input:** Artistic interpretation of each behavior, including its appearance, intensity, and transitions.

### Melody highlighting

**Experimental.** Users can select a passage within a part, or individual notes, and label them as melody.

Melody can have a specific visual attribute through color, animation, or glow. Users can customize that treatment. This allows the melody to be followed as it moves between parts.

**Further input:** The specific artistic treatment. Automatic melody detection is not required.

### Recurring themes

**Experimental.** Users can label passages as the same theme, including passages in different parts.

Like melody, a theme can have a specific, customizable visual attribute through color, animation, or glow, so it is recognizable when it returns.

**Further input:** The specific artistic treatment. Automatic theme recognition is not required.

## Second layer: key, chords, and tension

This layer sits behind the individual parts. Key, chord, and harmonic tension are attributes of the same layer.

### Key and chord colors

The key establishes a color palette. Chords determine the current color within that palette. When the key changes, the palette shifts. Users can customize these mappings.

Calvin's interview provides a reference: each chord has a core color, while more dissonant notes move farther from that color. He also described different colors for extensions such as sevenths and ninths.

**Further research:** Color associations for pitches, keys, and chords, including well-known or historical mappings and the reasoning behind them. Use that research to develop the palette and its relationship to Calvin's approach.

### Harmonic tension

**Experimental.** The app estimates tension, with user overrides. Music21 is a possible tool for helping identify it; the method is not decided.

Tension can change texture and movement, including surface smoothness and fluidity. One direction is a fluid, organic quality becoming more rigid as tension rises and relaxing as tension resolves.

Users can customize the treatment. This should stay open to artistic interpretation.

**Further input:** How tension is estimated and the exact texture and movement effects.

## Musical sections

Users can label passages as introduction, exposition, development, recapitulation, coda, or create their own labels.

Sections can have visual modifiers that apply to everything displayed during that passage. For example, a section could multiply brightness or adjust movement intensity. This changes the section's overall appearance without editing every note or part individually.

When the section ends, its modifiers stop applying. These are user-defined sections, not automatically identified ones.

**Further input:** The modifiers available and how changes between sections look.

## How the visuals work together

The first layer shows individual parts. The second layer combines key, chords, and tension. Melody and themes can have their own visual attributes, and section modifiers can affect the whole passage.

The balance between these treatments and the two layers is still open for artistic input.

## Visual references

The app should feel familiar to musicians who use tools such as:

- [TonalEnergy Tuner & Metronome](https://apps.apple.com/tt/app/tonalenergy-tuner-metronome/id497716362)
- [MuseScore](https://musescore.com/)
- [IMSLP](https://imslp.org/wiki/Main_Page)
- [Sibelius](https://www.avid.com/sibelius)
- [forScore](https://forscore.co/)

## Relevant interview feedback

- **Calvin:** Useful for seeing individual parts and orchestration. His work uses chord colors, different treatment of extensions and dissonance, and visual differences for faster/slower and short/legato notes. He uses music21.
- **Monet:** Visual movement should relate to the sound. Suggested melody highlighting and larger section markings. Raised concern that overly consistent visuals become less stimulating over time, and emphasized hands-on interaction for musicians.
- **Ian:** Complicated music can be difficult to interpret visually, and synchronization alone may not make a visualization worth returning to. Generated audio can be useful when a recording is unnecessary.
- **Jeffrey:** Saw possibilities in enjoying complex pieces, including fugues, and in score-to-audio matching and spatial presentation.

The full interview notes, including the educational and other use cases discussed, are in [the interview information base](../390-interview-notes.md).

## Research references

References for developing the color and harmony treatments. These do not prescribe a single correct palette.

- [Music–color associations are mediated by emotion](https://doi.org/10.1073/pnas.1212562110): Research on associations between music and color, rather than a fixed color for every chord or key.
- [Malinowski: Harmonic Coloring](https://www.musanim.com/HarmonicColoring/): A musical pitch-color mapping with examples.
- [Scriabin and the Possible](https://mtosmt.org/issues/mto.12.18.2/mto.12.18.2.gawboy_townsend.html): Historical use of color and harmony in Scriabin's Prometheus.
- [Sapp: Harmonic Visualizations of Tonal Music](https://esf.ccarh.org/254-old/254_LiteraturePack1/HarmModels4_Sapp01ICMCkeyscape.pdf): Visualizing tonal regions over different spans of music.
- [Tension Ribbons](https://dorienherremans.com/sites/default/files/paper_tenor_dh_preprint_small.pdf): An approach to estimating aspects of tonal tension.
- [Spiral Array Model](https://eniale.kcl.ac.uk/spiral-array-model/): Relationships between pitches, chords, and keys.
- [Wavescapes](https://doi.org/10.1177/10298649211034906): Visualizing tonal patterns from pitch distributions.
- [music21: Chordify](https://music21.org/music21docs/usersGuide/usersGuide_09_chordify.html): Gathering simultaneous notes across parts for analysis.
- [music21: Windowed Analysis](https://music21.org/music21docs/moduleReference/moduleAnalysisWindowed.html): Analyzing musical passages over time.
- [music21: Roman Numeral Analysis](https://music21.org/music21docs/usersGuide/usersGuide_23_romanNumerals.html): Describing chords relative to a key.
- [Harmonic Fingerprints](https://arxiv.org/abs/1908.00003): Visual patterns for comparing harmony in scores.
