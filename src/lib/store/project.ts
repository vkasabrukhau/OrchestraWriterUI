"use client";

import { create } from "zustand";
import type { InfoMap } from "@/shared/info-map";
import type { DisplaySettings, PartPosition } from "@/shared/project-file";
import { DEFAULT_SECTION_COLORS, type Section } from "@/shared/sections";
import { appliedOf, markerBounds, markerPosition, normalizeMarkerLabel, sameMarkerSpot, type ManualMarker, type SyncState } from "@/shared/sync";
import { canonicalPosition, normalizeMarkers } from "@/lib/score/stamps";

function newMarker(measure: number, position: number, startSec: number): ManualMarker {
  const marker: ManualMarker = { id: `mk_${measure}_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`, measure, startSec, createdAt: new Date().toISOString(), basis: "time" };
  // downbeat markers keep the original shape (no position field)
  if (position > 0) marker.position = position;
  return marker;
}

export type MarkerEditResult = { ok: true; id: string } | { ok: false; reason: "not-found" | "occupied" | "out-of-order" | "no-sync"; message: string };

const fmtSec = (t: number) => {
  const m = Math.floor(t / 60);
  const s = t - m * 60;
  return `${m}:${s.toFixed(3).padStart(6, "0")}`;
};

const sortMarkers = (list: ManualMarker[]) => list.sort((a, b) => a.measure - b.measure || markerPosition(a) - markerPosition(b));
import type { ProjectStage, ProjectSummary } from "@/shared/domain";
import type { ProjectDto } from "@/shared/api";
import { api, errorMessage } from "@/lib/api";
import { peaksFromInfoMap } from "@/lib/audio";
import { defaultPositions } from "@/lib/visualizer/seating";
import { jsonEqual } from "@/lib/utils/equal";
import { defaultDisplay } from "./display-defaults";

export { defaultDisplay };

export type ProjectLoadStatus = "idle" | "loading" | "ready" | "error" | "not-found";

/**
 * Options for display edits that arrive as a stream (a native color picker's
 * input events, a held arrow key, a slider). Consecutive edits with the same
 * `merge` key less than `MERGE_WINDOW_MS` apart become one undo step.
 */
export interface EditOptions {
  merge?: string;
}

/** Debounces for autosave. Display edits are chatty (drags); sync edits are discrete. */
export const DISPLAY_SAVE_DEBOUNCE_MS = 800;
export const SYNC_SAVE_DEBOUNCE_MS = 400;
export const STAGE_SAVE_DEBOUNCE_MS = 300;

const STAGE_ORDER: ProjectStage[] = ["import", "sync", "customize", "preview", "export"];

