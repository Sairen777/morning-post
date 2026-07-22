import { test } from "bun:test";
import { assertEquals } from "../assertions.ts"
import { withTestDb } from "../../src/db/testing.ts";
import type { Database } from "../../src/db/client.ts";
import {
  createUser,
  type CreateUserInput,
  type User,
} from "../../src/repositories/user-repository.ts";
import {
  DigestRunAlreadyRunningError,
  listDigestRunsForUser,
} from "../../src/repositories/digest-run-repository.ts";
import { upsertDigestForPeriod } from "../../src/repositories/digest-repository.ts";
import {
  clearDigestJobStateForTesting,
  computeDigestPeriod,
  DEFAULT_DIGEST_CRON,
  MEDIA_HOUSEKEEPING_CRON,
  runDigestTick,
  scheduleDigestJob,
  scheduleMediaHousekeeping,
} from "../../src/scheduler/digest-job.ts";
import { bootServer } from "../../src/server/main.ts";
import type { Scheduler } from "../../src/scheduler/scheduler.ts";
import type { SummarizerService } from "../../src/summarizers/summarizer.types.ts";

class FakeScheduler implements Scheduler {
  jobs: Array<
    { name: string; cron: string; handler: () => Promise<void> | void }
  > = [];

  schedule(
    name: string,
    cron: string,
    handler: () => Promise<void> | void,
  ): void {
    this.jobs.push({ name, cron, handler });
  }
}

function userInput(email: string): CreateUserInput {
  return {
    name: "Scheduler Owner",
    email,
    passwordHash: "$argon2id$fakehash",
    systemPrompt: "Summarize tersely.",
    defaultLanguage: "en",
  };
}

test("computeDigestPeriod starts from latest digest end or default cadence", async () => {
  await withTestDb(async (database: Database) => {
    const firstUser = await createUser(
      database,
      userInput("scheduler-first@example.com"),
    );
    const secondUser = await createUser(
      database,
      userInput("scheduler-second@example.com"),
    );
    await upsertDigestForPeriod(database, {
      userId: secondUser.id,
      periodStartMs: 100,
      periodEndMs: 200,
      status: "complete",
    }, 10);

    assertEquals(
      await computeDigestPeriod(database, firstUser.id, 1_000, 100),
      { startMs: 901, endMs: 1_000 },
    );
    assertEquals(
      await computeDigestPeriod(database, secondUser.id, 1_000, 100),
      { startMs: 201, endMs: 1_000 },
    );
  });
});

test("runDigestTick triggers one run per user and isolates errors", async () => {
  clearDigestJobStateForTesting();
  await withTestDb(async (database: Database) => {
    const firstUser = await createUser(
      database,
      userInput("scheduler-run-first@example.com"),
    );
    await createUser(database, userInput("scheduler-run-second@example.com"));
    const calls: Array<
      { userId: string; period: { startMs: number; endMs: number } }
    > = [];
    const errors: string[] = [];

    await runDigestTick(database, {
      now: () => 1_000,
      logError: (message) => errors.push(message),
      runForUser: (_database, userId, period) => {
        calls.push({ userId, period });
        if (userId === firstUser.id) {
          throw new Error(
            "provider failed sk-scheduler-secret at https://scheduler-user:scheduler-pass@example.com",
          );
        }
        return Promise.resolve({
          digest: {
            id: "x",
            userId,
            periodStartMs: period.startMs,
            periodEndMs: period.endMs,
            status: "complete",
            createdAt: 0,
            updatedAt: 0,
          },
          sections: [],
          groups: [],
          paidPosts: [],
        });
      },
    });

    assertEquals(calls.length, 2);
    assertEquals(calls[0].period.endMs, 1_000);
    assertEquals(errors.length, 1);
    assertEquals(errors[0].includes(firstUser.id), true);
    assertEquals(errors[0].includes("provider failed"), true);
    assertEquals(errors[0].includes("sk-scheduler-secret"), false);
    assertEquals(errors[0].includes("scheduler-user:scheduler-pass"), false);
    assertEquals(errors[0].includes("[REDACTED]"), true);
  });
});

