"use client";

import { forwardRef, type ButtonHTMLAttributes, type ReactNode } from "react";
import { Tooltip } from "@/components/ui/Tooltip";
import { cx } from "@/lib/utils/format";

/**
 * Small building blocks of the editor chrome (ADR 0022): square tool buttons,
 * docked panel headers, property sections and compact fields.
 */

export const ToolButton = forwardRef<
  HTMLButtonElement,
  ButtonHTMLAttributes<HTMLButtonElement> & { label: string; shortcut?: string; pressed?: boolean; size?: "sm" | "md" }
>(function ToolButton({ label, shortcut, pressed, size = "md", className, children, ...rest }, ref) {
  return (
    <Tooltip label={shortcut ? `${label}  ${shortcut}` : label} side="bottom">
      <button
        ref={ref}
        type="button"
        aria-label={label}
        aria-pressed={pressed}
        className={cx(
          "inline-grid shrink-0 place-items-center rounded-[var(--radius-sm)] text-ink-2 transition-colors hover:bg-paper-3 hover:text-ink disabled:pointer-events-none disabled:text-ink-4",
          size === "sm" ? "h-6 w-6" : "h-6.5 w-6.5",
          pressed && "bg-brass-soft text-brass-3 hover:bg-brass-soft hover:text-brass-3",
          className,
        )}
        {...rest}
      >
        {children}
      </button>
    </Tooltip>
  );
});

export function ToolSeparator({ className }: { className?: string }) {
  return <span className={cx("mx-1 h-4.5 w-px shrink-0 bg-line", className)} aria-hidden />;
}

export function PanelHeader({ title, meta, actions, id }: { title: string; meta?: ReactNode; actions?: ReactNode; id?: string }) {
  return (
    <div className="flex h-10 shrink-0 items-center justify-between gap-2 border-b border-line px-4">
      <div className="flex min-w-0 items-baseline gap-2">
        <h2 id={id} className="truncate text-[12px] font-semibold text-ink">
          {title}
        </h2>
        {meta && <span className="tnum truncate text-[11px] text-ink-3">{meta}</span>}
      </div>
      {actions && <div className="flex shrink-0 items-center gap-0.5">{actions}</div>}
    </div>
  );
}

export function PropSection({ title, detail, children, className, labelledBy }: { title: string; detail?: ReactNode; children: ReactNode; className?: string; labelledBy?: string }) {
  return (
    <section className={cx("space-y-3 border-b border-line px-4 py-4 last:border-b-0", className)} aria-labelledby={labelledBy}>
      <div className="flex items-center justify-between">
        <h3 id={labelledBy} className="text-[11.5px] font-semibold text-ink">
          {title}
        </h3>
        {detail && <span className="text-[10.5px] text-ink-3">{detail}</span>}
      </div>
      {children}
    </section>
  );
}

export function PropLabel({ children, htmlFor, detail, id }: { children: ReactNode; htmlFor?: string; detail?: ReactNode; id?: string }) {
  return (
    <div className="mb-1.5 flex items-center justify-between">
      <label htmlFor={htmlFor} id={id} className="text-[11.5px] text-ink-2">
        {children}
      </label>
      {detail && <span className="text-[10.5px] text-ink-3">{detail}</span>}
    </div>
  );
}

/** Field shell: 30 px, hairline, subtle fill; children are the bare input plus an optional unit. */
export function FieldBox({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <div
      className={cx(
        "flex h-7.5 items-center gap-2 rounded-[var(--radius-sm)] border border-line bg-paper-3 px-2.5 text-[12px] text-ink focus-within:border-brass focus-within:bg-paper-2",
        className,
      )}
    >
      {children}
    </div>
  );
}

export const bareInput = "min-w-0 flex-1 bg-transparent text-[12px] text-ink outline-none placeholder:text-ink-3 focus-visible:shadow-none";

/** A small text button in the editor style (no pill). Forwards its ref so it can be a Radix trigger. */
export const EditorButton = forwardRef<HTMLButtonElement, ButtonHTMLAttributes<HTMLButtonElement> & { variant?: "outline" | "primary" | "ghost" }>(function EditorButton(
  { children, variant = "outline", className, ...rest },
  ref,
) {
  return (
    <button
      ref={ref}
      type="button"
      className={cx(
        "inline-flex h-7 shrink-0 items-center justify-center gap-1.5 rounded-[var(--radius-sm)] px-2.5 text-[12px] font-medium transition-colors disabled:pointer-events-none disabled:opacity-45",
        variant === "primary" && "bg-brass text-white hover:bg-brass-3",
        variant === "outline" && "border border-line bg-paper-2 text-ink hover:bg-paper-3",
        variant === "ghost" && "text-ink-2 hover:bg-paper-3 hover:text-ink",
        className,
      )}
      {...rest}
    >
      {children}
    </button>
  );
});
