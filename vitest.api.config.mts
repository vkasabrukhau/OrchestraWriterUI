import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

/** API integration tests: need `docker compose up -d` (Postgres + S3Mock). */
export default defineConfig({
  resolve: { alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) } },
  test: {
    name: "api",
    environment: "node",
    // the transcription routes are off by default; the backend tests still cover them
    // the sample project is off so new libraries start empty; sample-project.test.ts calls it directly
    env: { PIPELINE_ENABLED: "1", SAMPLE_PROJECT: "off" },
    include: ["tests/api/**/*.test.ts"],
    fileParallelism: false,
    testTimeout: 30_000,
    hookTimeout: 60_000,
  },
});
