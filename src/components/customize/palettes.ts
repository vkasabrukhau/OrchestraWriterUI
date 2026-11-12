import { DEFAULT_SECTION_COLORS, type Section } from "@/shared/sections";

/** Section palettes the user can apply in one click; the choice is saved in the project's display settings. */
export const PALETTES: Array<{ id: string; name: string; colors: Record<Section, string> }> = [
  { id: "concert", name: "Concert", colors: { ...DEFAULT_SECTION_COLORS } },
  { id: "aurora", name: "Aurora", colors: { Strings: "#7fd4c1", Woodwinds: "#8fb7ff", Brass: "#ffa26b", Percussion: "#d79bff", Other: "#ffd27a" } },
  { id: "ember", name: "Ember", colors: { Strings: "#f2b544", Woodwinds: "#f08a4b", Brass: "#e8545f", Percussion: "#b86cd8", Other: "#8bd3dd" } },
  { id: "tints", name: "Brass tints", colors: { Strings: "#e9c67a", Woodwinds: "#c8a24f", Brass: "#f1dca0", Percussion: "#a3833b", Other: "#d9b35f" } },
];
