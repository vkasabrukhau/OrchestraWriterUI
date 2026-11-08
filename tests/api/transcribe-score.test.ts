// Experimental transcribe job (services/transcribe-score.ts) against a fake
// MuScriptor service: one transcription per project at a time, resuming a
// running one, the measure starts it reports becoming the project's sync, and
// rewriting the bars from the saved transcription.
import { createServer, type Server } from "node:http";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { ProjectDto } from "@/shared/api";
import type { TranscribeScoreResult, TranscriptionBars } from "@/shared/jobs";

// The server reads TRANSCRIBER_URL when it is imported, so set it first.
const FAKE_PORT = vi.hoisted(() => {
  const port = 18_733;
  process.env.TRANSCRIBER_URL = `http://127.0.0.1:${port}`;
  return port;
});

import { Client, setupDatabase, signUp, teardown, TINY_MUSICXML, upload, waitForJob } from "./helpers";

/** A one-part score with `n` whole-note measures in `beats`/4. */
function musicxml(n: number, beats = 4): string {
  const measures = Array.from({ length: n }, (_, i) =>
    `<measure number="${i + 1}">${i === 0 ? `<attributes><divisions>1</divisions><time><beats>${beats}</beats><beat-type>4</beat-type></time></attributes>` : ""}` +
    `<note><pitch><step>C</step><octave>4</octave></pitch><duration>${beats}</duration></note></measure>`,
  ).join("");
  return `<?xml version="1.0" encoding="UTF-8"?><score-partwise version="4.0"><part-list><score-part id="P1"><part-name>Violin</part-name></score-part></part-list><part id="P1">${measures}</part></score-partwise>`;
}

/** What the fake service sends as the transcription, and expects back on /rebar. */
const TRANSCRIPTION = { version: 1, title: "Take 1", names: { "40": "violin" }, notes: [[40, 0, 72, 0.4, 0.9]], grid: null };
const WARN_METER = "The time signature wasn't detected, so 4/4 was assumed.";

/** What the fake service answers; each test sets it up. */
const fake = {
  posts: 0,
  ensembles: [] as string[],
  /** GET /score/:id keeps answering "running" until this is true */
  release: false,
  measureStarts: [0.4, 2.6] as number[],
  /** bodies POSTed to /rebar */
  rebars: [] as Array<{ transcription: unknown; bars: TranscriptionBars }>,
};

let server: Server;

beforeAll(async () => {
  await setupDatabase();
  server = createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://fake");
    const send = (status: number, body: unknown) => {
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify(body));
    };
    if (req.method === "POST" && url.pathname === "/score") {
      req.resume();
      req.on("end", () => {
        fake.posts++;
        fake.ensembles.push(url.searchParams.get("ensemble") ?? "");
        send(202, { id: `job-${fake.posts}` });
      });
      return;
    }
    if (req.method === "GET" && url.pathname.startsWith("/score/")) {
      if (!fake.release) return send(200, { status: "running", progress: 0.5, message: "Transcribing (1/2 chunks)", result: null, error: null });
      return send(200, {
        status: "succeeded",
        progress: 1,
        message: "Done",
        error: null,
        result: {
          musicxml: TINY_MUSICXML,
          parts: ["Violin"],
          bpm: 120,
          beatsPerBar: 4,
          model: "muscriptor-fake",
          seconds: 1.5,
          measureStarts: fake.measureStarts,
          warnings: [WARN_METER],
          detected: { beatsPerBar: null, bpm: 120 },
          bars: { beatsPerBar: null, shiftBeats: 0, beatScale: 1 },
          transcription: TRANSCRIPTION,
        },
      });
    }
    if (req.method === "POST" && url.pathname === "/rebar") {
      let text = "";
      req.on("data", (chunk) => (text += chunk));
      req.on("end", () => {
        const body = JSON.parse(text) as { transcription: unknown; bars: TranscriptionBars };
        fake.rebars.push(body);
        const meter = body.bars.beatsPerBar ?? 4;
        send(200, {
          musicxml: musicxml(3, meter),
          parts: ["Violin"],
          bpm: 120,
          beatsPerBar: meter,
          measureStarts: [0.1, 1.6, 3.1],
          warnings: [],
          detected: { beatsPerBar: null, bpm: 120 },
          bars: { ...body.bars, shiftBeats: ((body.bars.shiftBeats % meter) + meter) % meter },
        });
      });
      return;
    }
    send(404, { detail: "Not found" });
  });
  await new Promise<void>((resolve) => server.listen(FAKE_PORT, "127.0.0.1", resolve));
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await teardown();
});

