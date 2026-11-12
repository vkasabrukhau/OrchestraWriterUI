/** Small color helpers for the Customize inspector. */

const HEX = /^#?([0-9a-f]{6})$/i;

/** "#d97a68" from "D97A68", "#D97A68" or "d97a68"; null when it is not a 6-digit hex color. */
export function normalizeHex(input: string): string | null {
  const m = HEX.exec(input.trim());
  return m ? `#${m[1].toLowerCase()}` : null;
}

function toRgb(hex: string): [number, number, number] {
  const h = normalizeHex(hex) ?? "#000000";
  return [parseInt(h.slice(1, 3), 16), parseInt(h.slice(3, 5), 16), parseInt(h.slice(5, 7), 16)];
}

function toHex(rgb: [number, number, number]): string {
  return `#${rgb.map((v) => Math.round(Math.max(0, Math.min(255, v))).toString(16).padStart(2, "0")).join("")}`;
}

/** Mix toward white (t > 0) or black (t < 0); |t| in 0–1. */
export function shade(hex: string, t: number): string {
  const [r, g, b] = toRgb(hex);
  const target = t > 0 ? 255 : 0;
  const k = Math.abs(t);
  return toHex([r + (target - r) * k, g + (target - g) * k, b + (target - b) * k]);
}

/**
 * Tints of one section color, darkest to lightest, with the color itself in
 * the middle. With many parts, tints within a section plus labels keep the
 * hue count low (about 8–10 distinct hues read well).
 */
export function sectionTints(hex: string): string[] {
  return [shade(hex, -0.35), shade(hex, -0.18), normalizeHex(hex) ?? hex, shade(hex, 0.2), shade(hex, 0.38), shade(hex, 0.55)];
}
