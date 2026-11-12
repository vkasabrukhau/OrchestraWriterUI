import { DEFAULT_SECTION_COLORS, type Section } from "@/shared/sections";

/** Section palettes the user can apply in one click; the choice is saved in the project's display settings. */
export const PALETTES: Array<{ id: string; name: string; colors: Record<Section, string> }> = [
  { id: "concert", name: "Concert", colors: { ...DEFAULT_SECTION_COLORS } },
  { id: "aurora", name: "Aurora", colors: { Strings: "#7fd4c1", Woodwinds: "#8fb7ff", Brass: "#ffa26b", Percussion: "#d79bff", Other: "#ffd27a" } },
  { id: "ember", name: "Ember", colors: { Strings: "#f2b544", Woodwinds: "#f08a4b", Brass: "#e8545f", Percussion: "#b86cd8", Other: "#8bd3dd" } },
  // Okabe–Ito hues: the five sections stay apart with red–green color blindness.
  // Every palette keeps one distinct hue per section (color = section, brightness = dynamic).
  { id: "cvd", name: "Color-blind safe", colors: { Strings: "#56b4e9", Woodwinds: "#009e73", Brass: "#e69f00", Percussion: "#cc79a7", Other: "#f0e442" } },
];