beforeEach(() => {
  fake.posts = 0;
  fake.ensembles = [];
  fake.release = false;
  fake.measureStarts = [0.4, 2.6];
  fake.rebars = [];
});

async function projectWithRecording(client: Client): Promise<ProjectDto> {
  const created = await client.post<{ project: ProjectDto }>("/api/projects", { title: "Recording only" });
  expect(created.status).toBe(201);
  const id = created.body.project.id;
  const bytes = new Uint8Array(4096).map((_, i) => i % 251);
  const key = await upload(client, { kind: "audio", filename: "Take 1.mp3", contentType: "audio/mpeg", projectId: id }, bytes);
  const reg = await client.post<{ project: ProjectDto }>(`/api/projects/${id}/audio`, { key, filename: "Take 1.mp3", durationSec: 5 });
  expect(reg.status).toBe(200);
  return reg.body.project;
}

type JobBody = { job: { id: string; kind: string; status: string } };

describe("transcribe-score", () => {
  it("runs one transcription per project, can be resumed, and saves the measure starts as the sync", async () => {
    const { client } = await signUp();
    const project = await projectWithRecording(client);

    const first = await client.post<JobBody>(`/api/projects/${project.id}/transcribe-score`, { ensemble: "strings" });
    expect(first.status).toBe(202);
    expect(first.body.job.kind).toBe("transcribe");

    // Asking again (or resuming after a reload) answers the running job.
    const again = await client.post<JobBody>(`/api/projects/${project.id}/transcribe-score`, { ensemble: "orchestra" });
    const resumed = await client.post<JobBody>(`/api/projects/${project.id}/transcribe-score`, { resume: true });
    expect(again.body.job.id).toBe(first.body.job.id);
    expect(resumed.body.job.id).toBe(first.body.job.id);

    // The project says a transcription is running, so a reloaded page knows.
    await expect.poll(() => fake.posts).toBe(1);
    const running = await client.get<{ project: ProjectDto }>(`/api/projects/${project.id}`);
    expect(running.body.project).toMatchObject({ transcribing: true, status: "importing", statusDetail: "Transcribing the recording" });

    fake.release = true;
    const done = await waitForJob(client, first.body.job.id, 25_000);
    expect(done.status, done.error).toBe("succeeded");
    expect(fake.posts).toBe(1);
    expect(fake.ensembles).toEqual(["strings"]);
    const result = done.result as TranscribeScoreResult;
    expect(result).toMatchObject({ parts: ["Violin"], model: "muscriptor-fake", synced: true });

    const after = await client.get<{ project: ProjectDto }>(`/api/projects/${project.id}`);
    expect(after.body.project.transcribing).toBeUndefined();
    expect(after.body.project).toMatchObject({ measures: 2, parts: 1, averageConfidence: 100 });
    expect(after.body.project.sync).toEqual({
      method: "transcription-beats",
      auto: [
        { n: 1, startSec: 0.4, confidence: 100 },
        { n: 2, startSec: 2.6, confidence: 100 },
      ],
      manual: [],
      averageConfidence: 100,
    });
  });

  it("resume answers 404 when nothing is running, and starts nothing", async () => {
    const { client } = await signUp();
    const project = await projectWithRecording(client);
    const res = await client.post(`/api/projects/${project.id}/transcribe-score`, { resume: true });
    expect(res.status).toBe(404);
    expect(fake.posts).toBe(0);
  });

  it("leaves the sync to the aligner when the measure counts disagree", async () => {
    const { client } = await signUp();
    const project = await projectWithRecording(client);
    fake.release = true;
    fake.measureStarts = [0.4, 2.6, 4.8]; // the score has 2 measures
    const start = await client.post<JobBody>(`/api/projects/${project.id}/transcribe-score`, {});
    const done = await waitForJob(client, start.body.job.id, 25_000);
    expect(done.status, done.error).toBe("succeeded");
    expect((done.result as TranscribeScoreResult).synced).toBe(false);
    const after = await client.get<{ project: ProjectDto }>(`/api/projects/${project.id}`);
    expect(after.body.project.sync).toBeNull();
    expect(after.body.project.measures).toBe(2);
  });
});

