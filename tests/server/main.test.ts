import { test } from "bun:test";
import { assertEquals, assertExists, assertRejects } from "../assertions.ts";
import type { Database } from "../../src/db/client.ts";
import { withTestDb } from "../../src/db/testing.ts";
import { bootServer } from "../../src/server/main.ts";
import {
  createDigestRun,
  listDigestRunFeedsForRun,
  listDigestRunsForUser,
  startDigestRunFeed,
} from "../../src/repositories/digest-run-repository.ts";
import { createUser } from "../../src/repositories/user-repository.ts";
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

test("bootServer waits for stale recovery before registering jobs and serving", async () => {
  const scheduler = new FakeScheduler();
  let servedOptions: { hostname: string; port: number } | undefined;
  let requestHandler:
    | ((request: Request, server: Bun.Server<undefined>) => Response | Promise<Response>)
    | undefined;
  const recoveryGate = Promise.withResolvers<number>();
  const recoveryCalls: Array<
    { database: Database; now: number; staleAfterMs: number }
  > = [];

  const previousModelEnvironment = new Map(
    MODEL_ENV_KEYS.map((key) => [key, process.env[key]]),
  );
  try {
    for (const key of MODEL_ENV_KEYS) delete process.env[key];
    const bootPromise = bootServer({
      serverHostname: " 192.0.2.20 ",
      database: {} as Database,
      scheduler,
      summarizer: { summarize: () => Promise.resolve([]) },
      recoverStaleRuns: (database, now, staleAfterMs) => {
        recoveryCalls.push({ database, now, staleAfterMs });
        return recoveryGate.promise;
      },
      now: () => 1_234,
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
      serve: (options) => {
        servedOptions = { hostname: options.hostname, port: options.port };
        requestHandler = options.fetch;
      },
      log: () => {},
    });
    assertEquals(recoveryCalls, [{
      database: {} as Database,
      now: 1_234,
      staleAfterMs: 1,
    }]);
    assertEquals(scheduler.jobs.length, 0);
    assertEquals(servedOptions, undefined);
    recoveryGate.resolve(1);
    await bootPromise;
  } finally {
    for (const [key, value] of previousModelEnvironment) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
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
    {} as Bun.Server<undefined>,
  );
  assertEquals(response.status, 200);
  assertEquals(await response.json(), { ok: true });
});

test("bootServer recovers stale runs before serving registration", async () => {
  await withTestDb(async (database) => {
    const interruptedUser = await createUser(database, {
      name: "Interrupted",
      email: "interrupted-at-boot@example.com",
      passwordHash: "$argon2id$fakehash",
      systemPrompt: "Summarize tersely.",
      defaultLanguage: "en",
    });
    const interruptedRun = await createDigestRun(database, {
      userId: interruptedUser.id,
      trigger: "manual",
      periodStartMs: 100,
      periodEndMs: 200,
      status: "running",
    }, 1_000);
    const interruptedStage = await startDigestRunFeed(database, {
      runId: interruptedRun.id,
      connectorId: "Telegram",
      stage: "summarization",
      status: "running",
    }, 1_100);
    const recoveryTime = 10_000;
    const scheduler = new FakeScheduler();
    let requestHandler:
      | ((request: Request, server: Bun.Server<undefined>) => Response | Promise<Response>)
      | undefined;
    const previousModelEnvironment = new Map(
      MODEL_ENV_KEYS.map((key) => [key, process.env[key]]),
    );
    try {
      for (const key of MODEL_ENV_KEYS) delete process.env[key];
      await bootServer({
        database,
        scheduler,
        now: () => recoveryTime,
        config: {
          databaseUrl: "postgres://unused",
          port: 31_002,
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
          digestRunStaleAfterMs: 5_000,
          schedulerLeaseMs: 1,
        },
        serve: (options) => {
          requestHandler = options.fetch;
        },
        log: () => {},
      });
      const [recoveredRun] = await listDigestRunsForUser(
        database,
        interruptedUser.id,
      );
      assertEquals(recoveredRun.status, "failed");
      assertEquals(recoveredRun.finishedAt, recoveryTime);
      assertEquals(recoveredRun.errorMessage, "digest run lease expired");
      const [recoveredStage] = await listDigestRunFeedsForRun(
        database,
        interruptedRun.id,
        interruptedUser.id,
      );
      assertEquals(recoveredStage.id, interruptedStage.id);
      assertEquals(recoveredStage.status, "failed");
      assertEquals(recoveredStage.finishedAt, recoveryTime);
      assertEquals(recoveredStage.errorMessage, "digest run lease expired");
      assertExists(requestHandler);
      const response = await requestHandler(
        new Request("http://127.0.0.1:31002/auth/register", {
          method: "POST",
          headers: {
            "content-type": "application/json",
            origin: "http://127.0.0.1:5173",
          },
          body: JSON.stringify({
            name: "Ada Lovelace",
            email: "boot-register@example.com",
            password: "analytical-engine-1843",
          }),
        }),
        {} as Bun.Server<undefined>,
      );
      assertEquals(response.status, 201);
    } finally {
      for (const [key, value] of previousModelEnvironment) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
  });
});

test("bootServer rejects invalid model configuration before serving", async () => {
  const previous = process.env["SUMMARIZER_MODEL"];
  let served = false;
  try {
    process.env["SUMMARIZER_MODEL"] = "   ";
    await assertRejects(
      () =>
        bootServer({
          database: {} as Database,
          scheduler: new FakeScheduler(),
          recoverStaleRuns: () => Promise.resolve(0),
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
    if (previous === undefined) delete process.env["SUMMARIZER_MODEL"];
    else process.env["SUMMARIZER_MODEL"] = previous;
  }
});
