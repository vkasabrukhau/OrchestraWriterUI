"use client";

import { cx } from "@/lib/utils/format";

/** Native color input dressed as a swatch (round by default, square inside editor fields). */
export function ColorSwatch({
  value,
  onChange,
  size = "md",
  label,
  className,
  shape = "round",
}: {
  value: string;
  onChange: (hex: string) => void;
  size?: "sm" | "md" | "lg";
  label: string;
  className?: string;
  shape?: "round" | "square";
}) {
  const s = size === "sm" ? "h-4 w-4" : size === "lg" ? "h-9 w-9" : shape === "square" ? "h-5 w-5" : "h-6 w-6";
  return (
    <span
      className={cx("relative inline-flex shrink-0 ring-1 ring-black/10 shadow-sm", shape === "round" ? "rounded-full" : "rounded-[3px]", s, className)}
      style={{ background: value }}
    >
      <input
        type="color"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        aria-label={label}
        className="absolute inset-0 h-full w-full cursor-pointer opacity-0"
      />
    </span>
  );
}