test("runDigestTick skips users that are already running", async () => {
  clearDigestJobStateForTesting();
  await withTestDb(async (database: Database) => {
    const user = await createUser(
      database,
      userInput("scheduler-overlap@example.com"),
    );
    const gate = Promise.withResolvers<void>();
    let calls = 0;

    const firstTick = runDigestTick(database, {
      now: () => 1_000,
      runForUser: async () => {
        calls += 1;
        await gate.promise;
        return {
          digest: {
            id: "x",
            userId: user.id,
            periodStartMs: 0,
            periodEndMs: 0,
            status: "complete",
            createdAt: 0,
            updatedAt: 0,
          },
          sections: [],
          groups: [],
          paidPosts: [],
        };
      },
    });
    const secondTick = runDigestTick(database, {
      now: () => 1_000,
      runForUser: () => {
        calls += 1;
        return Promise.resolve({
          digest: {
            id: "x",
            userId: user.id,
            periodStartMs: 0,
            periodEndMs: 0,
            status: "complete",
            createdAt: 0,
            updatedAt: 0,
          },
          sections: [],
          groups: [],
          paidPosts: [],
        });
      },
    });

    await Promise.resolve();
    gate.resolve();
    await Promise.all([firstTick, secondTick]);
    assertEquals(calls, 1);
  });
});

test("scheduleDigestJob registers the default cron and handler", async () => {
  clearDigestJobStateForTesting();
  await withTestDb(async (database: Database) => {
    const scheduler = new FakeScheduler();
    const calls: string[] = [];

    scheduleDigestJob(scheduler, database, {
      now: () => 1_000,
      runForUser: (_database, userId) => {
        calls.push(userId);
        return Promise.resolve({
          digest: {
            id: "x",
            userId,
            periodStartMs: 0,
            periodEndMs: 0,
            status: "complete",
            createdAt: 0,
            updatedAt: 0,
          },
          sections: [],
          groups: [],
          paidPosts: [],
        });
      },
    });

    assertEquals(scheduler.jobs.length, 1);
    assertEquals(scheduler.jobs[0].name, "digest-job");
    assertEquals(scheduler.jobs[0].cron, DEFAULT_DIGEST_CRON);

    await createUser(database, userInput("scheduler-scheduled@example.com"));
    await scheduler.jobs[0].handler();
    assertEquals(calls.length, 1);
  });
});

test("runDigestTick forwards the shared summarizer to scheduled execution", async () => {
  clearDigestJobStateForTesting();
  await withTestDb(async (database) => {
    const sharedSummarizer = {} as SummarizerService;
    let receivedSummarizer: SummarizerService | undefined;
    const user = await createUser(
      database,
      userInput("scheduler-shared-summarizer@example.com"),
    );
    await runDigestTick(database, {
      summarizer: sharedSummarizer,
      now: () => 1_500,
      runForUser: (_database, userId, period, dependencies = {}) => {
        receivedSummarizer = dependencies.summarizer;
        return Promise.resolve({
          digest: {
            id: "x",
            userId,
            periodStartMs: period.startMs,
            periodEndMs: period.endMs,
            status: "complete" as const,
            createdAt: 0,
            updatedAt: 0,
          },
          sections: [],
          groups: [],
          paidPosts: [],
        });
      },
    });
    assertEquals(user.id.length > 0, true);
    assertEquals(receivedSummarizer, sharedSummarizer);
  });
});

test("scheduleMediaHousekeeping registers the weekly Sunday cron", () => {
  const scheduler = new FakeScheduler();
  scheduleMediaHousekeeping(scheduler);
  assertEquals(scheduler.jobs.length, 1);
  assertEquals(scheduler.jobs[0].name, "media-housekeeping");
  assertEquals(scheduler.jobs[0].cron, MEDIA_HOUSEKEEPING_CRON);
  assertEquals(scheduler.jobs[0].cron, "0 6 * * SUN");
});

test("scheduleDigestJob skips digest work when the lease is held by another worker", async () => {
  await withTestDb(async (database: Database) => {
    const scheduler = new FakeScheduler();
    let runCalls = 0;
    let leaseDuration = 0;
    scheduleDigestJob(scheduler, database, {
      now: () => 2_000,
      ownerId: "worker-2",
      schedulerLeaseMs: 321,
      acquireLease: (_database, name, ownerId, now, leaseMs) => {
        assertEquals(name, "digest-job");
        assertEquals(ownerId, "worker-2");
        assertEquals(now, 2_000);
        leaseDuration = leaseMs;
        return Promise.resolve(false);
      },
      runForUser: () => {
        runCalls++;
        return Promise.reject(
          new Error("losing worker must not run digest work"),
        );
      },
    });

    await scheduler.jobs[0].handler();
    assertEquals(leaseDuration, 321);
    assertEquals(runCalls, 0);
  });
});

