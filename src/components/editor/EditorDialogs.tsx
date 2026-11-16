"use client";

import { useState } from "react";
import { Dialog } from "@/components/ui/Dialog";
import { Kbd } from "@/components/ui/Kbd";
import { DynamicLegend } from "@/components/music/DynamicLegend";
import { formatShortcut, isMacPlatform, type CommandId, type Commands } from "@/lib/editor/commands";
import { useEditor } from "@/lib/store/editor";
import { useProject } from "@/lib/store/project";
import { useProjectTiming } from "@/lib/store/useProjectTiming";
import { EditorButton, FieldBox, bareInput } from "./parts";

/** Rename, Go to bar, Keyboard shortcuts and "How the display works". */
export function EditorDialogs({ commands }: { commands: Commands }) {
  const dialog = useEditor((s) => s.dialog);
  const openDialog = useEditor((s) => s.openDialog);
  const close = () => openDialog(null);
  return (
    <>
      {dialog === "rename" && <RenameDialog onClose={close} />}
      {dialog === "goto" && <GoToBarDialog onClose={close} />}
      <ShortcutsDialog open={dialog === "shortcuts"} onClose={close} commands={commands} />
      <AboutDialog open={dialog === "about"} onClose={close} />
    </>
  );
}

function RenameDialog({ onClose }: { onClose: () => void }) {
  const current = useProject((s) => s.summary?.title ?? "");
  const rename = useProject((s) => s.rename);
  const [title, setTitle] = useState(current);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const submit = async () => {
    if (!title.trim()) return;
    setBusy(true);
    try {
      await rename(title);
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not rename the project");
    } finally {
      setBusy(false);
    }
  };
  return (
    <Dialog
      open
      onClose={onClose}
      title="Rename project"
      width="sm"
      footer={
        <>
          <EditorButton variant="ghost" onClick={onClose}>
            Cancel
          </EditorButton>
          <EditorButton variant="primary" onClick={() => void submit()} disabled={busy || !title.trim()}>
            Rename
          </EditorButton>
        </>
      }
    >
      <form
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
      >
        <label htmlFor="rename-title" className="mb-1.5 block text-[12px] text-ink-2">
          Title
        </label>
        <FieldBox>
          <input id="rename-title" className={bareInput} value={title} onChange={(e) => setTitle(e.target.value)} autoFocus maxLength={200} />
        </FieldBox>
        {error && <p className="mt-2 text-[12px] text-danger">{error}</p>}
      </form>
    </Dialog>
  );
}

function GoToBarDialog({ onClose }: { onClose: () => void }) {
  const total = useProject((s) => s.infoMap?.measures.length ?? 0);
  const { seekMeasure } = useProjectTiming();
  const [value, setValue] = useState("");
  const n = Number(value);
  const valid = Number.isInteger(n) && n >= 1 && n <= total;
  const go = () => {
    if (!valid) return;
    seekMeasure(n);
    onClose();
  };
  return (
    <Dialog
      open
      onClose={onClose}
      title="Go to bar"
      width="sm"
      footer={
        <>
          <EditorButton variant="ghost" onClick={onClose}>
            Cancel
          </EditorButton>
          <EditorButton variant="primary" onClick={go} disabled={!valid}>
            Go
          </EditorButton>
        </>
      }
    >
      <form
        onSubmit={(e) => {
          e.preventDefault();
          go();
        }}
      >
        <label htmlFor="goto-bar" className="mb-1.5 block text-[12px] text-ink-2">
          Bar (1–{total}, in playback order)
        </label>
        <FieldBox>
          <input id="goto-bar" className={bareInput} inputMode="numeric" value={value} onChange={(e) => setValue(e.target.value.replace(/\D/g, ""))} autoFocus />
        </FieldBox>
      </form>
    </Dialog>
  );
}

const SHORTCUT_GROUPS: Array<{ title: string; ids: CommandId[] }> = [
  { title: "File", ids: ["file.save", "file.export", "file.open"] },
  { title: "Edit", ids: ["edit.undo", "edit.redo", "edit.find", "edit.deselect"] },
  { title: "Parts", ids: ["parts.toggleVisible", "parts.solo"] },
  { title: "View", ids: ["view.instruments", "view.properties", "view.lanes", "view.lock", "view.fullscreen"] },
  { title: "Playback", ids: ["play.toggle", "play.start", "play.back", "play.forward", "play.goto", "play.mute"] },
];

function ShortcutsDialog({ open, onClose, commands }: { open: boolean; onClose: () => void; commands: Commands }) {
  return (
    <Dialog open={open} onClose={onClose} title="Keyboard shortcuts" width="lg">
      <div className="grid gap-x-8 gap-y-5 sm:grid-cols-2">
        {SHORTCUT_GROUPS.map((g) => (
          <section key={g.title} aria-label={g.title}>
            <h3 className="mb-1.5 text-[11px] font-semibold uppercase tracking-[0.08em] text-ink-3">{g.title}</h3>
            <dl className="space-y-1">
              {g.ids.map((id) => {
                const c = commands[id];
                return (
                  <Row key={id} label={id === "play.toggle" ? "Play / Pause" : c.label} keys={c.shortcut ? formatShortcut(c.shortcut) : ""} />
                );
              })}
            </dl>
          </section>
        ))}
        <section aria-label="Stage">
          <h3 className="mb-1.5 text-[11px] font-semibold uppercase tracking-[0.08em] text-ink-3">Stage (when focused)</h3>
          <dl className="space-y-1">
            <Row label="Nudge selected part" keys="← → ↑ ↓" />
            <Row label="Nudge further" keys={isMacPlatform() ? "⇧ + arrows" : "Shift + arrows"} />
            <Row label="Skip 30 seconds" keys={isMacPlatform() ? "⇧← ⇧→" : "Shift+← Shift+→"} />
          </dl>
        </section>
      </div>
    </Dialog>
  );
}

function Row({ label, keys }: { label: string; keys: string }) {
  return (
    <div className="flex items-center justify-between gap-4 text-[12.5px]">
      <dt className="text-ink-2">{label}</dt>
      <dd>{keys && <Kbd>{keys}</Kbd>}</dd>
    </div>
  );
}

function AboutDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  return (
    <Dialog open={open} onClose={onClose} title="How the display works" width="md">
      <div className="space-y-4 text-[13px] leading-relaxed text-ink-2">
        <p>
          Each glow is one part from the score. It lights up while the part plays, and goes dark when the part rests.
        </p>
        <DynamicLegend />
        <p>
          <strong className="font-semibold text-ink">Color shows the section.</strong> Strings, woodwinds, brass and percussion each have their own color. You can change any of
          them, or give a single part its own color.
        </p>
        <p>The light follows what the score says, not how loud the recording is. Hiding a part changes the picture only; the audio stays the same.</p>
      </div>
    </Dialog>
  );
}
