"use client";

import { useMemo, type ReactNode } from "react";
import { ArrowRight, Lock, Menu as MenuIcon, MousePointer2, Redo2, RotateCcw, Save, Undo2 } from "lucide-react";
import { LogoMark } from "@/components/brand/Logo";
import { StepMenu, StepTabs } from "@/components/shell/StepTabs";
import { UserMenu } from "@/components/shell/UserMenu";
import { useSaveStatus } from "@/components/shell/useSaveStatus";
import { barNumber } from "@/components/music/bars";
import {
  Menubar,
  MenubarCheckboxItem,
  MenubarItem,
  MenubarMenu,
  MenubarRadioGroup,
  MenubarRadioItem,
  MenubarSeparator,
  MenubarSub,
} from "@/components/ui/Menubar";
import { Spinner } from "@/components/ui/Button";
import { Tooltip } from "@/components/ui/Tooltip";
import { formatShortcut, type Command, type Commands } from "@/lib/editor/commands";
import { useEditor } from "@/lib/store/editor";
import { useProject } from "@/lib/store/project";
import { usePlayback } from "@/lib/store/playback";
import { useProjectTiming } from "@/lib/store/useProjectTiming";
import { SECTIONS, SECTION_ORDER, type Section } from "@/shared/sections";
import { cx } from "@/lib/utils/format";
import { EditorDialogs } from "./EditorDialogs";
import { EditorButton, ToolButton, ToolSeparator } from "./parts";
import { useEditorCommands, useEditorShortcuts } from "./useEditorCommands";

/**
 * The editor's header: a menu bar (File, Edit, View, Playback, Parts, Help)
 * over a tool bar (tools, undo/redo, position, project steps, save). Every
 * entry is a command from `src/lib/editor/commands.ts`.
 */
export function EditorChrome({ projectId }: { projectId: string }) {
  const commands = useEditorCommands(projectId);
  useEditorShortcuts(commands);
  return (
    <header className="z-40 shrink-0 border-b border-line bg-paper">
      <MenuRow projectId={projectId} commands={commands} />
      <ToolRow projectId={projectId} commands={commands} />
      <EditorDialogs commands={commands} />
    </header>
  );
}

/* ------------------------------------------------------------------ */
/* Menu bar                                                             */
/* ------------------------------------------------------------------ */

function sc(c: Command): string | undefined {
  return c.shortcut ? formatShortcut(c.shortcut) : undefined;
}

function Item({ c }: { c: Command }) {
  return (
    <MenubarItem onSelect={c.run} disabled={!c.enabled} shortcut={sc(c)}>
      {c.label}
    </MenubarItem>
  );
}

function Check({ c }: { c: Command }) {
  return (
    <MenubarCheckboxItem checked={Boolean(c.checked)} onCheckedChange={c.run} disabled={!c.enabled} shortcut={sc(c)}>
      {c.label}
    </MenubarCheckboxItem>
  );
}

/** The menus, as item lists, so the wide bar and the compact menu share them. */
const MENUS: Array<{ label: string; Items: (props: { commands: Commands }) => ReactNode }> = [
  { label: "File", Items: FileItems },
  { label: "Edit", Items: EditItems },
  { label: "View", Items: ViewItems },
  { label: "Playback", Items: PlaybackItems },
  { label: "Parts", Items: PartsItems },
  { label: "Help", Items: HelpItems },
];

function MenuRow({ projectId, commands: k }: { projectId: string; commands: Commands }) {
  const loadedId = useProject((s) => s.projectId);
  const summary = useProject((s) => s.summary);
  const title = loadedId === projectId ? summary?.title : undefined;
  const openDialog = useEditor((s) => s.openDialog);

  return (
    <div className="relative flex h-8.5 items-center gap-1 border-b border-line px-2.5">
      <LogoMark size={20} className="mr-1 shrink-0" />
      <Menubar className="hidden md:flex">
        {MENUS.map(({ label, Items }) => (
          <MenubarMenu key={label} label={label}>
            <Items commands={k} />
          </MenubarMenu>
        ))}
      </Menubar>
      {/* narrow windows: the same menus in one list, grouped under their names */}
      <Menubar className="md:hidden">
        <MenubarMenu label={<MenuIcon size={15} aria-hidden />} ariaLabel="Menu" inlineSubs>
          {MENUS.map(({ label, Items }) => (
            <MenubarSub key={label} label={label}>
              <Items commands={k} />
            </MenubarSub>
          ))}
        </MenubarMenu>
      </Menubar>

      {/* window title: the project name, click to rename */}
      <div className="pointer-events-none absolute inset-x-0 flex justify-center max-md:static max-md:min-w-0 max-md:flex-1 max-md:justify-start">
        {title && (
          <Tooltip label="Rename project" side="bottom">
            <button
              type="button"
              onClick={() => openDialog("rename")}
              className="pointer-events-auto max-w-[36ch] truncate rounded-[var(--radius-sm)] px-2 py-0.5 text-[12px] font-medium text-ink hover:bg-paper-3"
            >
              {title}
            </button>
          </Tooltip>
        )}
      </div>

      <div className="ml-auto flex items-center">
        <UserMenu size="sm" />
      </div>
    </div>
  );
}