interface ProjectState {
  projectId: string | null;
  status: ProjectLoadStatus;
  /** true while `load` or `refresh` is fetching */
  loading: boolean;
  notFound: boolean;
  /** load failure (the page shows a retry) */
  error: string | null;
  /** last autosave failure, cleared on the next successful save */
  saveError: string | null;
  summary: ProjectSummary | null;
  infoMap: InfoMap | null;
  display: DisplaySettings | null;
  sync: SyncState | null;
  /** 0–1 waveform bars: the recording's peaks, or a score-derived envelope */
  peaks: number[] | null;
  /** presigned GET URL of the recording (10 min cache), null when none */
  audioUrl: string | null;
  /** unsaved display or sync edits exist */
  dirty: boolean;
  savedAt: string | null;
  load: (id: string) => Promise<void>;
  /** re-fetch summary/sync/display without dropping the info map */
  refresh: () => Promise<void>;
  /** advance the stored stage (PATCH, debounced; never moves backwards) */
  setStage: (stage: ProjectStage) => void;
  /** flush pending autosaves now */
  saveNow: () => Promise<void>;
  // display
  setVisible: (id: string, visible: boolean) => void;
  setSectionVisible: (section: Section, visible: boolean) => void;
  soloPart: (id: string) => void;
  setPartColor: (id: string, color: string | null, opts?: EditOptions) => void;
  setSectionColor: (section: Section, color: string, opts?: EditOptions) => void;
  setPartSection: (id: string, section: Section) => void;
  setPosition: (id: string, pos: PartPosition, opts?: EditOptions) => void;
  resetPositions: () => void;
  resetColors: () => void;
  setShowLabels: (v: boolean) => void;
  setLabelMode: (m: DisplaySettings["labelMode"]) => void;
  setReducedMotion: (v: boolean) => void;
  setGlowScale: (v: number, opts?: EditOptions) => void;
  /** put one part back on its default seat and drop its color override */
  resetPart: (id: string) => void;
  // display history (undo/redo of display edits only)
  canUndo: boolean;
  canRedo: boolean;
  undo: () => void;
  redo: () => void;
  /** group the edits until `endGesture` into one undo step (a drag) */
  beginGesture: () => void;
  endGesture: () => void;
  // project metadata
  rename: (title: string) => Promise<void>;
  // sync (ADR 0018: edits change `manual` only; timing reads `applied` until a recompute)
  /** the recording's length, for marker bounds (seconds; Infinity when unknown) */
  recordingSec: number;
  setRecordingSec: (sec: number) => void;
  /** pin a note (measure + position in it, 0 = downbeat) to a recording time; on a marked note, moves that marker */
  addMarker: (measure: number, startSec: number, position?: number, label?: string) => MarkerEditResult;
  nudgeMarker: (measure: number, deltaSec: number, position?: number) => MarkerEditResult;
  removeMarker: (measure: number, position?: number) => ManualMarker | null;
  updateMarker: (id: string, patch: Partial<Pick<ManualMarker, "measure" | "position" | "startSec" | "label">>) => MarkerEditResult;
  removeMarkerById: (id: string) => ManualMarker | null;
  /** put a removed or changed marker back exactly (Undo) */
  restoreMarker: (m: ManualMarker) => MarkerEditResult;
  /** drop a pending change: the applied version comes back (or the marker leaves, when it was never applied) */
  revertMarker: (id: string) => void;
  /** the whole manual list back (Undo of any marker command) */
  restoreManual: (manual: ManualMarker[]) => void;
  /** a run's result from the server (auto, applied); local manual edits are kept */
  replaceAuto: (sync: SyncState) => void;
  // persistence
  /** alias of saveNow (the toolbar's Save button) */
  markSaved: () => void;
}

/* ------------------------------------------------------------------ */
/* Autosave plumbing (module scope: one project is open at a time)     */
/* ------------------------------------------------------------------ */

type SaveKind = "display" | "sync" | "stage";

const timers: Record<SaveKind, ReturnType<typeof setTimeout> | null> = { display: null, sync: null, stage: null };
const pendingKinds = new Set<SaveKind>();
const inflight = new Set<Promise<void>>();
/** kinds with a save request on the wire right now */
const inflightKinds = new Map<SaveKind, number>();
/** bumps on every local edit; a save only clears `dirty` if nothing changed since it started */
let editVersion = 0;
/** bumps on every load so stale responses are ignored */
let loadSeq = 0;
/** info_map_key of the info map in the store; a new key on refresh means the score was replaced */
let loadedInfoMapKey: string | null = null;

/** Display history. Snapshots are cheap: every edit replaces `display` with a new object. */
export const HISTORY_LIMIT = 100;
let past: DisplaySettings[] = [];
let future: DisplaySettings[] = [];
/** inside a gesture, only the first edit records a snapshot */
let gesture: { recorded: boolean } | null = null;
/** Edits with the same merge key closer together than this share one undo step. */
export const MERGE_WINDOW_MS = 1000;
/** the merge key and time of the last display edit */
let lastMerge: { key: string; at: number } | null = null;

function clearHistory() {
  past = [];
  future = [];
  gesture = null;
  lastMerge = null;
}

function clearTimers() {
  for (const kind of Object.keys(timers) as SaveKind[]) {
    if (timers[kind]) clearTimeout(timers[kind]!);
    timers[kind] = null;
  }
  pendingKinds.clear();
}

export function hasPendingSave(kind?: SaveKind): boolean {
  return kind ? pendingKinds.has(kind) : pendingKinds.size > 0;
}

