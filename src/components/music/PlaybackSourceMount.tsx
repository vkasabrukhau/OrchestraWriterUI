"use client";

import { useCallback, useEffect, useMemo } from "react";
import { usePathname } from "next/navigation";
import { api } from "@/lib/api";
import { useAudioEngine, type PlaybackSource } from "@/lib/audio";
import { useProject } from "@/lib/store/project";
import { usePlayback } from "@/lib/store/playback";

/** Steps without a transport: the audio pauses there instead of playing on with no controls. */
const SILENT_STEPS = new Set(["import", "export"]);

/**
 * Mounted once in the workflow layout so Sync, Customize and Preview share
 * one audio engine (and one playhead): the uploaded recording when there is
 * one, else playback generated from the score, else a silent clock.
 */
export function PlaybackSourceMount() {
  const projectId = useProject((s) => s.projectId);
  const hasRecording = useProject((s) => s.summary?.hasRecording ?? false);
  const audioUrl = useProject((s) => s.audioUrl);
  const infoMap = useProject((s) => s.infoMap);

  const source = useMemo<PlaybackSource>(() => {
    if (hasRecording && audioUrl) return { kind: "recording", url: audioUrl };
    if (infoMap) return { kind: "score", infoMap };
    return null;
  }, [hasRecording, audioUrl, infoMap]);
  const refreshUrl = useCallback(async () => (projectId ? (await api.getProjectUrls(projectId, { fresh: true })).audio : null), [projectId]);
  // the decoded recording (shared with alignment and the waveform): exact playhead after any jump
  const loadBuffer = useCallback(async () => (projectId ? api.loadRecordingBuffer(projectId) : null), [projectId]);
  useAudioEngine(source, { refreshUrl, loadBuffer });

  const pathname = usePathname();
  const step = pathname?.split("/").filter(Boolean).pop() ?? "";
  useEffect(() => {
    if (SILENT_STEPS.has(step) && usePlayback.getState().playing) usePlayback.getState().pause();
  }, [step]);

  return null;
}
