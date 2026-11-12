"use client";

import Link from "next/link";
import { ArrowLeft, Save } from "lucide-react";
import { Logo } from "@/components/brand/Logo";
import { Button } from "@/components/ui/Button";
import { Tooltip } from "@/components/ui/Tooltip";
import { useProject } from "@/lib/store/project";
import { cx } from "@/lib/utils/format";
import { UserMenu } from "./UserMenu";
import { Step, useSteps } from "./StepTabs";
import { useSaveStatus } from "./useSaveStatus";

export function WorkflowNav({ projectId }: { projectId: string }) {
  const summary = useProject((s) => s.summary);
  const loadedId = useProject((s) => s.projectId);
  const project = loadedId === projectId ? summary : null;
  const steps = useSteps(projectId);
  const { dirty, saving, save, label: saveLabel } = useSaveStatus();

  return (
    <header className="sticky top-0 z-40 border-b border-line bg-paper/85 backdrop-blur-md">
      <div className="mx-auto flex h-16 max-w-[1440px] items-center gap-4 px-5 md:px-8">
        <div className="flex min-w-0 items-center gap-3">
          <Tooltip label="Back to library" side="bottom">
            <Link href="/library" className="focus-round grid h-8 w-8 place-items-center rounded-full text-ink-3 hover:bg-paper-3 hover:text-ink" aria-label="Back to library">
              <ArrowLeft size={16} aria-hidden />
            </Link>
          </Tooltip>
          <Logo compact />
        </div>
        <nav className="hidden min-w-0 flex-1 items-center justify-center gap-0.5 md:flex" aria-label="Project steps">
          <ol className="flex items-center gap-0.5">
            {steps.map((s) => (
              <li key={s.id}>
                <Step step={s} projectId={projectId} />
              </li>
            ))}
          </ol>
        </nav>
        <div className="flex-1 md:hidden" />
        <span className="hidden text-[12px] text-ink-3 sm:inline" aria-live="polite">
          {saveLabel}
        </span>
        <Button variant={dirty ? "primary" : "outline"} size="sm" leading={<Save size={14} aria-hidden />} onClick={save} loading={saving} disabled={!project}>
          Save
        </Button>
        <UserMenu />
      </div>
      {/* mobile stepper */}
      <nav className="overflow-x-auto px-5 pb-2 md:hidden" aria-label="Project steps">
        <ol className="flex gap-4">
          {steps.map((s) => (
            <li key={s.id} className="shrink-0">
              {s.enabled ? (
                <Link
                  href={`/projects/${projectId}/${s.id}`}
                  aria-current={s.active ? "step" : undefined}
                  className={cx("text-[13px] whitespace-nowrap", s.active ? "font-medium text-ink" : "text-ink-3", s.skipped && "line-through")}
                >
                  {s.label}
                </Link>
              ) : (
                <span aria-disabled className={cx("text-[13px] whitespace-nowrap text-ink-4", s.skipped && "line-through")}>
                  {s.label}
                </span>
              )}
            </li>
          ))}
        </ol>
      </nav>
    </header>
  );
}
