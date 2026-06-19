import { assertEquals } from "@std/assert";
import { withTestDb } from "../../src/db/testing.ts";
import type { Database } from "../../src/db/client.ts";
import { createUser, type CreateUserInput, type User } from "../../src/repositories/user-repository.ts";
import { upsertDigestForPeriod } from "../../src/repositories/digest-repository.ts";
import { clearDigestJobStateForTesting, computeDigestPeriod, DEFAULT_DIGEST_CRON, runDigestTick, scheduleDigestJob } from "../../src/scheduler/digest-job.ts";
import type { Scheduler } from "../../src/scheduler/scheduler.ts";

class FakeScheduler implements Scheduler {
  jobs: Array<{ name: string; cron: string; handler: () => Promise<void> | void }> = [];

  schedule(name: string, cron: string, handler: () => Promise<void> | void): void {
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
    defaultModel: "gpt-4o-mini",
  };
}

Deno.test("computeDigestPeriod starts from latest digest end or default cadence", async () => {
  await withTestDb(async (database: Database) => {
    const firstUser = await createUser(database, userInput("scheduler-first@example.com"));
    const secondUser = await createUser(database, userInput("scheduler-second@example.com"));
    await upsertDigestForPeriod(database, {
      userId: secondUser.id,
      periodStartMs: 100,
      periodEndMs: 200,
      status: "complete",
    }, 10);

    assertEquals(await computeDigestPeriod(database, firstUser.id, 1_000, 100), { startMs: 901, endMs: 1_000 });
    assertEquals(await computeDigestPeriod(database, secondUser.id, 1_000, 100), { startMs: 201, endMs: 1_000 });
  });
});

Deno.test("runDigestTick triggers one run per user and isolates errors", async () => {
  clearDigestJobStateForTesting();
  await withTestDb(async (database: Database) => {
    const firstUser = await createUser(database, userInput("scheduler-run-first@example.com"));
    await createUser(database, userInput("scheduler-run-second@example.com"));
    const calls: Array<{ userId: string; period: { startMs: number; endMs: number } }> = [];
    const errors: string[] = [];

    await runDigestTick(database, {
      now: () => 1_000,
      logError: (message) => errors.push(message),
      runForUser: (_database, userId, period) => {
        calls.push({ userId, period });
        if (userId === firstUser.id) {
          throw new Error("boom");
        }
        return Promise.resolve({ digest: { id: "x", userId, periodStartMs: period.startMs, periodEndMs: period.endMs, status: "complete", createdAt: 0, updatedAt: 0 }, sections: [], groups: [] });
      },
    });

    assertEquals(calls.length, 2);
    assertEquals(calls[0].period.endMs, 1_000);
    assertEquals(errors.length, 1);
    assertEquals(errors[0].includes(firstUser.id), true);
    assertEquals(errors[0].includes("boom"), true);
  });
});

Deno.test("runDigestTick skips users that are already running", async () => {
  clearDigestJobStateForTesting();
  await withTestDb(async (database: Database) => {
    const user = await createUser(database, userInput("scheduler-overlap@example.com"));
    const gate = Promise.withResolvers<void>();
    let calls = 0;

    const firstTick = runDigestTick(database, {
      now: () => 1_000,
      runForUser: async () => {
        calls += 1;
        await gate.promise;
        return { digest: { id: "x", userId: user.id, periodStartMs: 0, periodEndMs: 0, status: "complete", createdAt: 0, updatedAt: 0 }, sections: [], groups: [] };
      },
    });
    const secondTick = runDigestTick(database, {
      now: () => 1_000,
      runForUser: () => {
        calls += 1;
        return Promise.resolve({ digest: { id: "x", userId: user.id, periodStartMs: 0, periodEndMs: 0, status: "complete", createdAt: 0, updatedAt: 0 }, sections: [], groups: [] });
      },
    });

    await Promise.resolve();
    gate.resolve();
    await Promise.all([firstTick, secondTick]);
    assertEquals(calls, 1);
  });
});

Deno.test("scheduleDigestJob registers the default cron and handler", async () => {
  clearDigestJobStateForTesting();
  await withTestDb(async (database: Database) => {
    const scheduler = new FakeScheduler();
    const calls: string[] = [];

    scheduleDigestJob(scheduler, database, {
      now: () => 1_000,
      runForUser: (_database, userId) => {
        calls.push(userId);
        return Promise.resolve({ digest: { id: "x", userId, periodStartMs: 0, periodEndMs: 0, status: "complete", createdAt: 0, updatedAt: 0 }, sections: [], groups: [] });
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

Deno.test("runDigestTick pages users and respects bounded concurrency", async () => {
  clearDigestJobStateForTesting();
  await withTestDb(async (database: Database) => {
    const users: User[] = [];
    for (let i = 0; i < 5; i++) {
      users.push(await createUser(database, userInput(`scheduler-page-${i}@example.com`)));
    }

    const calledUserIds = new Set<string>();
    let inFlight = 0;
    let maximumInFlight = 0;

    const fakeRunForUser = async (_database: Database, userId: string, _period: { startMs: number; endMs: number }) => {
      calledUserIds.add(userId);
      inFlight++;
      maximumInFlight = Math.max(maximumInFlight, inFlight);
      await new Promise((r) => setTimeout(r, 5));
      inFlight--;
      return {
        digest: { id: "fake", userId, periodStartMs: 1, periodEndMs: 2, status: "complete" as const, createdAt: 1, updatedAt: 1 },
        sections: [],
        groups: [],
      };
    };

    await runDigestTick(database, { runForUser: fakeRunForUser, userPageSize: 2, userConcurrency: 2 });

    assertEquals(calledUserIds.size, 5);
    assertEquals(maximumInFlight <= 2, true);
  });
});
