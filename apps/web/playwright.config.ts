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
  globalTeardown: "./e2e/global-teardown.ts",
  use: {
    baseURL: "http://127.0.0.1:5174",
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
      command: "deno task e2e:api",
      url: "http://127.0.0.1:3100/health",
      reuseExistingServer: false,
      timeout: 30_000,
    },
    {
      cwd: "../..",
      command: "npm --workspace apps/web run e2e:server",
      url: "http://127.0.0.1:5174",
      reuseExistingServer: false,
      timeout: 15_000,
      env: {
        WEB_PORT: "5174",
        BACKEND_ORIGIN: "http://127.0.0.1:3100",
      },
    },
  ],
});
