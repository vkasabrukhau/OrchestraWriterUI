// Reads and validates environment variables (see .env.example).
// Everything else imports `env` from here; nothing else touches process.env.
//
// Outside production every variable has a default that matches the local
// docker compose stack (Postgres on 5433, S3Mock on 9090), so `docker compose
// up -d && npm run dev` works with no .env file at all. Next.js loads
// .env.local / .env itself; the CLI scripts load them through db/load-env.ts.
//
// During `next build` (NEXT_PHASE=phase-production-build) Next imports route
// modules to read their config. Nothing connects at that point, so missing
// production variables get inert placeholders instead of failing the build;
// the running server still requires them.

const nodeEnv = process.env.NODE_ENV ?? "development";
const isProduction = nodeEnv === "production";
const isBuildPhase = process.env.NEXT_PHASE === "phase-production-build";

function required(name: string): string {
  const value = process.env[name];
  if (value) return value;
  if (isBuildPhase) return `build-placeholder-${name.toLowerCase()}`;
  throw new Error(`Missing required environment variable: ${name}`);
}

function optional(name: string, fallback: string): string {
  return process.env[name] ?? fallback;
}

/**
 * Production: required. Elsewhere: the local docker compose value, unless the
 * variable is set (an empty string counts as set, e.g. S3_ENDPOINT= for real S3).
 */
function local(name: string, localDefault: string): string {
  if (isProduction) return required(name);
  return process.env[name] ?? localDefault;
}

/** Like local(), but an empty value means "not configured". */
function localOptional(name: string, localDefault: string): string | undefined {
  const value = isProduction ? process.env[name] : (process.env[name] ?? localDefault);
  return value ? value : undefined;
}

const port = Number(optional("PORT", "3000"));

const s3Endpoint = localOptional("S3_ENDPOINT", "http://localhost:9090");
const s3PublicEndpoint = localOptional("S3_PUBLIC_ENDPOINT", s3Endpoint ?? "") ?? s3Endpoint;

export const env = {
  nodeEnv,
  isProduction,
  isDevelopment: nodeEnv === "development",
  port,

  aws: {
    region: local("AWS_REGION", "us-east-1"),
    // Explicit credentials only for the local S3 stand-in (it ignores them, the SDK
    // insists on having some). Otherwise undefined: the SDK default chain decides
    // (env vars, ~/.aws, or the App Runner instance role).
    credentials:
      !isProduction && !process.env.AWS_ACCESS_KEY_ID && s3Endpoint
        ? { accessKeyId: "local", secretAccessKey: "local" }
        : undefined,
  },

  // Postgres. Two modes:
  //   - Aurora: no DB_PASSWORD; an IAM token is generated per connection.
  //   - Local Docker Postgres: DB_PASSWORD set and DB_SSL=false (the defaults here).
  db: {
    host: local("DB_HOST", "localhost"),
    port: Number(optional("DB_PORT", isProduction ? "5432" : "5433")),
    name: local("DB_NAME", "orchestra"),
    user: local("DB_USER", "postgres"),
    password: (isProduction ? process.env.DB_PASSWORD : (process.env.DB_PASSWORD ?? "orchestra")) || undefined,
    // DB_SSL=false disables TLS entirely (a local Postgres has none).
    ssl: optional("DB_SSL", isProduction ? "true" : "false") !== "false",
    // Verify the server certificate (default true). Only set false while debugging.
    sslVerify: optional("DB_SSL_VERIFY", "true") !== "false",
    // Optional extra CA bundle, added to Node's built-in roots. Needed only for
    // clusters whose certificate is issued by the RDS private CA.
    sslCaPath: process.env.DB_SSL_CA_PATH || undefined,
  },

  s3: {
    // Optional in production until the bucket exists; storage routes return 503 without it.
    audioBucket: localOptional("S3_AUDIO_BUCKET", "orchestra-audio"),
    // Local S3 stand-in (S3Mock via docker compose). S3_ENDPOINT is what the server
    // calls; S3_PUBLIC_ENDPOINT is the same service as the browser reaches it, used
    // only when signing URLs the browser will open. Both empty = real AWS S3.
    endpoint: s3Endpoint,
    publicEndpoint: s3PublicEndpoint,
  },

  // Extra browser origins allowed to call /api/* with cookies, e.g. a frontend dev
  // server on another port. Comma-separated. Empty = same-origin only.
  corsOrigins: (process.env.CORS_ORIGINS ?? "")
    .split(",")
    .map((o) => o.trim())
    .filter(Boolean),

  // Local audio-to-score service (ml/server.py, MuScriptor). Locally it defaults
  // to http://127.0.0.1:8333; unset in production unless TRANSCRIBER_URL is set.
  transcriber: {
    url: localOptional("TRANSCRIBER_URL", "http://127.0.0.1:8333"),
    // Only an explicit TRANSCRIBER_URL replaces the placeholder in the
    // /api/transcriptions pipeline's model slot (pipeline/model.ts).
    explicit: Boolean(process.env.TRANSCRIBER_URL),
  },

  // Transcription pipeline. "stepfunctions" in production (STATE_MACHINE_ARN set),
  // "inline" locally: the same step code runs inside the API process, no AWS needed.
  pipeline: {
    // The audio-to-score pipeline is not part of the visualizer spec; its routes
    // (/files, /transcriptions, /sheets) are mounted only when PIPELINE_ENABLED=1.
    enabled: process.env.PIPELINE_ENABLED === "1",
    stateMachineArn: process.env.STATE_MACHINE_ARN || undefined,
    mode: (process.env.PIPELINE_MODE ||
      (process.env.STATE_MACHINE_ARN ? "stepfunctions" : "inline")) as "stepfunctions" | "inline",
  },

  auth: {
    // Signs session cookies. Required in production; a fixed local value otherwise.
    secret: local("BETTER_AUTH_SECRET", "local-only-secret-not-for-production"),
    // Public origin of the site. Better Auth builds OAuth callback URLs from it,
    // so it must match what the browser sees (including https:// in production).
    url: local("BETTER_AUTH_URL", `http://localhost:${port}`),
    // Google sign-in is enabled only when both values are present.
    google: {
      clientId: process.env.GOOGLE_CLIENT_ID || undefined,
      clientSecret: process.env.GOOGLE_CLIENT_SECRET || undefined,
    },
  },
} as const;
