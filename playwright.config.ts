import { defineConfig, devices } from "@playwright/test";

/**
 * End-to-end tests drive the real app against the local docker stack
 * (`docker compose up -d`). Set E2E_BASE_URL to test a deployed instance.
 * WebCodecs (MP4 export) needs Chromium; the suite runs there only.
 */
const baseURL = process.env.E2E_BASE_URL ?? "http://localhost:3000";

export default defineConfig({
  testDir: "tests/e2e",
  timeout: 120_000,
  expect: { timeout: 15_000 },
  fullyParallel: false,
  workers: 1,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [["github"], ["html", { open: "never" }]] : [["list"]],
  use: {
    baseURL,
    trace: "retain-on-failure",
    video: "retain-on-failure",
    viewport: { width: 1440, height: 900 },
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
  webServer: process.env.E2E_BASE_URL
    ? undefined
    : {
        command: process.env.CI ? "npm run start" : "npm run dev",
        url: `${baseURL}/api/health`,
        reuseExistingServer: !process.env.CI,
        // New libraries start empty in the tests (the temporary sample project
        // is on by default; tests/api turns it off the same way). A dev server
        // that is already running must be started with SAMPLE_PROJECT=off too.
        env: { SAMPLE_PROJECT: "off" },
        timeout: 180_000,
      },
});
