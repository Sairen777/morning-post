import { assertEquals, assertExists } from "@std/assert";
import type { Database } from "../../src/db/client.ts";
import { bootServer } from "../../src/server/main.ts";
import type { Scheduler } from "../../src/scheduler/scheduler.ts";

type ScheduledJob = {
  name: string;
  cron: string;
  handler: () => Promise<void> | void;
};

class FakeScheduler implements Scheduler {
  jobs: ScheduledJob[] = [];

  schedule(
    name: string,
    cron: string,
    handler: () => Promise<void> | void,
  ): void {
    this.jobs.push({ name, cron, handler });
  }
}

Deno.test("bootServer registers jobs and serves health without startup side effects", async () => {
  const scheduler = new FakeScheduler();
  let servedOptions: { hostname: string; port: number } | undefined;
  let requestHandler:
    | ((request: Request) => Response | Promise<Response>)
    | undefined;

  bootServer({
    serverHostname: " 192.0.2.20 ",
    database: {} as Database,
    scheduler,
    config: {
      databaseUrl: "postgres://unused",
      port: 31_001,
      allowedOrigins: ["http://127.0.0.1:5173"],
      trustedProxyCount: 0,
      maxRequestBodyBytes: 1_000,
      databasePoolMax: 1,
      databaseIdleTimeoutSeconds: 1,
      databaseConnectTimeoutSeconds: 1,
      databaseSslMode: "disable",
      allowRemoteSummarization: false,
      connectorTimeoutMs: 1,
      summarizerTextBytesPerChunk: 1,
      summarizerMaxItemsPerChunk: 1,
      summarizerMaxImageBytes: 1,
      summarizerTimeoutMs: 1,
      summarizationConcurrency: 1,
      mediaTtlMs: 1,
      mediaQuotaBytes: 1,
      digestRunStaleAfterMs: 1,
      schedulerLeaseMs: 1,
    },
    serve: (options, handler) => {
      servedOptions = options;
      requestHandler = handler;
    },
    log: () => {},
  });

  assertEquals(scheduler.jobs.length, 2);
  assertEquals(scheduler.jobs.map(({ name }) => name), [
    "digest-job",
    "media-housekeeping",
  ]);
  assertEquals(servedOptions, { hostname: "192.0.2.20", port: 31_001 });
  assertExists(requestHandler);

  const response = await requestHandler(
    new Request("http://192.0.2.20:31001/health"),
  );
  assertEquals(response.status, 200);
  assertEquals(await response.json(), { ok: true });
});
