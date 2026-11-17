/**
 * Shared pieces for the end-to-end suite: a throwaway account per test, API
 * shortcuts for building projects quickly, and fixture paths.
 *
 * Every test signs up its own user and deletes it on teardown
 * (DELETE /api/me cascades to projects, programs, exports and S3 objects), so
 * tests never share rows and the database is left as it was found.
 *
 * API calls go through `page.request`: it shares the browser context's cookie
 * jar, so a session made here is the page's session and vice versa. Mutating
 * requests carry an Origin header because Better Auth and the CSRF guard
 * check it (a browser adds it on its own; Node does not).
 */
import { randomInt, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { test as base, expect, type APIRequestContext, type APIResponse, type BrowserContext, type Page } from "@playwright/test";
import type { DisplaySettings } from "@/shared/project-file";
import type { ProjectDto, UploadTarget } from "@/shared/api";
import type { SyncState } from "@/shared/sync";

export { expect };

export const ORIGIN = new URL(process.env.E2E_BASE_URL ?? "http://localhost:3000").origin;

const ROOT = path.resolve(__dirname, "../..");
export const SCORE_FILE = path.join(ROOT, "fixtures/scores/orchestra-demo.musicxml");
export const AUDIO_FILE = path.join(ROOT, "fixtures/audio/orchestra-demo.mp3");
const AUDIO_META = path.join(ROOT, "fixtures/audio/orchestra-demo.json");

/** What the demo score parses to (fixtures/scores/orchestra-demo.musicxml). */
export const DEMO = {
  title: "Overture in D",
  composer: "Fixture Orchestra",
  movement: "I. Allegro",
  parts: 14,
  measures: 56,
} as const;

/** `/projects/<id>/<step>` for a real project (never the `new` placeholder); captures the id. */
export function stepUrl(step: "import" | "sync" | "customize" | "preview" | "export", notId?: string): RegExp {
  const exclude = notId ? `(?!${notId}/)` : "";
  return new RegExp(`/projects/(?!new/)${exclude}([^/?#]+)/${step}(?:[?#]|$)`);
}

export function projectIdFrom(page: Page): string {
  const m = /\/projects\/([^/]+)\//.exec(new URL(page.url()).pathname);
  if (!m || m[1] === "new") throw new Error(`not on a project page: ${page.url()}`);
  return m[1];
}

/* ------------------------------------------------------------------ */
/* Accounts                                                            */
/* ------------------------------------------------------------------ */

export interface Account {
  name: string;
  email: string;
  password: string;
}

export function newCredentials(label = "e2e"): Account {
  return {
    name: "Ada Lovelace",
    email: `${label}-${Date.now()}-${randomUUID().slice(0, 8)}@example.com`,
    password: `Pw-${randomUUID().slice(0, 12)}`,
  };
}

/**
 * In a production build (`next start`, as in CI) Better Auth rate-limits
 * sign-in and sign-up to 3 per 10 s per client IP. The whole suite comes
 * from one machine, so each test presents its own client IP on auth calls;
 * otherwise back-to-back tests would be refused with 429. Next keeps an
 * incoming x-forwarded-for, and Better Auth reads a single-address one.
 */
function randomClientIp(): string {
  return `10.${randomInt(0, 256)}.${randomInt(0, 256)}.${randomInt(1, 255)}`;
}

function authHeaders(clientIp: string): Record<string, string> {
  return { origin: ORIGIN, "x-forwarded-for": clientIp };
}

async function describeResponse(res: APIResponse): Promise<string> {
  return `${res.status()} ${res.url()} ${(await res.text()).slice(0, 300)}`;
}

/** POST to Better Auth, waiting out a 429 if the limiter still counts us. */
async function authPost(request: APIRequestContext, route: string, data: unknown, clientIp: string): Promise<APIResponse> {
  for (let attempt = 0; ; attempt++) {
    const res = await request.post(`/api/auth/${route}`, { data, headers: authHeaders(clientIp) });
    if (res.status() !== 429 || attempt >= 3) return res;
    const wait = Number(res.headers()["x-retry-after"] ?? 10);
    await new Promise((r) => setTimeout(r, (Number.isFinite(wait) ? wait : 10) * 1000 + 250));
  }
}

export async function signUpViaApi(request: APIRequestContext, account: Account, clientIp: string): Promise<void> {
  const res = await authPost(request, "sign-up/email", { name: account.name, email: account.email, password: account.password }, clientIp);
  if (!res.ok()) throw new Error(`sign-up failed: ${await describeResponse(res)}`);
}

/**
 * Deletes the account. Signs in first when the test ended signed out; an
 * account that was never created (or is already gone) is not an error.
 */
export async function deleteAccount(request: APIRequestContext, account: Account, clientIp: string): Promise<void> {
  let res = await request.delete("/api/me", { headers: { origin: ORIGIN } });
  if (res.status() === 204) return;
  if (res.status() !== 401) throw new Error(`account deletion failed: ${await describeResponse(res)}`);
  const signIn = await authPost(request, "sign-in/email", { email: account.email, password: account.password }, clientIp);
  if (signIn.status() === 401) return;
  if (!signIn.ok()) throw new Error(`sign-in before deletion failed: ${await describeResponse(signIn)}`);
  res = await request.delete("/api/me", { headers: { origin: ORIGIN } });
  if (res.status() !== 204) throw new Error(`account deletion failed: ${await describeResponse(res)}`);
}

/** Dev-server HMR messages that patch or reload the page; the handshake (connected, sync) still passes. */
const HOT_UPDATE = /^\{"type":"(turbopack-message|building|built|reloadPage|serverComponentChanges|serverOnlyChanges|staticParamsChanged|addedPage|removedPage)"/;

/**
 * Applied to every browser context the suite opens:
 * - the page's own auth calls (sign-in/up forms, get-session) present the
 *   test's client IP (see randomClientIp);
 * - against `npm run dev`, hot updates are not delivered. A file saved during
 *   a run (an editor, another agent) otherwise makes Next reload the page
 *   mid-test, and a busy dev server can answer every page load with
 *   "restart", reloading forever. Tests drive the page they loaded; the next
 *   goto/reload picks up new code. The socket itself must stay connected:
 *   the dev client does not hydrate without its handshake. `next start` (CI)
 *   has no such socket, so this is a no-op there.
 */
export async function prepareContext(context: BrowserContext, clientIp: string): Promise<void> {
  await context.routeWebSocket(/\/_next\/(webpack-)?hmr/, (page) => {
    const server = page.connectToServer();
    server.onMessage((message) => {
      if (typeof message === "string" && HOT_UPDATE.test(message)) return;
      page.send(message);
    });
  });
  await context.route("**/api/auth/**", async (route) => {
    await route.continue({ headers: { ...(await route.request().allHeaders()), "x-forwarded-for": clientIp } });
  });
}

interface Fixtures {
  /** the client IP this test presents on auth calls (see randomClientIp) */
  clientIp: string;
  /** a fresh account, already signed in in this page's context; deleted afterwards */
  account: Account;
  /** unused credentials for a test that signs up through the UI; deleted afterwards if created */
  credentials: Account;
}

// fixture callbacks name the hand-off `provide`, not `use`: the React hooks lint rule would flag `use(...)`
export const test = base.extend<Fixtures>({
  clientIp: [
    async ({ context }, provide) => {
      const ip = randomClientIp();
      await prepareContext(context, ip);
      await provide(ip);
    },
    { auto: true },
  ],

  account: async ({ page, clientIp }, provide) => {
    const account = newCredentials();
    await signUpViaApi(page.request, account, clientIp);
    await provide(account);
    await deleteAccount(page.request, account, clientIp);
  },

  credentials: async ({ page, clientIp }, provide) => {
    const account = newCredentials("ui");
    await provide(account);
    await deleteAccount(page.request, account, clientIp);
  },
});

/* ------------------------------------------------------------------ */
/* API shortcuts (setup only; the behavior under test goes through UI)  */
/* ------------------------------------------------------------------ */

async function json<T>(res: APIResponse): Promise<T> {
  if (!res.ok()) throw new Error(`request failed: ${await describeResponse(res)}`);
  return (await res.json()) as T;
}

export function api(request: APIRequestContext) {
  const headers = { origin: ORIGIN };
  const get = async <T>(url: string) => json<T>(await request.get(url));
  const send = async <T>(method: "POST" | "PUT" | "PATCH", url: string, data: unknown) => json<T>(await request.fetch(url, { method, data, headers }));

  async function upload(kind: "score" | "audio", projectId: string, file: string, contentType: string): Promise<string> {
    const target = await send<UploadTarget>("POST", "/api/uploads", { kind, filename: path.basename(file), contentType, projectId });
    const put = await request.put(target.uploadUrl, { data: readFileSync(file), headers: { "content-type": contentType } });
    if (!put.ok()) throw new Error(`S3 PUT failed: ${await describeResponse(put)}`);
    return target.key;
  }

  const self = {
    getProject: async (id: string) => (await get<{ project: ProjectDto }>(`/api/projects/${id}`)).project,
    createProject: async (title?: string) => (await send<{ project: ProjectDto }>("POST", "/api/projects", title ? { title } : {})).project,
    patchProject: async (id: string, patch: Record<string, unknown>) => (await send<{ project: ProjectDto }>("PATCH", `/api/projects/${id}`, patch)).project,
    putSync: async (id: string, sync: SyncState) => (await send<{ project: ProjectDto }>("PUT", `/api/projects/${id}/sync`, sync)).project,
    putDisplay: async (id: string, display: DisplaySettings) => (await send<{ project: ProjectDto }>("PUT", `/api/projects/${id}/display`, display)).project,

    /** presign → PUT → register → wait for the parse job */
    async uploadScore(projectId: string): Promise<ProjectDto> {
      const filename = path.basename(SCORE_FILE);
      const key = await upload("score", projectId, SCORE_FILE, "application/vnd.recordare.musicxml+xml");
      const { job } = await send<{ job: { id: string } }>("POST", `/api/projects/${projectId}/score`, { key, filename });
      let parse: { status: string; error?: string } = { status: "queued" };
      await expect
        .poll(async () => (parse = (await get<{ job: { status: string; error?: string } }>(`/api/jobs/${job.id}`)).job).status, { timeout: 30_000, intervals: [200] })
        .toMatch(/^(succeeded|failed)$/);
      expect(parse.status, `parse job: ${parse.error ?? ""}`).toBe("succeeded");
      return self.getProject(projectId);
    },

    /** presign → PUT → register (duration from the fixture's metadata) */
    async uploadAudio(projectId: string): Promise<ProjectDto> {
      const key = await upload("audio", projectId, AUDIO_FILE, "audio/mpeg");
      const durationSec = Math.round(audioMeta().durationSec);
      return (await send<{ project: ProjectDto }>("POST", `/api/projects/${projectId}/audio`, { key, filename: path.basename(AUDIO_FILE), durationSec })).project;
    },
  };
  return self;
}

interface AudioMeta {
  durationSec: number;
  measures: Array<{ n: number; recordingStartSec: number }>;
}

let cachedMeta: AudioMeta | null = null;
function audioMeta(): AudioMeta {
  cachedMeta ??= JSON.parse(readFileSync(AUDIO_META, "utf8")) as AudioMeta;
  return cachedMeta;
}

/**
 * An alignment as the aligner would save it, built from the fixture's known
 * bar starts in the recording, plus the given manual markers.
 */
export function fixtureSync(manual: Array<{ measure: number; startSec: number }>): SyncState {
  return {
    method: "e2e-fixture",
    auto: audioMeta().measures.map((m) => ({ n: m.n, startSec: m.recordingStartSec, confidence: 92 })),
    manual: manual.map((m) => ({ id: `mk_e2e_${m.measure}`, measure: m.measure, startSec: m.startSec, createdAt: new Date().toISOString() })),
    averageConfidence: 92,
  };
}

/**
 * A parsed demo project, built through the API in about a second. Optional
 * recording, alignment with manual markers, Strings color and title.
 */
export async function buildProject(
  request: APIRequestContext,
  options: { title?: string; recording?: boolean; markers?: Array<{ measure: number; startSec: number }>; stringsColor?: string; stage?: ProjectDto["stage"] } = {},
): Promise<ProjectDto> {
  const client = api(request);
  const created = await client.createProject();
  let project = await client.uploadScore(created.id);
  if (options.recording) project = await client.uploadAudio(project.id);
  if (options.recording && options.markers) project = await client.putSync(project.id, fixtureSync(options.markers));
  if (options.stringsColor) {
    const display = project.display;
    if (!display) throw new Error("the parse job left no display settings");
    project = await client.putDisplay(project.id, { ...display, sectionColors: { ...display.sectionColors, Strings: options.stringsColor } });
  }
  const patch: Record<string, unknown> = {};
  if (options.title) patch.title = options.title;
  if (options.stage) patch.stage = options.stage;
  if (Object.keys(patch).length > 0) project = await client.patchProject(project.id, patch);
  return project;
}

/* ------------------------------------------------------------------ */
/* Page helpers                                                        */
/* ------------------------------------------------------------------ */

/**
 * Waits until React has hydrated the server-rendered page. Before that the
 * form fields and buttons are on screen but inert: a click does nothing and
 * typed text is reset by hydration (a dev build hydrates slowly enough to
 * lose the first field almost every time).
 */
export async function waitForHydration(page: Page): Promise<void> {
  await page.waitForFunction(() => {
    const controls = [...document.querySelectorAll("button, input, textarea, select")];
    const hydrated = (el: Element) => Object.keys(el).some((k) => k.startsWith("__reactFiber$"));
    return controls.length > 0 ? controls.every(hydrated) : hydrated(document.body);
  });
}

/** page.goto, then wait for hydration. */
export async function open(page: Page, url: string): Promise<void> {
  await page.goto(url);
  await waitForHydration(page);
}

/** page.reload, then wait for hydration. */
export async function reload(page: Page): Promise<void> {
  await page.reload();
  await waitForHydration(page);
}

/** "bar 12 of 56" in the Preview header → 12 (the playback bar, not the printed one). */
export async function previewBar(page: Page): Promise<number> {
  const text = await page.getByText(/^bar \d+.* of \d+$/).textContent();
  const m = /^bar (\d+)/.exec(text ?? "");
  if (!m) throw new Error(`no bar counter in "${text}"`);
  return Number(m[1]);
}

/**
 * Sets a native color input the way the picker does: the value through the
 * prototype setter (React tracks the instance one), then input and change.
 */
export async function pickColor(page: Page, label: string, hex: string, scope = page.locator("body")): Promise<void> {
  await scope.getByLabel(label).evaluate((el, value) => {
    const input = el as HTMLInputElement;
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
    input.dispatchEvent(new Event("change", { bubbles: true }));
  }, hex);
}

/**
 * Start the first sync on the Sync page. While the aligner experiment is on
 * (ADR 0026, `REDLINE_EXPERIMENT`), Sync waits for "Start sync" with the
 * default aligner (Smooth) instead of aligning by itself. When the experiment
 * is removed and auto-start returns, delete this helper and its calls.
 */
export async function startSync(page: Page): Promise<void> {
  await page.getByRole("button", { name: "Start sync" }).click();
}
