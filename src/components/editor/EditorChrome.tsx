"use client";

import { useMemo, type ReactNode } from "react";
import { ArrowRight, Lock, Menu as MenuIcon, MousePointer2, Redo2, RotateCcw, Undo2 } from "lucide-react";
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
import { Button } from "@/components/ui/Button";
import { Tooltip } from "@/components/ui/Tooltip";
import { formatShortcut, type Command, type Commands } from "@/lib/editor/commands";
import { useEditor } from "@/lib/store/editor";
import { useProject } from "@/lib/store/project";
import { SECTIONS, SECTION_ORDER, type Section } from "@/shared/sections";
import { EditorDialogs } from "./EditorDialogs";
import { ToolButton, ToolSeparator } from "./parts";
import { useEditorCommands, useEditorShortcuts } from "./useEditorCommands";

/**
 * The editor's tool bar, the top row of the editor window (ADR 0023): menus
 * (File, Edit, View, Playback, Parts, Help), tools, undo/redo, the project
 * name and Continue to Preview. The steps, Save and the account menu are in
 * the workflow header above it, as on Sync. Every entry is a command from
 * `src/lib/editor/commands.ts`; this also binds their keyboard shortcuts.
 */
export function EditorChrome({ projectId }: { projectId: string }) {
  const commands = useEditorCommands(projectId);
  useEditorShortcuts(commands);
  return (
    <div className="z-30 shrink-0 border-b border-line bg-paper">
      <ToolRow projectId={projectId} commands={commands} />
      <EditorDialogs commands={commands} />
    </div>
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

/** The menu bar; narrow windows get the same menus in one list, grouped under their names. */
function Menus({ commands: k }: { commands: Commands }) {
  return (
    <>
      <Menubar className="hidden md:flex">
        {MENUS.map(({ label, Items }) => (
          <MenubarMenu key={label} label={label}>
            <Items commands={k} />
          </MenubarMenu>
        ))}
      </Menubar>
      <Menubar className="md:hidden">
        <MenubarMenu label={<MenuIcon size={15} aria-hidden />} ariaLabel="Menu" inlineSubs>
          {MENUS.map(({ label, Items }) => (
            <MenubarSub key={label} label={label}>
              <Items commands={k} />
            </MenubarSub>
          ))}
        </MenubarMenu>
      </Menubar>
    </>
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
  const loadedId = useProject((s) => s.projectId);
  const summary = useProject((s) => s.summary);
  const title = loadedId === projectId ? summary?.title : undefined;
  const openDialog = useEditor((s) => s.openDialog);
  const locked = Boolean(k["view.lock"].checked);

  return (
    <div className="relative flex h-11 items-center gap-1 px-2.5">
      <Menus commands={k} />
      <ToolSeparator />
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
        <ToolSeparator className="max-sm:hidden" />
        {/* also in Edit > Reset all positions */}
        <ToolButton label="Reset all positions" onClick={k["edit.resetPositions"].run} disabled={!k["edit.resetPositions"].enabled} className="max-sm:hidden">
          <RotateCcw size={14} aria-hidden />
        </ToolButton>
      </div>

      {/* window title: the project name, click to rename (also File > Rename) */}
      <div className="pointer-events-none absolute inset-x-0 hidden justify-center xl:flex">
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

      {/* the same button as Sync's "Continue to Customize" */}
      <Button
        size="sm"
        className="ml-auto shrink-0"
        onClick={k["nav.preview"].run}
        disabled={!k["nav.preview"].enabled}
        trailing={<ArrowRight size={14} />}
        aria-label="Continue to Preview"
      >
        <span className="max-sm:hidden">Continue to Preview</span>
        <span className="sm:hidden">Preview</span>
      </Button>
    </div>
  );
}
