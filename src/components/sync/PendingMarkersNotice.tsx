"use client";

import Link from "next/link";
import { appliedOf, pendingOf } from "@/shared/sync";
import { useProject } from "@/lib/store/project";

/** Preview and Export: markers placed on Sync but not applied are not in playback or the video. */
export function PendingMarkersNotice({ projectId }: { projectId: string }) {
  const sync = useProject((s) => s.sync);
  const hasRecording = useProject((s) => s.summary?.hasRecording ?? false);
  const n = sync && hasRecording ? pendingOf(sync.manual, appliedOf(sync)).length : 0;
  if (n === 0) return null;
  return (
    <p className="rounded-md border border-brass/40 bg-brass-soft px-3 py-2 text-[13px] text-ink-2" role="status">
      {n} marker{n === 1 ? " on Sync isn't" : "s on Sync aren't"} applied, so playback and the video don&apos;t use {n === 1 ? "it" : "them"} yet.{" "}
      <Link href={`/projects/${projectId}/sync`} className="text-brass-3 underline">
        Recompute on Sync
      </Link>
    </p>
  );
}
