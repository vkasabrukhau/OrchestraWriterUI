// How the API reaches the transcription service (ml/server.py, MuScriptor).
//
//   AWS: TRANSCRIBER_INSTANCE_ID, a GPU instance (scripts/ml-init.sh) that stops
//   itself after 15 idle minutes. connectTranscriber() starts it when it is
//   stopped and waits for the service, then every call goes over HTTPS to the
//   instance's public IP (new on every start, so it is looked up each time),
//   pinned to the service's self-signed certificate (TRANSCRIBER_TLS_CERT) and
//   carrying the bearer TRANSCRIBER_TOKEN.
//
//   Local and tests: TRANSCRIBER_URL, a service that is already running
//   (`npm run ml:serve`), called with plain fetch.
import { request as httpsRequest } from "node:https";
import { DescribeInstancesCommand, EC2Client, StartInstancesCommand } from "@aws-sdk/client-ec2";
import { awsConfig } from "../config/aws";
import { env } from "../config/env";

export type TranscriberCall = {
  method?: string;
  headers?: Record<string, string>;
  body?: string | Buffer<ArrayBuffer>;
  signal?: AbortSignal;
};

export type Transcriber = {
  call(path: string, init?: TranscriberCall): Promise<Response>;
  /** Why a call could not connect, for the job's error message. */
  unreachable(): string;
};

/** The two calls connectInstance needs from EC2 (a fake in tests). */
export type InstanceApi = {
  describe(): Promise<{ state: string; ip: string | null }>;
  start(): Promise<void>;
};

/** Instance running with a public IP: a stopped g4dn boots in about a minute. */
const BOOT_TIMEOUT_MS = 6 * 60 * 1000;
/** Service answering: the first boot of a new instance installs PyTorch first. */
const SERVICE_TIMEOUT_MS = 30 * 60 * 1000;
const POLL_MS = 5000;

export function transcriberConfigured(): boolean {
  return Boolean(env.transcriber.instanceId || env.transcriber.url);
}

/**
 * A client for the transcription service, once it answers. On AWS this starts
 * the GPU instance if needed; `onStatus` reports that wait (minutes) to the job.
 */
export async function connectTranscriber(onStatus: (message: string) => Promise<unknown> = async () => {}): Promise<Transcriber> {
  const { instanceId, port, token, tlsCert, url } = env.transcriber;
  if (instanceId) {
    if (!token || !tlsCert) throw new Error("TRANSCRIBER_TOKEN and TRANSCRIBER_TLS_CERT must be set with TRANSCRIBER_INSTANCE_ID");
    return connectInstance({ api: ec2Instance(instanceId), port, token, cert: tlsCert, onStatus });
  }
  if (url) return urlTranscriber(url, token);
  throw new Error("The transcription service is not configured");
}

/** Start the instance if it is stopped, wait for its service, and return a client for it. */
export async function connectInstance(options: {
  api: InstanceApi;
  port: number;
  token: string;
  cert: string;
  onStatus: (message: string) => Promise<unknown>;
  pollMs?: number;
  bootTimeoutMs?: number;
  serviceTimeoutMs?: number;
}): Promise<Transcriber> {
  const { api, onStatus } = options;
  const pollMs = options.pollMs ?? POLL_MS;
  const sleep = () => new Promise((r) => setTimeout(r, pollMs));

  let ip: string | null = null;
  let announced = false;
  const bootDeadline = Date.now() + (options.bootTimeoutMs ?? BOOT_TIMEOUT_MS);
  for (;;) {
    const instance = await api.describe();
    if (instance.state === "running" && instance.ip) {
      ip = instance.ip;
      break;
    }
    if (instance.state === "shutting-down" || instance.state === "terminated") {
      throw new Error("The GPU server for transcription was deleted. Re-run scripts/ml-init.sh to create a new one.");
    }
    if (!announced) {
      await onStatus("Starting the GPU server (about 2 minutes)");
      announced = true;
    }
    // "stopping" can't be started yet; wait for "stopped". "pending" is on its way.
    if (instance.state === "stopped") await startInstance(api);
    if (Date.now() > bootDeadline) throw new Error("The GPU server did not start in time. Try again in a few minutes.");
    await sleep();
  }

  const service = pinnedTranscriber(`https://${ip}:${options.port}`, options.token, options.cert);
  // The token makes this count as use, so the instance does not stop meanwhile.
  const serviceDeadline = Date.now() + (options.serviceTimeoutMs ?? SERVICE_TIMEOUT_MS);
  let waiting = false;
  for (;;) {
    const res = await service.call("/health", { signal: AbortSignal.timeout(10_000) }).catch(() => null);
    if (res?.ok) return service;
    if (!waiting) {
      await onStatus("Waiting for the transcription service to start");
      waiting = true;
    }
    if (Date.now() > serviceDeadline) throw new Error("The transcription service on the GPU server did not start in time");
    await sleep();
  }
}

