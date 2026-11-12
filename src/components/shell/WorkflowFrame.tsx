"use client";

import { useEffect, type ReactNode } from "react";
import { usePathname } from "next/navigation";
import { EditorChrome } from "@/components/editor/EditorChrome";
import { PlaybackSourceMount } from "@/components/music/PlaybackSourceMount";
import { ProjectLoader } from "./ProjectLoader";
import { WorkflowNav } from "./WorkflowNav";

/** Steps that use the editor chrome (ADR 0014). Sync and Preview move here in a follow-up. */
const EDITOR_STEPS = ["customize"];

/**
 * The frame around a project's step pages. Editor steps get the menu bar and
 * tool bar, fill the window and set `html[data-surface="editor"]`; the other
 * steps keep the workflow header and the centered page column.
 */
export function WorkflowFrame({ projectId, children }: { projectId: string; children: ReactNode }) {
  const pathname = usePathname();
  const editor = EDITOR_STEPS.some((s) => pathname.endsWith("/" + s));

  useEffect(() => {
    if (!editor) return;
    const root = document.documentElement;
    root.dataset.surface = "editor";
    return () => {
      delete root.dataset.surface;
    };
  }, [editor]);

  if (editor) {
    return (
      <div className="flex min-h-dvh flex-col bg-paper lg:h-dvh lg:min-h-0 lg:overflow-hidden">
        <EditorChrome projectId={projectId} />
        <ProjectLoader projectId={projectId}>
          <PlaybackSourceMount />
          <main className="flex min-h-0 flex-1 flex-col">{children}</main>
        </ProjectLoader>
      </div>
    );
  }

  return (
    <div className="flex min-h-full flex-1 flex-col">
      <WorkflowNav projectId={projectId} />
      <ProjectLoader projectId={projectId}>
        <PlaybackSourceMount />
        <main className="mx-auto w-full max-w-[1440px] flex-1 px-5 pb-16 pt-7 md:px-8">{children}</main>
      </ProjectLoader>
    </div>
  );
}
