import { assertEquals, assertExists, assertThrows } from "@std/assert";
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

const MODEL_ENV_KEYS = [
  "SUMMARIZER_MODEL",
  "SUMMARIZER_BASE_URL",
  "SUMMARIZER_API_KEY",
  "VISION_MODEL",
  "VISION_BASE_URL",
  "VISION_API_KEY",
];

Deno.test("bootServer registers jobs and serves health without startup side effects", async () => {
  const scheduler = new FakeScheduler();
  let servedOptions: { hostname: string; port: number } | undefined;
  let requestHandler:
    | ((request: Request) => Response | Promise<Response>)
    | undefined;

  const previousModelEnvironment = new Map(
    MODEL_ENV_KEYS.map((key) => [key, Deno.env.get(key)]),
  );
  try {
    for (const key of MODEL_ENV_KEYS) Deno.env.delete(key);
    bootServer({
      serverHostname: " 192.0.2.20 ",
      database: {} as Database,
      scheduler,
      summarizer: { summarize: async () => [] },
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
  } finally {
    for (const [key, value] of previousModelEnvironment) {
      if (value === undefined) Deno.env.delete(key);
      else Deno.env.set(key, value);
    }
  }

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

Deno.test("bootServer rejects invalid model configuration before serving", () => {
  const previous = Deno.env.get("SUMMARIZER_MODEL");
  let served = false;
  try {
    Deno.env.set("SUMMARIZER_MODEL", "   ");
    assertThrows(
      () =>
        bootServer({
          database: {} as Database,
          scheduler: new FakeScheduler(),
          serve: () => {
            served = true;
          },
          log: () => {},
        }),
      Error,
      "Invalid SUMMARIZER_MODEL",
    );
    assertEquals(served, false);
  } finally {
    if (previous === undefined) Deno.env.delete("SUMMARIZER_MODEL");
    else Deno.env.set("SUMMARIZER_MODEL", previous);
  }
});
