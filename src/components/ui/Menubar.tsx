"use client";

import { createContext, useContext, type ReactNode } from "react";
import { Menubar as RadixMenubar } from "radix-ui";
import { Check, ChevronRight, Dot } from "lucide-react";
import { cx } from "@/lib/utils/format";

/**
 * Desktop-style menu bar (Radix Menubar). Arrow keys move between menus and
 * items, typing jumps to an item, Escape closes and returns focus to the bar.
 */
export function Menubar({ children, className, ariaLabel = "Menu bar" }: { children: ReactNode; className?: string; ariaLabel?: string }) {
  return (
    <RadixMenubar.Root aria-label={ariaLabel} className={cx("flex items-center gap-0.5", className)}>
      {children}
    </RadixMenubar.Root>
  );
}

const contentClass =
  "pop-in z-50 min-w-56 max-h-[var(--radix-menubar-content-available-height)] overflow-y-auto outline-none rounded-[var(--radius)] border border-line bg-paper-2 p-1 text-ink shadow-lg";

/**
 * Inside a menu with `inlineSubs`, a `MenubarSub` renders its items in place
 * under a label instead of opening a side menu. Narrow windows use this:
 * a side menu has no room to open beside its parent there.
 */
const InlineSubs = createContext(false);
/** set by an inline `MenubarSub` that is disabled, so its items are too */
const GroupDisabled = createContext(false);

/** One top-level menu. `ariaLabel` names an icon-only `label`; `inlineSubs` flattens submenus into labelled groups. */
export function MenubarMenu({ label, ariaLabel, inlineSubs = false, children }: { label: ReactNode; ariaLabel?: string; inlineSubs?: boolean; children: ReactNode }) {
  return (
    <InlineSubs.Provider value={inlineSubs}>
      <RadixMenubar.Menu>
        <RadixMenubar.Trigger aria-label={ariaLabel} className="flex h-6.5 select-none items-center rounded-[var(--radius-sm)] px-2.5 text-[12px] text-ink-2 outline-none transition-colors hover:bg-paper-3 hover:text-ink focus-visible:bg-paper-3 data-[state=open]:bg-brass-soft data-[state=open]:font-medium data-[state=open]:text-brass-3">
          {label}
        </RadixMenubar.Trigger>
        <RadixMenubar.Portal>
          <RadixMenubar.Content align="start" sideOffset={4} collisionPadding={8} className={contentClass}>
            {children}
          </RadixMenubar.Content>
        </RadixMenubar.Portal>
      </RadixMenubar.Menu>
    </InlineSubs.Provider>
  );
}

const itemClass =
  "relative flex h-7.5 w-full cursor-default select-none items-center gap-2 rounded-[var(--radius-sm)] pl-7 pr-2 text-[12px] text-ink-2 outline-none data-[highlighted]:bg-paper-3 data-[highlighted]:text-ink data-[disabled]:pointer-events-none data-[disabled]:text-ink-4";

function Shortcut({ children }: { children?: ReactNode }) {
  if (!children) return null;
  return <span className="tnum ml-auto pl-6 text-[11px] tracking-wide text-ink-3">{children}</span>;
}

export function MenubarItem({
  children,
  shortcut,
  onSelect,
  disabled,
  icon,
}: {
  children: ReactNode;
  shortcut?: string;
  onSelect?: () => void;
  disabled?: boolean;
  icon?: ReactNode;
}) {
  const groupDisabled = useContext(GroupDisabled);
  return (
    <RadixMenubar.Item className={itemClass} onSelect={onSelect} disabled={disabled || groupDisabled}>
      {icon && (
        <span className="absolute left-2 inline-flex text-ink-3" aria-hidden>
          {icon}
        </span>
      )}
      {children}
      <Shortcut>{shortcut}</Shortcut>
    </RadixMenubar.Item>
  );
}

export function MenubarCheckboxItem({
  children,
  checked,
  onCheckedChange,
  shortcut,
  disabled,
}: {
  children: ReactNode;
  checked: boolean;
  onCheckedChange: (checked: boolean) => void;
  shortcut?: string;
  disabled?: boolean;
}) {
  const groupDisabled = useContext(GroupDisabled);
  return (
    <RadixMenubar.CheckboxItem
      className={itemClass}
      checked={checked}
      onCheckedChange={onCheckedChange}
      disabled={disabled || groupDisabled}
      // toggles keep the menu open so several can be flipped in a row
      onSelect={(e) => e.preventDefault()}
    >
      <RadixMenubar.ItemIndicator className="absolute left-2 inline-flex text-brass">
        <Check size={13} strokeWidth={2.25} aria-hidden />
      </RadixMenubar.ItemIndicator>
      {children}
      <Shortcut>{shortcut}</Shortcut>
    </RadixMenubar.CheckboxItem>
  );
}

export function MenubarRadioGroup({ value, onValueChange, children }: { value: string; onValueChange: (v: string) => void; children: ReactNode }) {
  return (
    <RadixMenubar.RadioGroup value={value} onValueChange={onValueChange}>
      {children}
    </RadixMenubar.RadioGroup>
  );
}

export function MenubarRadioItem({ value, children, disabled }: { value: string; children: ReactNode; disabled?: boolean }) {
  const groupDisabled = useContext(GroupDisabled);
  return (
    <RadixMenubar.RadioItem value={value} className={itemClass} disabled={disabled || groupDisabled}>
      <RadixMenubar.ItemIndicator className="absolute left-1 inline-flex text-brass">
        <Dot size={22} strokeWidth={3} aria-hidden />
      </RadixMenubar.ItemIndicator>
      {children}
    </RadixMenubar.RadioItem>
  );
}

export function MenubarSub({ label, children, disabled }: { label: string; children: ReactNode; disabled?: boolean }) {
  const inline = useContext(InlineSubs);
  if (inline) {
    return (
      <RadixMenubar.Group aria-label={label} className="[&+*]:mt-1 [*+&]:mt-1 [*+&]:border-t [*+&]:border-line [*+&]:pt-1">
        <MenubarLabel>{label}</MenubarLabel>
        <GroupDisabled.Provider value={Boolean(disabled)}>{children}</GroupDisabled.Provider>
      </RadixMenubar.Group>
    );
  }
  return (
    <RadixMenubar.Sub>
      <RadixMenubar.SubTrigger className={cx(itemClass, "data-[state=open]:bg-paper-3")} disabled={disabled}>
        {label}
        <ChevronRight size={13} className="ml-auto text-ink-3" aria-hidden />
      </RadixMenubar.SubTrigger>
      <RadixMenubar.Portal>
        <RadixMenubar.SubContent sideOffset={2} alignOffset={-4} collisionPadding={8} className={contentClass}>
          {children}
        </RadixMenubar.SubContent>
      </RadixMenubar.Portal>
    </RadixMenubar.Sub>
  );
}

export function MenubarSeparator() {
  return <RadixMenubar.Separator className="-mx-1 my-1 h-px bg-line" />;
}

export function MenubarLabel({ children }: { children: ReactNode }) {
  return <RadixMenubar.Label className="px-7 pb-1 pt-1.5 text-[10.5px] font-semibold uppercase tracking-[0.08em] text-ink-3">{children}</RadixMenubar.Label>;
}
