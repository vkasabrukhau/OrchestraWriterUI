"use client";

import { useEffect, useMemo, useRef } from "react";
import { useRouter } from "next/navigation";
import { buildCommands, clampPosition, matchesShortcut, NUDGE_STEP, type Commands } from "@/lib/editor/commands";
import { useEditor } from "@/lib/store/editor";
import { useProject } from "@/lib/store/project";
import { usePlayback } from "@/lib/store/playback";
import { usePreferences } from "@/lib/store/preferences";
import { toast } from "@/components/ui/toast";

/** The editor's commands, rebuilt when any state they show changes. */
export function useEditorCommands(projectId: string): Commands {
  const router = useRouter();
  const ready = useProject((s) => s.projectId === projectId && s.status === "ready" && s.display !== null);
  const dirty = useProject((s) => s.dirty);
  const canUndo = useProject((s) => s.canUndo);
  const canRedo = useProject((s) => s.canRedo);
  const display = useProject((s) => s.display);
  const partCount = useProject((s) => s.infoMap?.instruments.length ?? 0);
  const selectedId = useEditor((s) => s.selectedId);
  const panels = useEditor((s) => s.panels);
  const showSeating = useEditor((s) => s.showSeating);
  const showLegend = useEditor((s) => s.showLegend);
  const locked = useEditor((s) => s.locked);
  const playing = usePlayback((s) => s.playing);
  const loop = usePlayback((s) => s.loop);
  const muted = usePlayback((s) => s.muted);
  const rate = usePlayback((s) => s.rate);
  const theme = usePreferences((s) => s.theme);

  return useMemo(() => {
    const p = useProject.getState();
    const play = usePlayback.getState();
    const editor = useEditor.getState();
    const sel = selectedId;
    const visible = display?.visibleParts ?? [];
    return buildCommands({
      ready,
      dirty,
      canUndo,
      canRedo,
      selectedId: sel,
      selectedVisible: sel ? visible.includes(sel) : false,
      selectedHasColor: sel ? Boolean(display?.colors[sel]) : false,
      soloed: visible.length === 1 ? visible[0] : null,
      allVisible: visible.length >= partCount,
      panels,
      showLabels: display?.showLabels ?? true,
      labelMode: display?.labelMode ?? "sections",
      showSeating,
      showLegend,
      locked,
      theme,
      reducedMotion: display?.reducedMotion ?? false,
      playing,
      loop,
      muted,
      rate,
      act: {
        navigate: (path) => router.push(path),
        save: () => {
          void p.saveNow().then(
            () => !useProject.getState().saveError && toast.success("Saved", { id: "editor-save" }),
            () => {},
          );
        },
        exportProject: () => {
          p.setStage("export");
          router.push(`/projects/${projectId}/export`);
        },
        openDialog: editor.openDialog,
        undo: p.undo,
        redo: p.redo,
        focusSearch: editor.focusSearch,
        select: editor.select,
        resetPart: p.resetPart,
        resetPositions: p.resetPositions,
        resetColors: p.resetColors,
        togglePanel: editor.togglePanel,
        setShowLabels: p.setShowLabels,
        setLabelMode: p.setLabelMode,
        setShowSeating: editor.setShowSeating,
        setShowLegend: editor.setShowLegend,
        setLocked: editor.setLocked,
        fullscreen: editor.requestFullscreen,
        setTheme: usePreferences.getState().setTheme,
        setReducedMotion: p.setReducedMotion,
        togglePlay: play.toggle,
        seek: play.seek,
        skip: play.skip,
        toggleLoop: play.toggleLoop,
        setRate: play.setRate,
        toggleMute: play.toggleMute,
        setVisible: p.setVisible,
        solo: p.soloPart,
        showAll: () => {
          const s = useProject.getState();
          // one undo step for the whole batch
          s.beginGesture();
          s.infoMap?.instruments.forEach((i) => s.setVisible(i.id, true));
          s.endGesture();
        },
        clearPartColor: (id) => p.setPartColor(id, null),
        continueToPreview: () => {
          p.setStage("preview");
          router.push(`/projects/${projectId}/preview`);
        },
      },
    });
  }, [router, projectId, ready, dirty, canUndo, canRedo, display, partCount, selectedId, panels, showSeating, showLegend, locked, playing, loop, muted, rate, theme]);
}

function isTyping(el: Element | null): boolean {
  if (!el) return false;
  const h = el as HTMLElement;
  return h.tagName === "INPUT" || h.tagName === "TEXTAREA" || h.tagName === "SELECT" || h.isContentEditable;
}

/** Each arrow-key press starts a new undo step; its auto-repeats join it. */
let nudgePress = 0;

/**
 * Editor shortcuts. Listens in the capture phase so that, while the stage has
 * focus and a part is selected, the arrow keys nudge the part and never reach
 * the Transport's seek shortcut.
 */
export function useEditorShortcuts(commands: Commands) {
  const ref = useRef(commands);
  useEffect(() => {
    ref.current = commands;
  });

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented || e.isComposing) return;
      const active = document.activeElement;
      // dialogs and open menus own their keys
      if (active?.closest('[role="dialog"], [role="menu"], [role="alertdialog"]')) return;
      const typing = isTyping(active);
      const withMod = e.metaKey || e.ctrlKey;

      // arrow-key nudging, scoped to the focused stage
      if (!typing && !withMod && !e.altKey && active?.hasAttribute("data-editor-stage") && e.key.startsWith("Arrow")) {
        const { selectedId, locked } = useEditor.getState();
        const display = useProject.getState().display;
        if (selectedId && !locked && display) {
          const f = e.shiftKey ? NUDGE_STEP.bigFactor : 1;
          const dx = e.key === "ArrowLeft" ? -NUDGE_STEP.x : e.key === "ArrowRight" ? NUDGE_STEP.x : 0;
          const dy = e.key === "ArrowUp" ? -NUDGE_STEP.y : e.key === "ArrowDown" ? NUDGE_STEP.y : 0;
          const p = display.positions[selectedId] ?? { x: 0.5, y: 0.5 };
          if (!e.repeat) nudgePress++;
          useProject.getState().setPosition(selectedId, clampPosition({ x: p.x + dx * f, y: p.y + dy * f }), { merge: `nudge:${selectedId}:${nudgePress}` });
          e.preventDefault();
          e.stopPropagation();
          return;
        }
      }

      for (const c of Object.values(ref.current)) {
        if (!c.shortcut || c.shortcutElsewhere || !matchesShortcut(e, c.shortcut)) continue;
        // while typing, only modifier shortcuts (and not ⌘Z, which belongs to the field)
        if (typing && (!c.shortcut.mod || c.id === "edit.undo" || c.id === "edit.redo")) return;
        if (!c.enabled) {
          // A disabled plain key passes through (Escape still closes a popover,
          // a focused control still gets its letter). A disabled ⌘/Ctrl
          // shortcut is still consumed so the browser's own ⌘S / ⌘O don't
          // open a save or file dialog while the project loads.
          if (!c.shortcut.mod) continue;
          e.preventDefault();
          return;
        }
        e.preventDefault();
        e.stopPropagation();
        c.run();
        return;
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, []);
}