function summaryOf(project: ProjectDto): ProjectSummary {
  const { scoreKey, audioFileId, audioKey, infoMapKey, audioPeaks, parseJobId, sync, display, ...summary } = project;
  void scoreKey;
  void audioFileId;
  void audioKey;
  void infoMapKey;
  void audioPeaks;
  void parseJobId;
  void sync;
  void display;
  return summary;
}

export const useProject = create<ProjectState>((set, get) => {
  /** Runs one save kind now (used by the debounce timer and by saveNow). */
  const flush = (kind: SaveKind): Promise<void> => {
    if (timers[kind]) {
      clearTimeout(timers[kind]!);
      timers[kind] = null;
    }
    if (!pendingKinds.has(kind)) return Promise.resolve();
    pendingKinds.delete(kind);
    const { projectId, display, sync, summary } = get();
    if (!projectId) return Promise.resolve();
    const version = editVersion;
    let p: Promise<ProjectDto | null>;
    if (kind === "display") {
      if (!display) return Promise.resolve();
      p = api.saveDisplay(projectId, display);
    } else if (kind === "sync") {
      if (!sync) return Promise.resolve();
      p = api.saveSync(projectId, sync);
    } else {
      if (!summary) return Promise.resolve();
      p = api.updateProject(projectId, { stage: summary.stage });
    }
    inflightKinds.set(kind, (inflightKinds.get(kind) ?? 0) + 1);
    const run = p
      .then((project) => {
        if (get().projectId !== projectId) return;
        const patch: Partial<ProjectState> = { saveError: null };
        if (project) {
          patch.savedAt = project.updatedAt;
          // keep the server's derived status/stage without touching local edits
          const current = get().summary;
          if (current) patch.summary = { ...current, status: project.status, statusDetail: project.statusDetail, updatedAt: project.updatedAt, averageConfidence: project.averageConfidence ?? current.averageConfidence, exports: project.exports };
        } else {
          patch.savedAt = new Date().toISOString();
        }
        if (kind !== "stage" && version === editVersion && pendingKinds.size === 0) patch.dirty = false;
        set(patch);
      })
      .catch((err: unknown) => {
        if (get().projectId !== projectId) return;
        set({ saveError: errorMessage(err, "Could not save") });
      })
      .finally(() => {
        inflight.delete(run);
        const n = (inflightKinds.get(kind) ?? 1) - 1;
        if (n <= 0) inflightKinds.delete(kind);
        else inflightKinds.set(kind, n);
      });
    inflight.add(run);
    return run;
  };

  const schedule = (kind: SaveKind, ms: number) => {
    pendingKinds.add(kind);
    if (timers[kind]) clearTimeout(timers[kind]!);
    timers[kind] = setTimeout(() => {
      timers[kind] = null;
      void flush(kind);
    }, ms);
  };

  const editDisplay = (fn: (s: ProjectState) => DisplaySettings | null, opts?: EditOptions) => {
    set((s) => {
      const display = fn(s);
      if (!display) return s;
      editVersion++;
      const now = Date.now();
      const merged = Boolean(opts?.merge && lastMerge && lastMerge.key === opts.merge && now - lastMerge.at < MERGE_WINDOW_MS);
      lastMerge = opts?.merge ? { key: opts.merge, at: now } : null;
      if (s.display && !merged && (!gesture || !gesture.recorded)) {
        past.push(s.display);
        if (past.length > HISTORY_LIMIT) past.shift();
        if (gesture) gesture.recorded = true;
      }
      future = [];
      return { display, dirty: true, canUndo: past.length > 0, canRedo: false };
    });
    if (pendingKinds.has("display") || get().dirty) schedule("display", DISPLAY_SAVE_DEBOUNCE_MS);
  };

  /** Swap `display` for a snapshot from history and autosave it like any edit. */
  const restoreDisplay = (from: DisplaySettings[], to: DisplaySettings[]) => {
    const current = get().display;
    const next = from.pop();
    if (!current || !next) return;
    to.push(current);
    gesture = null;
    lastMerge = null;
    editVersion++;
    set({ display: next, dirty: true, canUndo: past.length > 0, canRedo: future.length > 0 });
    schedule("display", DISPLAY_SAVE_DEBOUNCE_MS);
  };

  const editSync = (fn: (s: ProjectState) => SyncState | null) => {
    set((s) => {
      const sync = fn(s);
      if (!sync) return s;
      editVersion++;
      return { sync, dirty: true };
    });
    if (get().dirty) schedule("sync", SYNC_SAVE_DEBOUNCE_MS);
  };

  const noSync: MarkerEditResult = { ok: false, reason: "no-sync", message: "The alignment is not loaded yet." };
  const canon = (s: ProjectState, measure: number, position: number) => (position > 0 && s.infoMap ? canonicalPosition(s.infoMap, measure, position) : Math.max(0, position));
  /** a new manual list; `applied` keeps its reference (legacy states get it pinned first) */
  const withManual = (sync: SyncState, manual: ManualMarker[]): SyncState => ({ ...sync, applied: appliedOf(sync), manual });
  /** where a note lands now (audible timing), for a nudge that starts a marker */
  const landingOf = (sync: SyncState, measure: number, position: number): number => {
    const i = sync.auto.findIndex((a) => a.n === measure);
    const a = sync.auto[i];
    if (!a) return 0;
    const next = sync.auto[i + 1];
    return a.startSec + (next ? position * (next.startSec - a.startSec) : 0);
  };
  /**
   * Put `marker` into `sync.manual` (which the builder returns without it),
   * after checking it is free and in order (markerBounds against the edited set).
   */
  const commit = (
    build: (sync: SyncState) => { sync: SyncState; marker: ManualMarker } | { error: Extract<MarkerEditResult, { ok: false }> },
  ): MarkerEditResult => {
    const s = get();
    if (!s.sync) return noSync;
    const built = build(s.sync);
    if ("error" in built) return built.error;
    const { sync, marker } = built;
    const pos = markerPosition(marker);
    if (sync.manual.some((m) => sameMarkerSpot(m, marker.measure, pos))) {
      return { ok: false, reason: "occupied", message: "That note already has a marker." };
    }
    const { low, high } = markerBounds(sync.auto, sync.manual, { measure: marker.measure, position: pos }, { durationSec: s.recordingSec });
    if (marker.startSec < low - 1e-9 || marker.startSec > high + 1e-9) {
      const message = high < low ? "There is no room for a marker here between its neighbours." : `Must be between ${fmtSec(low)} and ${fmtSec(high)}.`;
      return { ok: false, reason: "out-of-order", message };
    }
    editSync((st) => (st.sync ? withManual(st.sync, sortMarkers([...sync.manual, marker])) : null));
    return { ok: true, id: marker.id };
  };

  const saveNow = async () => {
    await Promise.all([flush("display"), flush("sync"), flush("stage")]);
    await Promise.all([...inflight]);
  };

  return {
    projectId: null,
    status: "idle",
    loading: false,
    notFound: false,
    error: null,
    saveError: null,
    summary: null,
    infoMap: null,
    display: null,
    sync: null,
    peaks: null,
    audioUrl: null,
    dirty: false,
    savedAt: null,
    canUndo: false,
    canRedo: false,

    load: async (id) => {
      const s = get();
      if (s.projectId === id && (s.status === "ready" || s.status === "loading")) return;
      // Flush the previous project's edits before switching.
      if (s.projectId && s.projectId !== id && (pendingKinds.size > 0 || inflight.size > 0)) await saveNow();
      clearTimers();
      clearHistory();
      loadedInfoMapKey = null;
      const seq = ++loadSeq;
      const fresh = (): boolean => seq === loadSeq && get().projectId === id;
      set({
        projectId: id,
        status: "loading",
        loading: true,
        notFound: false,
        error: null,
        saveError: null,
        summary: null,
        infoMap: null,
        display: null,
        sync: null,
        peaks: null,
        audioUrl: null,
        dirty: false,
        savedAt: null,
        canUndo: false,
        canRedo: false,
      });
      try {
        const project = await api.getProject(id);
        if (!fresh()) return;
        if (!project) {
          set({ status: "not-found", loading: false, notFound: true });
          return;
        }
        let infoMap: InfoMap | null = null;
        if (project.infoMapKey) {
          infoMap = await api.fetchInfoMap(id);
          if (!fresh()) return;
          loadedInfoMapKey = project.infoMapKey;
        }
        let audioUrl: string | null = null;
        if (project.hasRecording) {
          audioUrl = (await api.getProjectUrls(id).catch(() => ({ audio: null }))).audio;
          if (!fresh()) return;
        }
        let display = project.display;
        let savedAt = project.updatedAt;
        if (!display && infoMap) {
          display = defaultDisplay(infoMap);
          const saved = await api.saveDisplay(id, display).catch(() => null);
          if (!fresh()) return;
          if (saved) savedAt = saved.updatedAt;
        }
        const sync = project.sync && infoMap ? normalizeMarkers(project.sync, infoMap) : project.sync;
        set({
          status: "ready",
          loading: false,
          summary: summaryOf(project),
          infoMap,
          display,
          sync,
          peaks: project.audioPeaks ?? (infoMap ? peaksFromInfoMap(infoMap) : null),
          audioUrl,
          dirty: false,
          savedAt,
        });
        // a legacy row was brought to the current marker form: store it
        if (sync && sync !== project.sync) {
          set({ dirty: true });
          schedule("sync", SYNC_SAVE_DEBOUNCE_MS);
        }
      } catch (err) {
        if (!fresh()) return;
        set({ status: "error", loading: false, error: errorMessage(err, "The project could not be loaded") });
      }
    },

    refresh: async () => {
      const id = get().projectId;
      if (!id) return;
      const seq = loadSeq;
      // Local edits made while this refresh is in flight must win over the
      // server copy, otherwise the next edit builds on stale state.
      const versionAtStart = editVersion;
      set({ loading: true });
      try {
        const project = await api.getProject(id);
        if (seq !== loadSeq || get().projectId !== id) return;
        if (!project) {
          set({ status: "not-found", loading: false, notFound: true });
          return;
        }
        const s = get();
        const patch: Partial<ProjectState> = { loading: false, summary: summaryOf(project), error: null };
        if (project.infoMapKey && (!s.infoMap || project.infoMapKey !== loadedInfoMapKey)) {
          patch.infoMap = await api.fetchInfoMap(id);
          if (seq !== loadSeq || get().projectId !== id) return;
          loadedInfoMapKey = project.infoMapKey;
        }
        const infoMap = patch.infoMap ?? s.infoMap;
        const editedMeanwhile = editVersion !== versionAtStart;
        const keepLocal = (kind: SaveKind) => editedMeanwhile || pendingKinds.has(kind) || inflightKinds.has(kind);
        if (!keepLocal("sync")) patch.sync = project.sync && infoMap ? normalizeMarkers(project.sync, infoMap) : project.sync;
        if (!keepLocal("display")) {
          const server = project.display ?? s.display ?? (infoMap ? defaultDisplay(infoMap) : null);
          // keep the local object when nothing changed, so selectors don't re-render
          patch.display = server && s.display && jsonEqual(server, s.display) ? s.display : server;
          // the snapshots were taken against the local copy; keep them while the
          // server returns the same values (compared by value, not identity)
          if (!jsonEqual(patch.display, s.display)) {
            clearHistory();
            patch.canUndo = false;
            patch.canRedo = false;
          }
        }
        patch.peaks = project.audioPeaks ?? (infoMap ? peaksFromInfoMap(infoMap) : null);
        if (project.hasRecording) {
          patch.audioUrl = (await api.getProjectUrls(id).catch(() => ({ audio: null }))).audio;
          if (seq !== loadSeq || get().projectId !== id) return;
        } else {
          patch.audioUrl = null;
        }
        if (s.status !== "ready") patch.status = "ready";
        set(patch);
      } catch (err) {
        if (seq !== loadSeq || get().projectId !== id) return;
        set({ loading: false, error: errorMessage(err, "The project could not be refreshed") });
      }
    },

    setStage: (stage) => {
      const summary = get().summary;
      if (!summary) return;
      if (STAGE_ORDER.indexOf(stage) <= STAGE_ORDER.indexOf(summary.stage)) return;
      set({ summary: { ...summary, stage } });
      schedule("stage", STAGE_SAVE_DEBOUNCE_MS);
    },

    saveNow,
    markSaved: () => {
      void saveNow();
    },

    setVisible: (id, visible) =>
      editDisplay((s) => {
        if (!s.display) return null;
        const setV = new Set(s.display.visibleParts);
        if (visible) setV.add(id);
        else setV.delete(id);
        return { ...s.display, visibleParts: [...setV] };
      }),

    setSectionVisible: (section, visible) =>
      editDisplay((s) => {
        if (!s.display || !s.infoMap) return null;
        const setV = new Set(s.display.visibleParts);
        for (const inst of s.infoMap.instruments) {
          const sec = s.display.sections[inst.id] ?? inst.section;
          if (sec !== section) continue;
          if (visible) setV.add(inst.id);
          else setV.delete(inst.id);
        }
        return { ...s.display, visibleParts: [...setV] };
      }),

    soloPart: (id) =>
      editDisplay((s) => {
        if (!s.display || !s.infoMap) return null;
        const only = s.display.visibleParts.length === 1 && s.display.visibleParts[0] === id;
        return { ...s.display, visibleParts: only ? s.infoMap.instruments.map((i) => i.id) : [id] };
      }),

    setPartColor: (id, color, opts) =>
      editDisplay((s) => {
        if (!s.display) return null;
        const colors = { ...s.display.colors };
        if (color) colors[id] = color;
        else delete colors[id];
        return { ...s.display, colors };
      }, opts),

    setSectionColor: (section, color, opts) =>
      editDisplay((s) => (s.display ? { ...s.display, sectionColors: { ...s.display.sectionColors, [section]: color } } : null), opts),

    setPartSection: (id, section) => editDisplay((s) => (s.display ? { ...s.display, sections: { ...s.display.sections, [id]: section } } : null)),

    setPosition: (id, pos, opts) => editDisplay((s) => (s.display ? { ...s.display, positions: { ...s.display.positions, [id]: pos } } : null), opts),

    resetPositions: () =>
      editDisplay((s) => (s.display && s.infoMap ? { ...s.display, positions: defaultPositions(s.infoMap.instruments, s.display.sections) } : null)),

    resetColors: () => editDisplay((s) => (s.display ? { ...s.display, colors: {}, sectionColors: { ...DEFAULT_SECTION_COLORS } } : null)),

    setShowLabels: (showLabels) => editDisplay((s) => (s.display ? { ...s.display, showLabels } : null)),
    setLabelMode: (labelMode) => editDisplay((s) => (s.display ? { ...s.display, labelMode } : null)),
    setReducedMotion: (reducedMotion) => editDisplay((s) => (s.display ? { ...s.display, reducedMotion } : null)),
    setGlowScale: (glowScale, opts) => editDisplay((s) => (s.display ? { ...s.display, glowScale } : null), opts),

    resetPart: (id) =>
      editDisplay((s) => {
        if (!s.display || !s.infoMap) return null;
        const seat = defaultPositions(s.infoMap.instruments, s.display.sections)[id];
        const colors = { ...s.display.colors };
        delete colors[id];
        return { ...s.display, colors, positions: seat ? { ...s.display.positions, [id]: seat } : s.display.positions };
      }),

    undo: () => restoreDisplay(past, future),
    redo: () => restoreDisplay(future, past),
    beginGesture: () => {
      gesture = { recorded: false };
      lastMerge = null;
    },
    endGesture: () => {
      gesture = null;
    },

    rename: async (title) => {
      const { projectId, summary } = get();
      const next = title.trim();
      if (!projectId || !summary || !next || next === summary.title) return;
      set({ summary: { ...summary, title: next } });
      try {
        const project = await api.updateProject(projectId, { title: next });
        if (get().projectId !== projectId) return;
        if (project) set({ savedAt: project.updatedAt });
      } catch (err) {
        if (get().projectId !== projectId) return;
        const current = get().summary;
        if (current) set({ summary: { ...current, title: summary.title } });
        throw new Error(errorMessage(err, "Could not rename the project"));
      }
    },

    recordingSec: Infinity,
    setRecordingSec: (recordingSec) => set({ recordingSec: Number.isFinite(recordingSec) && recordingSec > 0 ? recordingSec : Infinity }),

    addMarker: (measure, startSec, position = 0, label) => {
      const s = get();
      const existing = s.sync?.manual.find((m) => sameMarkerSpot(m, measure, canon(s, measure, position)));
      if (existing) return get().updateMarker(existing.id, label === undefined ? { startSec } : { startSec, label });
      return commit((sync) => {
        const pos = canon(get(), measure, position);
        const marker = newMarker(measure, pos, Math.max(0, startSec));
        const l = normalizeMarkerLabel(label);
        if (l) marker.label = l;
        return { sync, marker };
      });
    },

    nudgeMarker: (measure, deltaSec, position = 0) => {
      const s = get();
      if (!s.sync) return noSync;
      const pos = canon(s, measure, position);
      const existing = s.sync.manual.find((m) => sameMarkerSpot(m, measure, pos));
      if (existing) return get().updateMarker(existing.id, { startSec: Math.max(0, existing.startSec + deltaSec) });
      return get().addMarker(measure, Math.max(0, landingOf(s.sync, measure, pos) + deltaSec), pos);
    },

    removeMarker: (measure, position = 0) => {
      const s = get();
      const m = s.sync?.manual.find((x) => sameMarkerSpot(x, measure, canon(s, measure, position)));
      return m ? get().removeMarkerById(m.id) : null;
    },

    updateMarker: (id, patch) =>
      commit((sync) => {
        const cur = sync.manual.find((m) => m.id === id);
        if (!cur) return { error: { ok: false, reason: "not-found", message: "That marker no longer exists." } as const };
        const next: ManualMarker = { ...cur, basis: "time" };
        if (patch.measure !== undefined) next.measure = patch.measure;
        if (patch.position !== undefined || patch.measure !== undefined) {
          const pos = canon(get(), next.measure, patch.position ?? markerPosition(cur));
          if (pos > 0) next.position = pos;
          else delete next.position;
        }
        if (patch.startSec !== undefined) next.startSec = Math.max(0, patch.startSec);
        if ("label" in patch) {
          const l = normalizeMarkerLabel(patch.label);
          if (l) next.label = l;
          else delete next.label;
        }
        return { sync: { ...sync, manual: sync.manual.filter((m) => m.id !== id) }, marker: next };
      }),

    removeMarkerById: (id) => {
      const sync = get().sync;
      const m = sync?.manual.find((x) => x.id === id) ?? null;
      if (!m) return null;
      editSync((s) => (s.sync ? withManual(s.sync, s.sync.manual.filter((x) => x.id !== id)) : null));
      return m;
    },

    restoreMarker: (m) => commit((sync) => ({ sync: { ...sync, manual: sync.manual.filter((x) => x.id !== m.id) }, marker: { ...m } })),

    revertMarker: (id) =>
      editSync((s) => {
        if (!s.sync) return null;
        const applied = appliedOf(s.sync).find((m) => m.id === id);
        const rest = s.sync.manual.filter((m) => m.id !== id);
        return withManual(s.sync, applied ? sortMarkers([...rest, { ...applied }]) : rest);
      }),

    restoreManual: (manual) => editSync((s) => (s.sync ? withManual(s.sync, sortMarkers(manual.map((m) => ({ ...m })))) : null)),

    replaceAuto: (sync) =>
      editSync((s) => {
        const infoMap = s.infoMap;
        const next = infoMap ? normalizeMarkers(sync, infoMap) : sync;
        return { ...next, manual: s.sync?.manual ?? next.manual };
      }),
  };
});

/**
 * Edits waiting on the autosave delay would be lost on tab close or reload.
 * On pagehide, send them with keepalive so the request outlives the page.
 */
if (typeof window !== "undefined") {
  window.addEventListener("pagehide", () => {
    const { projectId, display, sync } = useProject.getState();
    if (!projectId) return;
    if (pendingKinds.has("display") && display) void api.saveDisplay(projectId, display, { keepalive: true }).catch(() => {});
    if (pendingKinds.has("sync") && sync) void api.saveSync(projectId, sync, { keepalive: true }).catch(() => {});
    pendingKinds.delete("display");
    pendingKinds.delete("sync");
  });
}
