import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { ProjectDto } from "@/shared/api";
import type { ProjectSummary } from "@/shared/domain";
import { ensureSampleProject, SAMPLE_TITLE } from "@/server/services/sample-project";
import { setupDatabase, signUp, teardown } from "./helpers";

/** Every user's library starts with the Tchaikovsky 6 · Hallé sample, once (services/sample-project.ts). */

beforeAll(setupDatabase);
afterAll(teardown);

describe("sample project", () => {
  it("is created once, ready and synced, and stays deleted", async () => {
    const { client, userId } = await signUp();
    const id = Number(userId);

    // two library loads at once still make one sample
    await Promise.all([ensureSampleProject(id), ensureSampleProject(id)]);
    await ensureSampleProject(id);
    const list = (await client.get<{ projects: ProjectSummary[] }>("/api/projects")).body.projects;
    const samples = list.filter((p) => p.title === SAMPLE_TITLE);
    expect(samples).toHaveLength(1);
    const summary = samples[0];
    expect(summary.parts).toBe(17);
    expect(summary.measures).toBe(354);
    expect(summary.status).toBe("ready");
    expect(summary.hasRecording).toBe(true);
    expect(summary.stage).toBe("customize");

    const project = (await client.get<{ project: ProjectDto }>(`/api/projects/${summary.id}`)).body.project;
    expect(project.sync?.auto).toHaveLength(354);
    expect(project.sync?.manual).toEqual([]);
    expect(project.audioPeaks).toHaveLength(420);

    expect((await client.delete(`/api/projects/${summary.id}`)).status).toBe(204);
    await ensureSampleProject(id);
    const after = (await client.get<{ projects: ProjectSummary[] }>("/api/projects")).body.projects;
    expect(after.filter((p) => p.title === SAMPLE_TITLE)).toHaveLength(0);
  }, 60_000);
});
