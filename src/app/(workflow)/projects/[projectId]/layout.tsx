import { WorkflowFrame } from "@/components/shell/WorkflowFrame";

export default async function WorkflowLayout({ children, params }: LayoutProps<"/projects/[projectId]">) {
  const { projectId } = await params;
  return <WorkflowFrame projectId={projectId}>{children}</WorkflowFrame>;
}
