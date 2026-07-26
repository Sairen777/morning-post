import { test } from "bun:test";
import { assertEquals } from "../assertions.ts";
import { withTestDb } from "../../src/db/testing.ts";
import type { Database } from "../../src/db/client.ts";
import {
  createUser,
  type CreateUserInput,
} from "../../src/repositories/user-repository.ts";
import {
  DigestRunAlreadyRunningError,
  listDigestRunsForUser,
} from "../../src/repositories/digest-run-repository.ts";
import { upsertDigestForPeriod } from "../../src/repositories/digest-repository.ts";
import type { DigestView } from "../../src/services/digest-service.ts";
import {
  computeDigestPeriod,
  DEFAULT_DIGEST_CRON,
  MEDIA_HOUSEKEEPING_CRON,
  runDigestTick,
  scheduleDigestJob,
  scheduleMediaHousekeeping,
} from "../../src/scheduler/digest-job.ts";
import type { Scheduler } from "../../src/scheduler/scheduler.ts";
import type { SummarizerService } from "../../src/summarizers/summarizer.types.ts";
import type { DigestProgressReporter } from "../../src/services/digest-progress.ts";

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

function completedDigest(
  userId: string,
  period: { startMs: number; endMs: number },
): DigestView {
  return {
    digest: {
      id: "digest-id",
      userId,
      periodStartMs: period.startMs,
      periodEndMs: period.endMs,
      status: "complete",
      contentMode: "stories",
      createdAt: 0,
      updatedAt: 0,
    },
    stories: [],
    sections: [],
    groups: [],
    paidPosts: [],
    failureReason: null,
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

test("runDigestTick is a successful no-op when no owner exists", async () => {
  await withTestDb(async (database: Database) => {
    const events: string[] = [];

    await runDigestTick(database, {
      recoverStaleRuns: () => {
        events.push("recovery");
        return Promise.resolve(0);
      },
      runForUser: () => {
        events.push("run");
        return Promise.reject(new Error("owner must not run"));
      },
    });

    assertEquals(events, ["recovery"]);
  });
});

test("runDigestTick executes only the earliest owner", async () => {
  await withTestDb(async (database: Database) => {
    const users = await Promise.all([
      createUser(database, userInput("scheduler-owner-a@example.com")),
      createUser(database, userInput("scheduler-owner-b@example.com")),
      createUser(database, userInput("scheduler-owner-c@example.com")),
    ]);
    const expectedOwner = [...users].sort((left, right) =>
      left.createdAt - right.createdAt || left.id.localeCompare(right.id)
    )[0];
    const calledUserIds: string[] = [];

    await runDigestTick(database, {
      now: () => 1_000,
      cadenceMs: 100,
      runForUser: (_database, userId, period) => {
        calledUserIds.push(userId);
        return Promise.resolve(completedDigest(userId, period));
      },
    });

    assertEquals(calledUserIds, [expectedOwner.id]);
  });
});

test("runDigestTick recovers stale runs before resolving the owner", async () => {
  await withTestDb(async (database: Database) => {
    const events: string[] = [];
    let recoveredOwnerId: string | undefined;
    let nowCalls = 0;

    await runDigestTick(database, {
      now: () => 4_000 + nowCalls++,
      digestRunStaleAfterMs: 321,
      cadenceMs: 100,
      recoverStaleRuns: async (_database, now, staleAfterMs) => {
        events.push(`recovery:${now}:${staleAfterMs}`);
        const owner = await createUser(
          database,
          userInput("scheduler-recovered-owner@example.com"),
        );
        recoveredOwnerId = owner.id;
        return 0;
      },
      runForUser: (_database, userId, period) => {
        events.push(`run:${userId}:${period.startMs}:${period.endMs}`);
        return Promise.resolve(completedDigest(userId, period));
      },
    });

    assertEquals(events, [
      "recovery:4000:321",
      `run:${recoveredOwnerId}:3901:4000`,
    ]);
    assertEquals(nowCalls, 1);
  });
});

test("runDigestTick isolates and sanitizes owner execution errors", async () => {
  await withTestDb(async (database: Database) => {
    const owner = await createUser(
      database,
      userInput("scheduler-error-owner@example.com"),
    );
    const errors: string[] = [];

    await runDigestTick(database, {
      now: () => 1_000,
      logError: (message) => errors.push(message),
      runForUser: () => Promise.reject(
        new Error(
          "provider failed sk-scheduler-secret at https://scheduler-user:scheduler-pass@example.com",
        ),
      ),
    });

    assertEquals(errors.length, 1);
    assertEquals(errors[0].includes(owner.id), true);
    assertEquals(errors[0].includes("provider failed"), true);
    assertEquals(errors[0].includes("sk-scheduler-secret"), false);
    assertEquals(errors[0].includes("scheduler-user:scheduler-pass"), false);
    assertEquals(errors[0].includes("[REDACTED]"), true);
  });
});

test("runDigestTick ignores the active-run uniqueness conflict", async () => {
  await withTestDb(async (database: Database) => {
    await createUser(
      database,
      userInput("scheduler-conflict-owner@example.com"),
    );
    const errors: string[] = [];
    let calls = 0;

    await runDigestTick(database, {
      logError: (message) => errors.push(message),
      runForUser: () => {
        calls += 1;
        return Promise.reject(new DigestRunAlreadyRunningError());
      },
    });

    assertEquals(calls, 1);
    assertEquals(errors, []);
  });
});

test("scheduleDigestJob registers the default cron and executes its owner", async () => {
  await withTestDb(async (database: Database) => {
    const owner = await createUser(
      database,
      userInput("scheduler-scheduled-owner@example.com"),
    );
    const scheduler = new FakeScheduler();
    const calls: string[] = [];

    scheduleDigestJob(scheduler, database, {
      now: () => 1_000,
      runForUser: (_database, userId, period) => {
        calls.push(userId);
        return Promise.resolve(completedDigest(userId, period));
      },
    });

    assertEquals(scheduler.jobs.length, 1);
    assertEquals(scheduler.jobs[0].name, "digest-job");
    assertEquals(scheduler.jobs[0].cron, DEFAULT_DIGEST_CRON);

    await scheduler.jobs[0].handler();
    assertEquals(calls, [owner.id]);
  });
});

test("runDigestTick forwards shared digest dependencies to scheduled execution", async () => {
  await withTestDb(async (database: Database) => {
    const sharedSummarizer = {} as SummarizerService;
    const progressReporter = { report: () => {} } satisfies DigestProgressReporter;
    let receivedSummarizer: SummarizerService | undefined;
    let receivedTimeoutMs: number | undefined;
    let receivedSummarizationConcurrency: number | undefined;
    let receivedProgressReporter: DigestProgressReporter | undefined;
    await createUser(
      database,
      userInput("scheduler-shared-summarizer@example.com"),
    );

    await runDigestTick(database, {
      summarizer: sharedSummarizer,
      timeoutMs: 37_000,
      summarizationConcurrency: 6,
      progressReporter,
      now: () => 1_500,
      runForUser: (_database, userId, period, dependencies = {}) => {
        receivedSummarizer = dependencies.summarizer;
        receivedTimeoutMs = dependencies.timeoutMs;
        receivedSummarizationConcurrency = dependencies.summarizationConcurrency;
        receivedProgressReporter = dependencies.progressReporter;
        return Promise.resolve(completedDigest(userId, period));
      },
    });

    assertEquals(receivedSummarizer, sharedSummarizer);
    assertEquals(receivedTimeoutMs, 37_000);
    assertEquals(receivedSummarizationConcurrency, 6);
    assertEquals(receivedProgressReporter, progressReporter);
  });
});

test("runDigestTick creates scheduled digest run records", async () => {
  await withTestDb(async (database: Database) => {
    const owner = await createUser(
      database,
      userInput("scheduler-run-record-owner@example.com"),
    );

    await runDigestTick(database, { now: () => 1_000 });

    const runs = await listDigestRunsForUser(database, owner.id);
    assertEquals(runs.length >= 1, true);
    assertEquals(runs[0].trigger, "scheduled");
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
