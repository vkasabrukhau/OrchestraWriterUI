"use client";

import { create } from "zustand";
import type { InfoMap } from "@/shared/info-map";
import type { DisplaySettings, PartPosition } from "@/shared/project-file";
import { DEFAULT_SECTION_COLORS, type Section } from "@/shared/sections";
import type { ManualMarker, SyncState } from "@/shared/sync";
import type { ProjectStage, ProjectSummary } from "@/shared/domain";
import type { ProjectDto } from "@/shared/api";
import { api, errorMessage } from "@/lib/api";
import { peaksFromInfoMap } from "@/lib/audio";
import { defaultPositions } from "@/lib/visualizer/seating";
import { defaultDisplay } from "./display-defaults";

export { defaultDisplay };

export type ProjectLoadStatus = "idle" | "loading" | "ready" | "error" | "not-found";

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
  setPartColor: (id: string, color: string | null) => void;
  setSectionColor: (section: Section, color: string) => void;
  setPartSection: (id: string, section: Section) => void;
  setPosition: (id: string, pos: PartPosition) => void;
  resetPositions: () => void;
  resetColors: () => void;
  setShowLabels: (v: boolean) => void;
  setLabelMode: (m: DisplaySettings["labelMode"]) => void;
  setReducedMotion: (v: boolean) => void;
  setGlowScale: (v: number) => void;
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
  // sync
  addMarker: (measure: number, startSec: number) => void;
  nudgeMarker: (measure: number, deltaSec: number) => void;
  removeMarker: (measure: number) => void;
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

function clearHistory() {
  past = [];
  future = [];
  gesture = null;
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

  const editDisplay = (fn: (s: ProjectState) => DisplaySettings | null) => {
    set((s) => {
      const display = fn(s);
      if (!display) return s;
      editVersion++;
      if (s.display && (!gesture || !gesture.recorded)) {
        past.push(s.display);
        if (past.length > HISTORY_LIMIT) past.shift();
        future = [];
        if (gesture) gesture.recorded = true;
      }
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
        set({
          status: "ready",
          loading: false,
          summary: summaryOf(project),
          infoMap,
          display,
          sync: project.sync,
          peaks: project.audioPeaks ?? (infoMap ? peaksFromInfoMap(infoMap) : null),
          audioUrl,
          dirty: false,
          savedAt,
        });
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
        if (!keepLocal("sync")) patch.sync = project.sync;
        if (!keepLocal("display")) {
          patch.display = project.display ?? s.display ?? (infoMap ? defaultDisplay(infoMap) : null);
          // the server copy may differ from what the snapshots were taken against
          if (patch.display !== s.display) {
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

    setPartColor: (id, color) =>
      editDisplay((s) => {
        if (!s.display) return null;
        const colors = { ...s.display.colors };
        if (color) colors[id] = color;
        else delete colors[id];
        return { ...s.display, colors };
      }),

    setSectionColor: (section, color) => editDisplay((s) => (s.display ? { ...s.display, sectionColors: { ...s.display.sectionColors, [section]: color } } : null)),

    setPartSection: (id, section) => editDisplay((s) => (s.display ? { ...s.display, sections: { ...s.display.sections, [id]: section } } : null)),

    setPosition: (id, pos) => editDisplay((s) => (s.display ? { ...s.display, positions: { ...s.display.positions, [id]: pos } } : null)),

    resetPositions: () =>
      editDisplay((s) => (s.display && s.infoMap ? { ...s.display, positions: defaultPositions(s.infoMap.instruments, s.display.sections) } : null)),

    resetColors: () => editDisplay((s) => (s.display ? { ...s.display, colors: {}, sectionColors: { ...DEFAULT_SECTION_COLORS } } : null)),

    setShowLabels: (showLabels) => editDisplay((s) => (s.display ? { ...s.display, showLabels } : null)),
    setLabelMode: (labelMode) => editDisplay((s) => (s.display ? { ...s.display, labelMode } : null)),
    setReducedMotion: (reducedMotion) => editDisplay((s) => (s.display ? { ...s.display, reducedMotion } : null)),
    setGlowScale: (glowScale) => editDisplay((s) => (s.display ? { ...s.display, glowScale } : null)),

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

    addMarker: (measure, startSec) =>
      editSync((s) => {
        if (!s.sync) return null;
        const manual = s.sync.manual.filter((m) => m.measure !== measure);
        const marker: ManualMarker = { id: `mk_${measure}_${Date.now().toString(36)}`, measure, startSec, createdAt: new Date().toISOString() };
        return { ...s.sync, manual: [...manual, marker].sort((a, b) => a.measure - b.measure) };
      }),

    nudgeMarker: (measure, deltaSec) =>
      editSync((s) => {
        if (!s.sync) return null;
        const existing = s.sync.manual.find((m) => m.measure === measure);
        const base = existing?.startSec ?? s.sync.auto.find((a) => a.n === measure)?.startSec ?? 0;
        const startSec = Math.max(0, base + deltaSec);
        const manual = s.sync.manual.filter((m) => m.measure !== measure);
        const marker: ManualMarker = {
          id: existing?.id ?? `mk_${measure}_${Date.now().toString(36)}`,
          measure,
          startSec,
          createdAt: existing?.createdAt ?? new Date().toISOString(),
        };
        return { ...s.sync, manual: [...manual, marker].sort((a, b) => a.measure - b.measure) };
      }),

    removeMarker: (measure) => editSync((s) => (s.sync ? { ...s.sync, manual: s.sync.manual.filter((m) => m.measure !== measure) } : null)),

    replaceAuto: (sync) => editSync((s) => ({ ...sync, manual: s.sync?.manual ?? [] })),
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
