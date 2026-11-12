import { WorkflowNav } from "@/components/shell/WorkflowNav";
import { ProjectLoader } from "@/components/shell/ProjectLoader";
import { PlaybackSourceMount } from "@/components/music/PlaybackSourceMount";
import { WorkflowMain } from "@/components/shell/WorkflowMain";

export default async function WorkflowLayout({ children, params }: LayoutProps<"/projects/[projectId]">) {
  const { projectId } = await params;
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
