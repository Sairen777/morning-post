import { describe, expect, it } from "vitest";
import config from "../playwright.config";

describe("Playwright environment isolation", () => {
  it("uses dedicated servers and database lifecycle commands", () => {
    expect(config.use?.baseURL).toBe("http://127.0.0.1:5174");
    expect(config.globalTeardown).toBe("./e2e/global-teardown.ts");

    const webServers = Array.isArray(config.webServer)
      ? config.webServer
      : [config.webServer];
    expect(webServers).toHaveLength(2);
    expect(webServers[0]).toMatchObject({
      command: "deno task e2e:api",
      url: "http://127.0.0.1:3100/health",
      reuseExistingServer: false,
    });
    expect(webServers[1]).toMatchObject({
      command: "npm --workspace apps/web run e2e:server",
      url: "http://127.0.0.1:5174",
      reuseExistingServer: false,
      env: {
        WEB_PORT: "5174",
        BACKEND_ORIGIN: "http://127.0.0.1:3100",
      },
    });
  });

  it("allows the API to apply pending migrations before readiness", () => {
    const webServers = Array.isArray(config.webServer)
      ? config.webServer
      : [config.webServer];

    expect(webServers[0]?.timeout).toBeGreaterThanOrEqual(30_000);
  });
});
