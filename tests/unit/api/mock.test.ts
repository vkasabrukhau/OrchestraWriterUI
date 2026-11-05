import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { ApiClient } from "@/lib/api/types";
import { mockApi, mockTiming } from "@/lib/api/mock";
import { subscribeJob } from "@/lib/jobs/registry";
import type { Job } from "@/shared/jobs";

/** Compile-time exhaustiveness: adding a method to ApiClient without listing it here fails tsc. */
const METHODS: Record<keyof ApiClient, true> = {
  getProfile: true,
  updateProfile: true,
  deleteAccount: true,
  getUsage: true,
  listProjects: true,
  getProject: true,
  createProject: true,
  updateProject: true,
  deleteProject: true,
  uploadScore: true,
  uploadAudio: true,
  removeAudio: true,
  transcribeScore: true,
  getProjectUrls: true,
  fetchInfoMap: true,
  saveSync: true,
  saveDisplay: true,
  startAlignment: true,
  exportMp4: true,
  exportProjectFile: true,
  openProjectFile: true,
  listExports: true,
  getExportDownloadUrl: true,
  listPrograms: true,
  getProgram: true,
  createProgram: true,
  updateProgram: true,
  deleteProgram: true,
  listActivity: true,
  getJob: true,
  subscribeJob: true,
};

function waitForJob<T>(id: string): Promise<Job<T>> {
  return new Promise((resolve) => {
    const off = subscribeJob<T>(id, (job) => {
      if (job.status === "succeeded" || job.status === "failed") {
        off();
        resolve(job);
      }
    });
  });
}

beforeAll(() => {
  mockTiming.scale = 0;
});
afterAll(() => {
  mockTiming.scale = 1;
});

describe("mockApi", () => {
  it("implements every ApiClient method", () => {
    for (const key of Object.keys(METHODS) as Array<keyof ApiClient>) {
      expect(typeof mockApi[key], key).toBe("function");
    }
  });

  it("serves the demo projects with server-style derived fields", async () => {
    const list = await mockApi.listProjects();
    expect(list.map((p) => p.id)).toContain("beethoven-5");
    const beethoven = await mockApi.getProject("beethoven-5");
    expect(beethoven?.display).toBeNull();
    expect(beethoven?.sync?.auto.length).toBe(502);
    expect(beethoven?.audioPeaks?.length).toBe(420);
    expect(beethoven?.infoMapKey).toBeTruthy();
    const dvorak = await mockApi.getProject("dvorak-9");
    expect(dvorak?.status).toBe("needs-sync");
    expect(dvorak?.sync).toBeNull();
    const mahler = await mockApi.getProject("mahler-2");
    expect(mahler?.infoMapKey).toBeNull();
    expect(await mockApi.getProject("nope")).toBeNull();
    const infoMap = await mockApi.fetchInfoMap("beethoven-5");
    expect(infoMap.instruments.length).toBe(22);
  });

  it("walks a new project through upload, alignment and export in memory", async () => {
    const created = await mockApi.createProject({ title: "Fresh" });
    expect(created.infoMapKey).toBeNull();

    const upload = await mockApi.uploadScore(created.id, new File(["x"], "Beethoven_5.musicxml"));
    expect(upload.status).toBe("queued");
    const parsed = await waitForJob<{ parts: number }>(upload.id);
    expect(parsed.status).toBe("succeeded");
    expect(parsed.result?.parts).toBe(22);
    const after = await mockApi.getProject(created.id);
    expect(after?.infoMapKey).toBeTruthy();
    expect(after?.title).toBe("Symphony No. 5");
    expect((await mockApi.fetchInfoMap(created.id)).measures.length).toBe(502);

    const audio = await waitForJob<{ peaks: number[] }>((await mockApi.uploadAudio(created.id, new File(["x"], "take.mp3"))).id);
    expect(audio.result?.peaks.length).toBe(420);
    expect((await mockApi.getProject(created.id))?.status).toBe("needs-sync");

    const align = await waitForJob<{ measures: number }>((await mockApi.startAlignment(created.id)).id);
    expect(align.result?.measures).toBe(502);
    const synced = await mockApi.getProject(created.id);
    expect(synced?.sync?.auto.length).toBe(502);
    expect(synced?.status).toBe("ready");

    const saved = await mockApi.saveDisplay(created.id, { ...(synced!.display ?? {}), visibleParts: ["P1"], positions: {}, colors: {}, sectionColors: { Strings: "#fff", Woodwinds: "#fff", Brass: "#fff", Percussion: "#fff", Other: "#fff" }, sections: {}, showLabels: true, labelMode: "parts", reducedMotion: false, glowScale: 1 });
    expect(saved.display?.visibleParts).toEqual(["P1"]);

    const mp4 = await waitForJob<{ filename: string; exportId?: string }>((await mockApi.exportMp4({ projectId: created.id, filename: "sym", resolution: "1080p", frameRate: 60, audio: "uploaded" })).id);
    expect(mp4.result?.filename).toBe("sym.mp4");
    const history = await mockApi.listExports(created.id);
    expect(history[0].id).toBe(mp4.result?.exportId);
    expect((await mockApi.getProject(created.id))?.status).toBe("exported");

    const opened = await waitForJob<{ projectId: string }>((await mockApi.openProjectFile(new File(["x"], "saved.ovproj"))).id);
    expect(opened.result?.projectId).toBe("beethoven-5");

    const failed = await waitForJob((await mockApi.uploadScore(created.id, new File(["x"], "Mahler_2.musicxml"))).id);
    expect(failed.status).toBe("failed");
  });

  it("keeps programs, activity and profile in memory", async () => {
    const programs = await mockApi.listPrograms();
    expect(programs.length).toBeGreaterThan(0);
    const program = await mockApi.createProgram({ name: "Spring" });
    const updated = await mockApi.updateProgram(program.id, { projectIds: ["beethoven-5"], notes: "n" });
    expect(updated.projectIds).toEqual(["beethoven-5"]);
    expect((await mockApi.getProgram(program.id))?.projects[0].id).toBe("beethoven-5");
    expect((await mockApi.getProject("beethoven-5"))?.programIds).toContain(program.id);
    await mockApi.deleteProgram(program.id);
    expect(await mockApi.getProgram(program.id)).toBeNull();

    const profile = await mockApi.updateProfile({ name: "Ada Lovelace", preferences: { theme: "stage" } });
    expect(profile.initials).toBe("AL");
    expect(profile.preferences.theme).toBe("stage");
    expect((await mockApi.getProfile())?.name).toBe("Ada Lovelace");
    expect((await mockApi.listActivity()).length).toBeGreaterThan(0);
    expect((await mockApi.getUsage()).totalBytes).toBeGreaterThan(0);
  });
});
