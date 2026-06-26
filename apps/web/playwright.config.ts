import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
  testDir: "./e2e",
  timeout: 30_000,
  expect: { timeout: 10_000 },
  fullyParallel: false,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  workers: 1,
  reporter: "list",
  use: {
    baseURL: "http://127.0.0.1:5173",
    trace: "on-first-retry",
  },
  projects: [
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"] },
    },
  ],
  webServer: [
    {
      cwd: "../..",
      command:
        "deno run --env-file=.env.production.local --allow-net --allow-env --allow-read src/db/migrate.ts && deno run --env-file=.env.production.local --allow-net --allow-env --allow-read --allow-write --allow-sys --allow-ffi src/server/main.ts",
      url: "http://127.0.0.1:3000/health",
      reuseExistingServer: !process.env.CI,
      timeout: 15_000,
    },
    {
      cwd: "../..",
      command: "npm --workspace apps/web run dev -- --host 127.0.0.1 --port 5173",
      url: "http://127.0.0.1:5173",
      reuseExistingServer: !process.env.CI,
      timeout: 15_000,
    },
  ],
});
