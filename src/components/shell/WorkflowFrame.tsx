"use client";

import { useLayoutEffect, type ReactNode } from "react";
import { usePathname } from "next/navigation";
import { EditorChrome } from "@/components/editor/EditorChrome";
import { useEditor } from "@/lib/store/editor";
import { isEditorPath } from "./editor-steps";
import { PlaybackSourceMount } from "@/components/music/PlaybackSourceMount";
import { ProjectLoader } from "./ProjectLoader";
import { WorkflowMain } from "./WorkflowMain";
import { WorkflowNav } from "./WorkflowNav";

/**
 * The frame around a project's step pages. Every step has the workflow
 * header. Editor steps then fill the window with one bordered editor window
 * (tool bar on top, like the Sync workspace) and set
 * `html[data-surface="editor"]`; the other steps use `WorkflowMain` (Sync
 * full width, the rest in the centered page column).
 */
export function WorkflowFrame({ projectId, children }: { projectId: string; children: ReactNode }) {
  const pathname = usePathname();
  const editor = isEditorPath(pathname);

  // Layout effects run before the browser paints, so neither the old surface
  // nor the previous project's selection and panels ever show. (A full page
  // load already has the surface from the inline script in the root layout.)
  useLayoutEffect(() => {
    if (!editor) return;
    const root = document.documentElement;
    root.dataset.surface = "editor";
    return () => {
      delete root.dataset.surface;
    };
  }, [editor]);

  useLayoutEffect(() => {
    useEditor.getState().bind(projectId);
  }, [projectId]);

  if (editor) {
    return (
      <div className="flex min-h-dvh flex-col bg-paper lg:h-dvh lg:min-h-0 lg:overflow-hidden">
        <WorkflowNav projectId={projectId} />
        {/* the same inset and border as the Sync workspace */}
        <div className="flex min-h-0 flex-1 flex-col px-3 pb-3 pt-3 md:px-4">
          <div className="flex min-h-0 flex-1 flex-col overflow-hidden rounded-[10px] border border-line bg-paper">
            <EditorChrome projectId={projectId} />
            <ProjectLoader projectId={projectId}>
              <PlaybackSourceMount />
              <main className="flex min-h-0 flex-1 flex-col">{children}</main>
            </ProjectLoader>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="flex min-h-full flex-1 flex-col">
      <WorkflowNav projectId={projectId} />
      <ProjectLoader projectId={projectId}>
        <PlaybackSourceMount />
        <WorkflowMain>{children}</WorkflowMain>
      </ProjectLoader>
    </div>
  );
}
