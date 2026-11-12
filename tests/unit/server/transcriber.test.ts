// The transcription service client on AWS (services/transcriber.ts): HTTPS
// pinned to the service's self-signed certificate, and starting the stopped
// GPU instance before the first call. Certificates are made with the same
// openssl commands as scripts/ml-init.sh.
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer, type Server } from "node:https";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { connectInstance, pinnedTranscriber, type InstanceApi } from "@/server/services/transcriber";

const TOKEN = "test-token";
let dir: string;
let certA: { key: string; cert: string };
let certB: { key: string; cert: string };
let server: Server;
let port: number;
const seen: { auth?: string; bytes?: number } = {};

function makeCert(name: string): { key: string; cert: string } {
  const key = join(dir, `${name}.key`);
  const cert = join(dir, `${name}.crt`);
  execFileSync("openssl", ["ecparam", "-name", "prime256v1", "-genkey", "-noout", "-out", key]);
  execFileSync("openssl", [
    "req", "-new", "-x509", "-key", key, "-out", cert, "-days", "1", "-subj", `/CN=${name}`,
    "-addext", "basicConstraints=critical,CA:TRUE", "-addext", `subjectAltName=DNS:${name}`,
  ]);
  return { key: readFileSync(key, "utf8"), cert: readFileSync(cert, "utf8") };
}

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "transcriber-test-"));
  certA = makeCert("orchestra-writer-transcriber");
  certB = makeCert("someone-else");
  server = createServer({ key: certA.key, cert: certA.cert }, (req, res) => {
    seen.auth = req.headers.authorization;
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      seen.bytes = Buffer.concat(chunks).length;
      res.writeHead(req.url === "/missing" ? 404 : 200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true, path: req.url }));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  port = (server.address() as AddressInfo).port;
});

afterAll(() => {
  server?.close();
  rmSync(dir, { recursive: true, force: true });
});

describe("pinnedTranscriber", () => {
  it("talks to a server with the pinned certificate, whatever its name, and sends the token", async () => {
    const service = pinnedTranscriber(`https://127.0.0.1:${port}`, TOKEN, certA.cert);
    const res = await service.call("/score?x=1", { method: "POST", body: Buffer.alloc(1234, 1) });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, path: "/score?x=1" });
    expect(seen).toEqual({ auth: `Bearer ${TOKEN}`, bytes: 1234 });
  });

  it("passes error statuses through", async () => {
    const service = pinnedTranscriber(`https://127.0.0.1:${port}`, TOKEN, certA.cert);
    expect((await service.call("/missing")).status).toBe(404);
  });

  it("refuses a server with any other certificate", async () => {
    const service = pinnedTranscriber(`https://127.0.0.1:${port}`, TOKEN, certB.cert);
    await expect(service.call("/health")).rejects.toThrow();
  });
});

describe("connectInstance", () => {
  function fakeInstance(states: string[], options: { startError?: string } = {}) {
    let i = 0;
    const calls = { start: 0 };
    const api: InstanceApi = {
      async describe() {
        const state = states[Math.min(i++, states.length - 1)];
        return { state, ip: state === "running" ? "127.0.0.1" : null };
      },
      async start() {
        calls.start++;
        if (options.startError) throw Object.assign(new Error(options.startError), { name: options.startError });
      },
    };
    return { api, calls };
  }

  it("starts a stopped instance, waits for it, and returns a client for its service", async () => {
    const { api, calls } = fakeInstance(["stopped", "pending", "pending", "running"]);
    const messages: string[] = [];
    const service = await connectInstance({
      api, port, token: TOKEN, cert: certA.cert, pollMs: 5,
      onStatus: async (m) => void messages.push(m),
    });
    expect(calls.start).toBe(1);
    expect(messages).toEqual(["Starting the GPU server (about 2 minutes)"]);
    expect((await service.call("/health")).ok).toBe(true);
  });

  it("uses a running instance as it is", async () => {
    const { api, calls } = fakeInstance(["running"]);
    const messages: string[] = [];
    await connectInstance({ api, port, token: TOKEN, cert: certA.cert, pollMs: 5, onStatus: async (m) => void messages.push(m) });
    expect(calls.start).toBe(0);
    expect(messages).toEqual([]);
  });

  it("waits for a stopping instance to stop before starting it", async () => {
    const { api, calls } = fakeInstance(["stopping", "stopping", "stopped", "pending", "running"]);
    await connectInstance({ api, port, token: TOKEN, cert: certA.cert, pollMs: 5, onStatus: async () => {} });
    expect(calls.start).toBe(1);
  });

  it("says so when AWS has no GPU capacity", async () => {
    const { api } = fakeInstance(["stopped"], { startError: "InsufficientInstanceCapacity" });
    await expect(connectInstance({ api, port, token: TOKEN, cert: certA.cert, pollMs: 5, onStatus: async () => {} }))
      .rejects.toThrow(/no free GPU server/);
  });

  it("fails clearly when the instance was deleted", async () => {
    const { api } = fakeInstance(["terminated"]);
    await expect(connectInstance({ api, port, token: TOKEN, cert: certA.cert, pollMs: 5, onStatus: async () => {} }))
      .rejects.toThrow(/deleted/);
  });

  it("gives up when the service never answers", async () => {
    const { api } = fakeInstance(["running"]);
    const closed = createServer();
    await new Promise<void>((resolve) => closed.listen(0, "127.0.0.1", resolve));
    const deadPort = (closed.address() as AddressInfo).port;
    await new Promise((resolve) => closed.close(resolve));
    await expect(connectInstance({
      api, port: deadPort, token: TOKEN, cert: certA.cert, pollMs: 5, serviceTimeoutMs: 50, onStatus: async () => {},
    })).rejects.toThrow(/did not start in time/);
  });
});