async function startInstance(api: InstanceApi): Promise<void> {
  try {
    await api.start();
  } catch (err) {
    const name = (err as { name?: string }).name;
    if (name === "InsufficientInstanceCapacity") {
      throw new Error("AWS has no free GPU server of this type right now. Try again in a few minutes.");
    }
    // Started or stopped by someone else in the meantime; the next describe tells.
    if (name !== "IncorrectInstanceState") throw err;
  }
}

function ec2Instance(instanceId: string): InstanceApi {
  const ec2 = new EC2Client(awsConfig);
  return {
    async describe() {
      const out = await ec2.send(new DescribeInstancesCommand({ InstanceIds: [instanceId] }));
      const instance = out.Reservations?.[0]?.Instances?.[0];
      return { state: instance?.State?.Name ?? "terminated", ip: instance?.PublicIpAddress ?? null };
    },
    async start() {
      await ec2.send(new StartInstancesCommand({ InstanceIds: [instanceId] }));
    },
  };
}

/**
 * HTTPS calls that trust only `cert`. The certificate is the sole trust anchor,
 * so the name in it need not match the IP, which changes on every start.
 */
export function pinnedTranscriber(base: string, token: string, cert: string): Transcriber {
  return {
    unreachable: () => `The transcription service on the GPU server (${base}) is not answering`,
    call: (path, init = {}) =>
      new Promise<Response>((resolve, reject) => {
        const body = init.body;
        const req = httpsRequest(
          `${base}${path}`,
          {
            method: init.method ?? "GET",
            headers: {
              ...init.headers,
              authorization: `Bearer ${token}`,
              ...(body !== undefined ? { "content-length": String(Buffer.byteLength(body)) } : {}),
            },
            ca: cert,
            checkServerIdentity: () => undefined,
            signal: init.signal,
          },
          (res) => {
            const chunks: Buffer[] = [];
            res.on("data", (chunk: Buffer) => chunks.push(chunk));
            res.on("error", reject);
            res.on("end", () => {
              const status = res.statusCode ?? 502;
              const headers = new Headers();
              for (const [key, value] of Object.entries(res.headers)) {
                if (value !== undefined) headers.set(key, Array.isArray(value) ? value.join(", ") : value);
              }
              const empty = status === 204 || status === 304 || chunks.length === 0;
              resolve(new Response(empty ? null : new Uint8Array(Buffer.concat(chunks)), { status, headers }));
            });
          },
        );
        req.on("error", reject);
        if (body !== undefined) req.write(body);
        req.end();
      }),
  };
}

function urlTranscriber(url: string, token: string | undefined): Transcriber {
  const base = url.replace(/\/$/, "");
  return {
    unreachable: () => `The transcription service is not running at ${base}. Start it with: npm run ml:serve`,
    call: (path, init = {}) =>
      fetch(`${base}${path}`, {
        method: init.method,
        headers: { ...init.headers, ...(token ? { authorization: `Bearer ${token}` } : {}) },
        body: init.body,
        signal: init.signal,
      }),
  };
}