test("bootServer injects scheduler and serve after stale recovery", async () => {
  await withTestDb(async (database: Database) => {
    const scheduler = new FakeScheduler();
    let served = 0;
    await bootServer({
      database,
      scheduler,
      summarizer: { summarize: () => Promise.resolve([]) },
      recoverStaleRuns: () => Promise.resolve(0),
      config: {
        databaseUrl: "postgres://localhost/test",
        port: 31_001,
        allowedOrigins: ["http://localhost:5173"],
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
      serve: (_options) => {
        served++;
      },
      log: () => {},
    });
    assertEquals(scheduler.jobs.length, 2);
    assertEquals(served, 1);
  });
});
test("leader tick recovers stale runs before processing users", async () => {
  await withTestDb(async (database: Database) => {
    const scheduler = new FakeScheduler();
    const events: string[] = [];
    const user = await createUser(
      database,
      userInput("scheduler-recovery-order@example.com"),
    );
    scheduleDigestJob(scheduler, database, {
      now: () => 4_000,
      ownerId: "worker-leader",
      acquireLease: () => {
        events.push("lease");
        return Promise.resolve(true);
      },
      recoverStaleRuns: (_database, now, staleAfterMs) => {
        events.push(`recovery:${now}:${staleAfterMs}`);
        return Promise.resolve(0);
      },
      runForUser: (_database, userId) => {
        events.push(`run:${userId}`);
        return Promise.resolve({
          digest: {
            id: "x",
            userId,
            periodStartMs: 0,
            periodEndMs: 0,
            status: "complete" as const,
            createdAt: 0,
            updatedAt: 0,
          },
          sections: [],
          groups: [],
          paidPosts: [],
        });
      },
    });
    await scheduler.jobs[0].handler();
    assertEquals(events, ["lease", "recovery:4000:900000", `run:${user.id}`]);
  });
});

test("scheduler skips an already-running user without logging a tick failure", async () => {
  clearDigestJobStateForTesting();
  await withTestDb(async (database: Database) => {
    await createUser(
      database,
      userInput("scheduler-conflict-first@example.com"),
    );
    await createUser(
      database,
      userInput("scheduler-conflict-second@example.com"),
    );
    const errors: string[] = [];
    let calls = 0;
    await runDigestTick(database, {
      now: () => 5_000,
      logError: (message) => errors.push(message),
      runForUser: (_database, userId, period) => {
        calls++;
        if (calls === 1) {
          return Promise.reject(new DigestRunAlreadyRunningError());
        }
        return Promise.resolve({
          digest: {
            id: "x",
            userId,
            periodStartMs: period.startMs,
            periodEndMs: period.endMs,
            status: "complete" as const,
            createdAt: 0,
            updatedAt: 0,
          },
          sections: [],
          groups: [],
          paidPosts: [],
        });
      },
    });
    assertEquals(calls, 2);
    assertEquals(errors, []);
  });
});
test("runDigestTick pages users and respects bounded concurrency", async () => {
  clearDigestJobStateForTesting();
  await withTestDb(async (database: Database) => {
    const users: User[] = [];
    for (let i = 0; i < 5; i++) {
      users.push(
        await createUser(
          database,
          userInput(`scheduler-page-${i}@example.com`),
        ),
      );
    }

    const calledUserIds = new Set<string>();
    let inFlight = 0;
    let maximumInFlight = 0;

    const fakeRunForUser = async (
      _database: Database,
      userId: string,
      _period: { startMs: number; endMs: number },
    ) => {
      calledUserIds.add(userId);
      inFlight++;
      maximumInFlight = Math.max(maximumInFlight, inFlight);
      await new Promise((r) => setTimeout(r, 5));
      inFlight--;
      return {
        digest: {
          id: "fake",
          userId,
          periodStartMs: 1,
          periodEndMs: 2,
          status: "complete" as const,
          createdAt: 1,
          updatedAt: 1,
        },
        sections: [],
        groups: [],
        paidPosts: [],
      };
    };

    await runDigestTick(database, {
      runForUser: fakeRunForUser,
      userPageSize: 2,
      userConcurrency: 2,
    });

    assertEquals(calledUserIds.size, 5);
    assertEquals(maximumInFlight <= 2, true);
  });
});

test("runDigestTick creates scheduled digest run records", async () => {
  clearDigestJobStateForTesting();
  await withTestDb(async (database: Database) => {
    const user = await createUser(
      database,
      userInput("scheduler-run-scheduled@example.com"),
    );

    await runDigestTick(database, {
      now: () => 1_000,
    });

    const runs = await listDigestRunsForUser(database, user.id);
    assertEquals(runs.length >= 1, true);
    assertEquals(runs[0].trigger, "scheduled");
  });
});
