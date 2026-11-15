"use client";

import { useEffect, useRef } from "react";
import type { InfoMap } from "@/shared/info-map";
import { usePlayback } from "@/lib/store/playback";
import { createBufferedRecordingEngine, createRecordingEngine, createScoreSynthEngine, type AudioEngine } from "./engine";

/**
 * What the transport should play: the uploaded recording (presigned URL, and
 * when available a loader for its decoded audio, which plays sample-accurately)
 * or the score itself.
 */
export type PlaybackSource =
  | { kind: "recording"; url: string; loadBuffer?: () => Promise<AudioBuffer | null> }
  | { kind: "score"; infoMap: InfoMap }
  | null;

export function createEngineFor(source: Exclude<PlaybackSource, null>): AudioEngine {
  if (source.kind === "score") return createScoreSynthEngine(source.infoMap);
  return source.loadBuffer ? createBufferedRecordingEngine(source.url, source.loadBuffer) : createRecordingEngine(source.url);
}

/**
 * Imperative form: create the engine, attach it to the playback store, and
 * return a cleanup that detaches and destroys it.
 */
export function attachPlaybackSource(source: PlaybackSource): () => void {
  if (!source) {
    usePlayback.getState().attach(null);
    return () => {};
  }
  const engine = createEngineFor(source);
  usePlayback.getState().attach(engine);
  return () => {
    if (usePlayback.getState().engine === engine) usePlayback.getState().attach(null);
    engine.destroy();
  };
}

/**
 * Mount once in the workflow layout. Recreates the engine when the URL or
 * info map changes (e.g. a refreshed presigned URL); the store keeps the
 * playhead and re-seeks the new engine once it has loaded. Returns the
 * store's loading/error state for convenience.
 */
export function useAudioEngine(
  source: PlaybackSource,
  options: {
    /** returns a fresh recording URL when the current one stops working (expired presigned link) */
    refreshUrl?: () => Promise<string | null>;
    /** the recording's decoded audio, for sample-accurate playback (null: stream the file) */
    loadBuffer?: () => Promise<AudioBuffer | null>;
  } = {},
): { ready: boolean; error: string | null } {
  const kind = source?.kind ?? null;
  const url = source?.kind === "recording" ? source.url : null;
  const infoMap = source?.kind === "score" ? source.infoMap : null;
  const refreshRef = useRef(options.refreshUrl);
  const loadBufferRef = useRef(options.loadBuffer);
  useEffect(() => {
    refreshRef.current = options.refreshUrl;
    loadBufferRef.current = options.loadBuffer;
  });
  const engineRef = useRef<AudioEngine | null>(null);
  const lastRecoveryRef = useRef(0);

  useEffect(() => {
    if (kind === "recording" && url) {
      const current = engineRef.current;
      // A refreshed presigned URL for the same recording: swap the source in
      // place so playback and the playhead are not interrupted.
      if (current && current.kind === "recording" && current.replaceSource && usePlayback.getState().engine === current) {
        current.replaceSource(url);
        return;
      }
      const loadBuffer = loadBufferRef.current;
      const cleanup = attachPlaybackSource({ kind, url, loadBuffer: loadBuffer ? () => loadBuffer() : undefined });
      const engine = usePlayback.getState().engine;
      engineRef.current = engine;
      engine?.setErrorHandler?.((message) => {
        const refresh = refreshRef.current;
        const now = Date.now();
        if (!refresh || now - lastRecoveryRef.current < 30_000) {
          usePlayback.setState({ error: message });
          return;
        }
        lastRecoveryRef.current = now;
        void refresh()
          .then((fresh) => {
            if (fresh && engineRef.current === engine) engine.replaceSource?.(fresh);
            else usePlayback.setState({ error: message });
          })
          .catch(() => usePlayback.setState({ error: message }));
      });
      return () => {
        engine?.setErrorHandler?.(null);
        if (engineRef.current === engine) engineRef.current = null;
        cleanup();
      };
    }
    engineRef.current = null;
    if (kind === "score" && infoMap) return attachPlaybackSource({ kind, infoMap });
    return attachPlaybackSource(null);
  }, [kind, url, infoMap]);

  const ready = usePlayback((s) => s.ready);
  const error = usePlayback((s) => s.error);
  return { ready, error };
}

/** Alias matching the file name. */
export const usePlaybackEngine = useAudioEngine;