function FileItems({ commands: k }: { commands: Commands }) {
  return (
    <>
      <Item c={k["file.new"]} />
      <Item c={k["file.open"]} />
      <MenubarSeparator />
      <Item c={k["file.save"]} />
      <Item c={k["file.rename"]} />
      <Item c={k["file.export"]} />
      <MenubarSeparator />
      <Item c={k["file.library"]} />
    </>
  );
}

function EditItems({ commands: k }: { commands: Commands }) {
  return (
    <>
      <Item c={k["edit.undo"]} />
      <Item c={k["edit.redo"]} />
      <MenubarSeparator />
      <Item c={k["edit.find"]} />
      <Item c={k["edit.deselect"]} />
      <MenubarSeparator />
      <Item c={k["edit.resetPart"]} />
      <Item c={k["edit.resetPositions"]} />
      <Item c={k["edit.resetColors"]} />
    </>
  );
}

function ViewItems({ commands: k }: { commands: Commands }) {
  return (
    <>
      <Check c={k["view.instruments"]} />
      <Check c={k["view.properties"]} />
      <Check c={k["view.lanes"]} />
      <MenubarSeparator />
      <Check c={k["view.labels"]} />
      <MenubarSub label="Label by" disabled={!k["view.labelSections"].enabled}>
        <MenubarRadioGroup value={k["view.labelParts"].checked ? "parts" : "sections"} onValueChange={(v) => (v === "parts" ? k["view.labelParts"] : k["view.labelSections"]).run()}>
          <MenubarRadioItem value="sections">Sections</MenubarRadioItem>
          <MenubarRadioItem value="parts">Every part</MenubarRadioItem>
        </MenubarRadioGroup>
      </MenubarSub>
      <Check c={k["view.seating"]} />
      <Check c={k["view.legend"]} />
      <MenubarSeparator />
      <Check c={k["view.lock"]} />
      <Item c={k["view.fullscreen"]} />
      <MenubarSeparator />
      <MenubarSub label="Theme">
        <MenubarRadioGroup value={k["view.themeDark"].checked ? "stage" : "program"} onValueChange={(v) => (v === "stage" ? k["view.themeDark"] : k["view.themeLight"]).run()}>
          <MenubarRadioItem value="program">Light</MenubarRadioItem>
          <MenubarRadioItem value="stage">Dark</MenubarRadioItem>
        </MenubarRadioGroup>
      </MenubarSub>
      <Check c={k["view.reducedMotion"]} />
    </>
  );
}

function PlaybackItems({ commands: k }: { commands: Commands }) {
  return (
    <>
      <Item c={k["play.toggle"]} />
      <Item c={k["play.start"]} />
      <Item c={k["play.back"]} />
      <Item c={k["play.forward"]} />
      <Item c={k["play.goto"]} />
      <MenubarSeparator />
      <Check c={k["play.loop"]} />
      <MenubarSub label="Speed">
        <MenubarRadioGroup
          value={k["play.rate05"].checked ? "0.5" : k["play.rate075"].checked ? "0.75" : "1"}
          onValueChange={(v) => (v === "0.5" ? k["play.rate05"] : v === "0.75" ? k["play.rate075"] : k["play.rate1"]).run()}
        >
          <MenubarRadioItem value="1">1×</MenubarRadioItem>
          <MenubarRadioItem value="0.75">0.75×</MenubarRadioItem>
          <MenubarRadioItem value="0.5">0.5×</MenubarRadioItem>
        </MenubarRadioGroup>
      </MenubarSub>
      <Check c={k["play.mute"]} />
    </>
  );
}

function HelpItems({ commands: k }: { commands: Commands }) {
  return (
    <>
      <Item c={k["help.shortcuts"]} />
      <Item c={k["help.about"]} />
    </>
  );
}

