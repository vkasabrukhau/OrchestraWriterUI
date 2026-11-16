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

function toHsl([r, g, b]: [number, number, number]): [number, number, number] {
  const rr = r / 255, gg = g / 255, bb = b / 255;
  const max = Math.max(rr, gg, bb), min = Math.min(rr, gg, bb);
  const l = (max + min) / 2;
  if (max === min) return [0, 0, l];
  const d = max - min;
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
  const h = max === rr ? (gg - bb) / d + (gg < bb ? 6 : 0) : max === gg ? (bb - rr) / d + 2 : (rr - gg) / d + 4;
  return [h / 6, s, l];
}

function fromHsl([h, s, l]: [number, number, number]): [number, number, number] {
  if (s === 0) return [l * 255, l * 255, l * 255];
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
  const p = 2 * l - q;
  const ch = (t: number) => {
    const x = t < 0 ? t + 1 : t > 1 ? t - 1 : t;
    if (x < 1 / 6) return p + (q - p) * 6 * x;
    if (x < 1 / 2) return q;
    if (x < 2 / 3) return p + (q - p) * (2 / 3 - x) * 6;
    return p;
  };
  return [ch(h + 1 / 3) * 255, ch(h) * 255, ch(h - 1 / 3) * 255];
}

/** The same hue and saturation with HSL lightness moved by `dl` (−1…1), clamped. */
export function adjustLightness(hex: string, dl: number): string {
  const [h, s, l] = toHsl(toRgb(hex));
  return toHex(fromHsl([h, s, Math.min(0.95, Math.max(0.05, l + dl))]));
}

/**
 * Lightness steps for tints, in HSL lightness. Kept within about ±15 % so a
 * tint never reads as a different dynamic: brightness is the dynamic
 * channel, and wider tints compete with it.
 */
export const TINT_STEPS = [-0.15, -0.075, 0, 0.075, 0.15];

/**
 * Tints of one section color, darkest to lightest, with the color itself in
 * the middle. With many parts, tints within a section plus labels keep the
 * hue count low (about 8–10 distinct hues read well).
 */
export function sectionTints(hex: string): string[] {
  const base = normalizeHex(hex) ?? hex;
  return TINT_STEPS.map((dl) => (dl === 0 ? base : adjustLightness(base, dl)));
}