describe("transcription bars", () => {
  async function transcribed(client: Client): Promise<ProjectDto> {
    const project = await projectWithRecording(client);
    fake.release = true;
    const start = await client.post<JobBody>(`/api/projects/${project.id}/transcribe-score`, {});
    const done = await waitForJob(client, start.body.job.id, 25_000);
    expect(done.status, done.error).toBe("succeeded");
    return (await client.get<{ project: ProjectDto }>(`/api/projects/${project.id}`)).body.project;
  }

  it("records the transcription and rewrites the bars from it without the model", async () => {
    const { client } = await signUp();
    const project = await transcribed(client);
    expect(project.transcription).toEqual({
      model: "muscriptor-fake",
      detected: { beatsPerBar: null, bpm: 120 },
      bars: { beatsPerBar: null, shiftBeats: 0, beatScale: 1 },
      bpm: 120,
      beatsPerBar: 4,
      warnings: [WARN_METER],
    });
    expect(JSON.stringify(project.transcription)).not.toContain("key");

    const posted = await client.post<JobBody>(`/api/projects/${project.id}/transcription/bars`, { beatsPerBar: 3, shiftBeats: -1, beatScale: 1 });
    expect(posted.status).toBe(202);
    expect(posted.body.job.kind).toBe("transcribe");
    const done = await waitForJob(client, posted.body.job.id, 25_000);
    expect(done.status, done.error).toBe("succeeded");
    expect((done.result as TranscribeScoreResult).synced).toBe(true);

    // the saved transcription went back to the service, with the corrections
    expect(fake.posts).toBe(1);
    expect(fake.rebars).toEqual([{ transcription: TRANSCRIPTION, bars: { beatsPerBar: 3, shiftBeats: -1, beatScale: 1 } }]);

    const after = (await client.get<{ project: ProjectDto }>(`/api/projects/${project.id}`)).body.project;
    expect(after).toMatchObject({ measures: 3, averageConfidence: 100 });
    expect(after.transcription).toMatchObject({ bars: { beatsPerBar: 3, shiftBeats: 2, beatScale: 1 }, beatsPerBar: 3, warnings: [] });
    expect(after.sync?.auto.map((m) => m.startSec)).toEqual([0.1, 1.6, 3.1]);
  });

  it("validates corrections and refuses a score that was not transcribed", async () => {
    const { client } = await signUp();
    const project = await transcribed(client);
    for (const body of [{ beatsPerBar: 9 }, { shiftBeats: 1.5 }, { beatScale: 3 }, { shiftBeats: "1" }]) {
      expect((await client.post(`/api/projects/${project.id}/transcription/bars`, body)).status, JSON.stringify(body)).toBe(400);
    }
    expect(fake.rebars).toEqual([]);

    const plain = await projectWithRecording(client);
    const res = await client.post<{ error: string }>(`/api/projects/${plain.id}/transcription/bars`, { beatsPerBar: 3 });
    expect(res.status).toBe(400);
  });

  it("forgets the transcription when a score is uploaded or the recording changes", async () => {
    const { client } = await signUp();
    const first = await transcribed(client);
    const scoreKey = await upload(client, { kind: "score", filename: "real.musicxml", contentType: "application/vnd.recordare.musicxml+xml", projectId: first.id }, TINY_MUSICXML);
    const reg = await client.post<{ project: ProjectDto; job: { id: string } }>(`/api/projects/${first.id}/score`, { key: scoreKey, filename: "real.musicxml" });
    expect(reg.status).toBe(202);
    await waitForJob(client, reg.body.job.id);
    expect((await client.get<{ project: ProjectDto }>(`/api/projects/${first.id}`)).body.project.transcription).toBeUndefined();

    const second = await transcribed(client);
    const bytes = new Uint8Array(2048).map((_, i) => i % 13);
    const audioKey = await upload(client, { kind: "audio", filename: "Take 2.mp3", contentType: "audio/mpeg", projectId: second.id }, bytes);
    const audio = await client.post<{ project: ProjectDto }>(`/api/projects/${second.id}/audio`, { key: audioKey, filename: "Take 2.mp3", durationSec: 5 });
    expect(audio.body.project.transcription).toBeUndefined();
  });
});
