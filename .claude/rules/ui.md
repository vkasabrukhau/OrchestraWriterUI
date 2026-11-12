---
paths:
  - "src/app/**"
  - "src/components/**"
  - "src/app/globals.css"
---
# UI conventions

- Page order is fixed: Import → Sync (audio only) → Customize → Preview → Export.
  Back-navigation: Preview → Customize, and Preview → Sync when a recording exists.
- Customize layout: instrument list left, visual layout center, settings right.
- Preview: large visualization plus collapsible score, orchestra viewer, and
  visualizer panels; playback controls, score page navigation independent of
  the playing measure, current-measure highlight, click a measure to start.
- Visual direction is undecided between **A (concert program: paper, ink,
  brass accent, serif titles, dark stage in a frame)** and **B (one material:
  all dark, amber accent, floating controls)**. Build with design tokens so
  either can be applied; don't hard-code colors.
- Fonts: Lora (titles), Inter (UI), Bravura (dynamic markings pp–fff).
  Icons: Lucide. All open-licensed; keep it that way.
- Label things with plain part names. Every color encoding has a visible legend.
- Playback controls appear on Sync, Customize, and Preview, with the same
  keyboard shortcuts (`PlaybackShortcuts`) and the same playback store.
  Pages with the workflow header use `Transport`; editor pages (ADR 0014) use
  `EditorTransport`, a compact layout of the same controls. Both live in
  `src/components/music/Transport.tsx`; don't add a third.