function PartsItems({ commands: k }: { commands: Commands }) {
  const infoMap = useProject((s) => s.infoMap);
  const display = useProject((s) => s.display);
  const setSectionVisible = useProject((s) => s.setSectionVisible);
  const setPartSection = useProject((s) => s.setPartSection);
  const selectedId = useEditor((s) => s.selectedId);

  const sections = useMemo(() => {
    if (!infoMap || !display) return [];
    const visible = new Set(display.visibleParts);
    return SECTION_ORDER.map((section) => {
      const members = infoMap.instruments.filter((i) => (display.sections[i.id] ?? i.section) === section);
      return { section, members: members.length, allShown: members.length > 0 && members.every((m) => visible.has(m.id)) };
    }).filter((s) => s.members > 0);
  }, [infoMap, display]);
  const selectedSection: Section | null = selectedId && infoMap && display ? (display.sections[selectedId] ?? infoMap.instruments.find((i) => i.id === selectedId)?.section ?? null) : null;

  return (
    <>
      <Item c={k["parts.toggleVisible"]} />
      <Item c={k["parts.solo"]} />
      <Item c={k["parts.showAll"]} />
      <MenubarSeparator />
      <MenubarSub label="Show sections" disabled={sections.length === 0}>
        {sections.map((s) => (
          <MenubarCheckboxItem key={s.section} checked={s.allShown} onCheckedChange={(v) => setSectionVisible(s.section, v)}>
            {s.section}
          </MenubarCheckboxItem>
        ))}
      </MenubarSub>
      <MenubarSub label="Move selected to section" disabled={!selectedId}>
        <MenubarRadioGroup value={selectedSection ?? ""} onValueChange={(v) => selectedId && setPartSection(selectedId, v as Section)}>
          {SECTIONS.map((s) => (
            <MenubarRadioItem key={s} value={s}>
              {s}
            </MenubarRadioItem>
          ))}
        </MenubarRadioGroup>
      </MenubarSub>
      <Item c={k["parts.useSectionColor"]} />
    </>
  );
}

/* ------------------------------------------------------------------ */
/* Tool bar                                                             */
/* ------------------------------------------------------------------ */

function ToolRow({ projectId, commands: k }: { projectId: string; commands: Commands }) {
  const { dirty, saving, save, label } = useSaveStatus();
  const ready = k["file.save"].enabled;
  const locked = Boolean(k["view.lock"].checked);

  return (
    <div className="flex h-11 items-center gap-1 px-3 md:px-4">
      <div className="flex min-w-0 items-center gap-0.5" role="toolbar" aria-label="Editing tools">
        <ToolButton label="Select and move" pressed={!locked} onClick={() => locked && k["view.lock"].run()}>
          <MousePointer2 size={15} aria-hidden />
        </ToolButton>
        <ToolButton label="Lock layout" shortcut={sc(k["view.lock"])} pressed={locked} onClick={k["view.lock"].run}>
          <Lock size={14} aria-hidden />
        </ToolButton>
        <ToolSeparator />
        <ToolButton label="Undo" shortcut={sc(k["edit.undo"])} onClick={k["edit.undo"].run} disabled={!k["edit.undo"].enabled}>
          <Undo2 size={15} aria-hidden />
        </ToolButton>
        <ToolButton label="Redo" shortcut={sc(k["edit.redo"])} onClick={k["edit.redo"].run} disabled={!k["edit.redo"].enabled}>
          <Redo2 size={15} aria-hidden />
        </ToolButton>
        <ToolSeparator className="hidden sm:block" />
        {/* also in Edit > Reset all positions */}
        <ToolButton label="Reset all positions" onClick={k["edit.resetPositions"].run} disabled={!k["edit.resetPositions"].enabled} className="hidden sm:inline-grid">
          <RotateCcw size={14} aria-hidden />
        </ToolButton>
      </div>

      <Position />

      <div className="ml-auto flex items-center gap-1.5 sm:gap-2">
        <StepTabs projectId={projectId} variant="editor" className="hidden lg:block" />
        <StepMenu projectId={projectId} className="lg:hidden" />
        <ToolSeparator className="hidden sm:block" />
        <span className="hidden min-w-[7.5rem] text-right text-[11px] text-ink-3 sm:inline" aria-live="polite">
          {label}
        </span>
        <Tooltip label={`Save  ${sc(k["file.save"])}`} side="bottom">
          <EditorButton onClick={() => void save()} disabled={!ready || saving} className={cx(dirty && "border-brass text-brass-3")} aria-label="Save">
            {saving ? <Spinner className="h-3 w-3" /> : <Save size={13} aria-hidden />}
            <span className="hidden sm:inline">Save</span>
          </EditorButton>
        </Tooltip>
        <EditorButton variant="primary" onClick={k["nav.preview"].run} disabled={!k["nav.preview"].enabled} aria-label="Continue to Preview">
          <span className="hidden sm:inline">Continue to Preview</span>
          <span className="sm:hidden">Preview</span>
          <ArrowRight size={13} aria-hidden />
        </EditorButton>
      </div>
    </div>
  );
}

/** "Bar 18 of 56 · 12 of 14 parts", updated only when the bar changes. */
function Position() {
  const infoMap = useProject((s) => s.infoMap);
  const shown = useProject((s) => s.display?.visibleParts.length ?? 0);
  const { measureAt } = useProjectTiming();
  const bar = usePlayback((s) => measureAt(s.time));
  if (!infoMap) return null;
  return (
    <p className="tnum ml-3 hidden truncate text-[11.5px] text-ink-3 xl:block">
      <span className="text-ink-2">Bar {barNumber(infoMap, bar)}</span> of {infoMap.measures.length}
      <span className="mx-1.5 text-ink-4">·</span>
      {shown} of {infoMap.instruments.length} parts shown
    </p>
  );
}
