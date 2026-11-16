"use client";

import { useEffect, useState } from "react";
import { toast } from "@/components/ui/toast";
import { useProject } from "@/lib/store/project";

/** Save button state shared by the workflow header and the editor toolbar. */
export function useSaveStatus() {
  const dirty = useProject((s) => s.dirty);
  const savedAt = useProject((s) => s.savedAt);
  const saveError = useProject((s) => s.saveError);
  // `markSaved` is the fire-and-forget form of `saveNow`; awaiting it drives "Saving…"
  const saveNow = useProject((s) => s.saveNow);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (saveError) toast.error("Could not save the project", { id: "project-save-error", description: saveError });
  }, [saveError]);

  const save = async () => {
    setSaving(true);
    try {
      await saveNow();
    } finally {
      setSaving(false);
    }
  };

  const label = saving ? "Saving…" : dirty ? "Unsaved changes" : savedAt ? "Saved" : "";
  return { dirty, saving, save, label, error: saveError };
}
