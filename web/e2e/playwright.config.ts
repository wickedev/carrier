import { defineConfig, devices } from "@playwright/test";

/**
 * Route-mocked E2E for the Carrier web client.
 *
 * There is no real backend in this suite: every `/bff/*` and `/auth/*` request
 * is intercepted with `page.route(...)` (see `tests/fixtures.ts`) and fulfilled
 * with canned JSON / SSE matching `@carrier/contract`. The `webServer` below
 * builds and previews the *real* `@carrier/web` bundle so flows run against the
 * actual frontend, deterministically, without a BFF / Carrier / DB.
 */

const PORT = 4173;
const baseURL = `http://localhost:${PORT}`;

export default defineConfig({
  testDir: "./tests",
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  workers: process.env.CI ? 1 : undefined,
  reporter: process.env.CI ? "github" : "list",
  use: {
    baseURL,
    trace: "on-first-retry",
  },
  projects: [
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"] },
    },
  ],
  webServer: {
    // Build the web app, then serve the static bundle on a fixed port. Running
    // from the repo root (cwd) means the pnpm filters resolve the workspace.
    command:
      "pnpm --filter @carrier/web build && pnpm --filter @carrier/web preview --port " +
      `${PORT} --strictPort --host 127.0.0.1`,
    url: baseURL,
    reuseExistingServer: !process.env.CI,
    timeout: 180_000,
    cwd: "..",
  },
});
