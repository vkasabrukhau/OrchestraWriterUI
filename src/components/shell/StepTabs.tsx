"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { Check } from "lucide-react";
import { Tooltip } from "@/components/ui/Tooltip";
import { useProject } from "@/lib/store/project";
import { cx } from "@/lib/utils/format";
import type { ProjectStage } from "@/shared/domain";

export const STEPS: Array<{ id: ProjectStage; label: string }> = [
  { id: "import", label: "Import" },
  { id: "sync", label: "Sync" },
  { id: "customize", label: "Customize" },
  { id: "preview", label: "Preview" },
  { id: "export", label: "Export" },
];

const ORDER: ProjectStage[] = STEPS.map((s) => s.id);

export interface StepState {
  id: ProjectStage;
  label: string;
  active: boolean;
  done: boolean;
  enabled: boolean;
  skipped: boolean;
}

/**
 * The five project steps (ADR 0003) and which ones can be opened: a step is
 * open once the project has reached it, and Sync is skipped without a recording.
 */
export function useSteps(projectId: string): StepState[] {
  const pathname = usePathname();
  const summary = useProject((s) => s.summary);
  const loadedId = useProject((s) => s.projectId);
  // the store may still hold the previous project while this one loads
  const project = loadedId === projectId ? summary : null;
  const current = ORDER.find((st) => pathname.endsWith("/" + st)) ?? "import";
  const reached = ORDER.indexOf(project?.stage ?? "import");
  const noRecording = project ? !project.hasRecording : false;

  return STEPS.map((s) => {
    const idx = ORDER.indexOf(s.id);
    const active = s.id === current;
    const skipped = s.id === "sync" && noRecording;
    return {
      ...s,
      active,
      skipped,
      done: idx < reached && !skipped && !active,
      enabled: active || (idx <= reached && !skipped && project !== null),
    };
  });
}

/** One step link. `variant="editor"` is the compact tab used in the editor toolbar. */
export function Step({ step: s, projectId, variant = "nav" }: { step: StepState; projectId: string; variant?: "nav" | "editor" }) {
  const editor = variant === "editor";
  const cls = cx(
    "relative flex items-center gap-1.5 transition-colors",
    editor ? "h-7 rounded-[var(--radius-sm)] px-2.5 text-[12px]" : "px-2.5 py-2 text-[13.5px] lg:px-3",
    s.active ? (editor ? "bg-brass-soft font-semibold text-brass-3" : "font-medium text-ink") : s.enabled ? "text-ink-2 hover:text-ink" : "text-ink-4",
    editor && !s.active && s.enabled && "hover:bg-paper-3",
    s.skipped && "line-through decoration-ink-4",
  );
  const inner = (
    <>
      {s.done && <Check size={editor ? 11 : 12} className="text-brass" aria-hidden />}
      {s.label}
      {s.done && <span className="sr-only"> (done)</span>}
      {s.active && !editor && <span className="absolute inset-x-3 -bottom-[13px] h-0.5 rounded-full bg-brass" aria-hidden />}
    </>
  );
  if (!s.enabled) {
    return (
      <Tooltip label={s.skipped ? "No recording: playback is generated from the score" : "Finish the previous step first"} side="bottom">
        <span className={cls} aria-disabled tabIndex={0}>
          {inner}
        </span>
      </Tooltip>
    );
  }
  return (
    <Link href={`/projects/${projectId}/${s.id}`} className={cls} aria-current={s.active ? "step" : undefined}>
      {inner}
    </Link>
  );
}

/** The step list as a navigation landmark. */
export function StepTabs({ projectId, variant = "nav", className }: { projectId: string; variant?: "nav" | "editor"; className?: string }) {
  const steps = useSteps(projectId);
  return (
    <nav className={className} aria-label="Project steps">
      <ol className="flex items-center gap-0.5">
        {steps.map((s) => (
          <li key={s.id}>
            <Step step={s} projectId={projectId} variant={variant} />
          </li>
        ))}
      </ol>
    </nav>
  );
}
