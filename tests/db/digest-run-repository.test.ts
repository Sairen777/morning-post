import { assertEquals, assertRejects } from "@std/assert";
import { sql } from "drizzle-orm";
import { withTestDb } from "../../src/db/testing.ts";
import {
  createDigestRun,
  DigestRunAlreadyRunningError,
  finishDigestRun,
  finishDigestRunFeed,
  listDigestRunsForUser,
  recoverStaleDigestRuns,
  startDigestRunFeed,
  type CreateDigestRunInput,
} from "../../src/repositories/digest-run-repository.ts";
import { createUser, type CreateUserInput } from "../../src/repositories/user-repository.ts";

function userInput(overrides: Partial<CreateUserInput> = {}): CreateUserInput {
  return {
    name: "Test",
    email: "test@example.com",
    passwordHash: "$argon2id$fakehash",
    systemPrompt: "Summarize tersely.",
    defaultLanguage: "en",
    ...overrides,
  };
}

function runInput(
  userId: string,
  overrides: Partial<CreateDigestRunInput> = {},
): CreateDigestRunInput {
  return {
    userId,
    trigger: "manual",
    periodStartMs: 1_700_000_000_000,
    periodEndMs: 1_700_100_000_000,
    status: "running",
    ...overrides,
  };
}

/** Drizzle wraps Postgres errors; the constraint name lives on the PostgresError cause. */
function unwrapPostgresMessage(error: unknown): string {
  if (error instanceof Error) {
    if ("cause" in error && error.cause instanceof Error) {
      return error.cause.message;
    }
    return error.message;
  }
  return String(error);
}

Deno.test("createDigestRun round-trips all fields", async () => {
  await withTestDb(async (database) => {
    const user = await createUser(database, userInput());

    const run = await createDigestRun(database, runInput(user.id));

    assertEquals(run.userId, user.id);
    assertEquals(run.trigger, "manual");
    assertEquals(run.periodStartMs, 1_700_000_000_000);
    assertEquals(run.periodEndMs, 1_700_100_000_000);
    assertEquals(run.status, "running");
    assertEquals(run.digestId, null);
    assertEquals(run.finishedAt, null);
    assertEquals(run.errorMessage, null);

    assertEquals(typeof run.id, "string");
    assertEquals(typeof run.startedAt, "number");
    assertEquals(run.startedAt > 1_000_000_000_000, true, "startedAt should be epoch-ms");
  });
});

Deno.test("finishDigestRun sets finishedAt, status", async () => {
  await withTestDb(async (database) => {
    const user = await createUser(database, userInput());
    const run = await createDigestRun(database, runInput(user.id));

    const finished = await finishDigestRun(database, run.id, {
      status: "complete",
      errorMessage: null,
    });

    assertEquals(finished.id, run.id);
    assertEquals(finished.status, "complete");
    assertEquals(finished.digestId, null);
    assertEquals(typeof finished.finishedAt, "number");
    assertEquals(finished.finishedAt! >= run.startedAt, true, "finishedAt should be >= startedAt");
  });
});

Deno.test("finishDigestRun with partial status and errorMessage", async () => {
  await withTestDb(async (database) => {
    const user = await createUser(database, userInput());
    const run = await createDigestRun(database, runInput(user.id));

    const finished = await finishDigestRun(database, run.id, {
      status: "partial",
      errorMessage: "ingestion timeout on feed X",
    });

    assertEquals(finished.status, "partial");
    assertEquals(finished.errorMessage, "ingestion timeout on feed X");
    assertEquals(typeof finished.finishedAt, "number");
    assertEquals(finished.digestId, null);
  });
});

Deno.test("finishDigestRun of a missing id throws", async () => {
  await withTestDb(async (database) => {
    await assertRejects(
      () =>
        finishDigestRun(database, "00000000-0000-0000-0000-000000000099", {
          status: "complete",
        }),
      Error,
      "digest run not found",
    );
  });
});

Deno.test("startDigestRunFeed round-trips fields", async () => {
  await withTestDb(async (database) => {
    const user = await createUser(database, userInput());
    const run = await createDigestRun(database, runInput(user.id));

    const feedRun = await startDigestRunFeed(database, {
      runId: run.id,
      sourceId: null,
      feedId: null,
      connectorId: "Telegram",
      feedExternalId: "tg-channel-42",
      feedName: "Morning Updates",
      stage: "ingestion",
      status: "running",
      itemCount: null,
    });

    assertEquals(feedRun.runId, run.id);
    assertEquals(feedRun.sourceId, null);
    assertEquals(feedRun.feedId, null);
    assertEquals(feedRun.connectorId, "Telegram");
    assertEquals(feedRun.feedExternalId, "tg-channel-42");
    assertEquals(feedRun.feedName, "Morning Updates");
    assertEquals(feedRun.stage, "ingestion");
    assertEquals(feedRun.status, "running");
    assertEquals(feedRun.itemCount, null);
    assertEquals(feedRun.finishedAt, null);
    assertEquals(feedRun.errorMessage, null);

    assertEquals(typeof feedRun.id, "string");
    assertEquals(typeof feedRun.startedAt, "number");
    assertEquals(feedRun.startedAt > 1_000_000_000_000, true, "startedAt should be epoch-ms");
  });
});

Deno.test("finishDigestRunFeed sets finishedAt, status, itemCount", async () => {
  await withTestDb(async (database) => {
    const user = await createUser(database, userInput());
    const run = await createDigestRun(database, runInput(user.id));

    const feedRun = await startDigestRunFeed(database, {
      runId: run.id,
      sourceId: null,
      feedId: null,
      connectorId: "Telegram",
      stage: "ingestion",
      status: "running",
    });

    const finished = await finishDigestRunFeed(database, feedRun.id, {
      status: "complete",
      itemCount: 12,
    });

    assertEquals(finished.id, feedRun.id);
    assertEquals(finished.status, "complete");
    assertEquals(finished.itemCount, 12);
    assertEquals(typeof finished.finishedAt, "number");
    assertEquals(finished.finishedAt! >= feedRun.startedAt, true, "finishedAt should be >= startedAt");
  });
});

Deno.test("finishDigestRunFeed with failed status and errorMessage", async () => {
  await withTestDb(async (database) => {
    const user = await createUser(database, userInput());
    const run = await createDigestRun(database, runInput(user.id));

    const feedRun = await startDigestRunFeed(database, {
      runId: run.id,
      connectorId: "Telegram",
      feedName: "Failing Feed",
      stage: "connector",
      status: "running",
    });

    const finished = await finishDigestRunFeed(database, feedRun.id, {
      status: "failed",
      errorMessage: "connector unavailable",
    });

    assertEquals(finished.status, "failed");
    assertEquals(finished.errorMessage, "connector unavailable");
    assertEquals(typeof finished.finishedAt, "number");
    assertEquals(finished.itemCount, null);
  });
});

Deno.test("finishDigestRunFeed of a missing id throws", async () => {
  await withTestDb(async (database) => {
    await assertRejects(
      () =>
        finishDigestRunFeed(
          database,
          "00000000-0000-0000-0000-000000000099",
          { status: "complete" },
        ),
      Error,
      "digest run feed not found",
    );
  });
});

Deno.test("listDigestRunsForUser returns only that user's runs, ordered desc", async () => {
  await withTestDb(async (database) => {
    const alice = await createUser(database, userInput({ email: "alice@example.com" }));
    const bob = await createUser(database, userInput({ email: "bob@example.com" }));

    const aliceRun1 = await createDigestRun(database, runInput(alice.id, { status: "complete" }), 1000);
    const bobRun = await createDigestRun(database, runInput(bob.id), 2000);
    const aliceRun2 = await createDigestRun(database, runInput(alice.id), 3000);

    const aliceRuns = await listDigestRunsForUser(database, alice.id);
    const bobRuns = await listDigestRunsForUser(database, bob.id);

    assertEquals(aliceRuns.length, 2);
    assertEquals(bobRuns.length, 1);

    assertEquals(aliceRuns[0].id, aliceRun2.id);
    assertEquals(aliceRuns[1].id, aliceRun1.id);
    assertEquals(bobRuns[0].id, bobRun.id);

    for (const r of aliceRuns) {
      assertEquals(r.userId, alice.id);
    }
  });
});

Deno.test("listDigestRunsForUser respects limit", async () => {
  await withTestDb(async (database) => {
    const user = await createUser(database, userInput());

    await createDigestRun(database, runInput(user.id, { status: "complete" }));
    await createDigestRun(database, runInput(user.id, { status: "partial" }));
    await createDigestRun(database, runInput(user.id, { status: "failed" }));

    const limited = await listDigestRunsForUser(database, user.id, { limit: 2 });
    assertEquals(limited.length, 2);
  });
});

Deno.test("createDigestRun surfaces a typed conflict for an active run", async () => {
  await withTestDb(async (database) => {
    const user = await createUser(database, userInput({ email: "active-run@example.com" }));
    await createDigestRun(database, runInput(user.id), 1_000);

    await assertRejects(
      () => createDigestRun(database, runInput(user.id), 2_000),
      DigestRunAlreadyRunningError,
      "digest already running",
    );
  });
});

Deno.test("recoverStaleDigestRuns fails old runs once and is idempotent", async () => {
  await withTestDb(async (database) => {
    const user = await createUser(database, userInput({ email: "stale-run@example.com" }));
    const stale = await createDigestRun(database, runInput(user.id), 1_000);

    const recovered = await recoverStaleDigestRuns(database, 10_000, 5_000);
    assertEquals(recovered, 1);
    const repeated = await recoverStaleDigestRuns(database, 10_000, 5_000);
    assertEquals(repeated, 0);

    const [run] = await listDigestRunsForUser(database, user.id);
    assertEquals(run.id, stale.id);
    assertEquals(run.status, "failed");
    assertEquals(run.finishedAt, 10_000);
    assertEquals(run.errorMessage, "digest run lease expired");
  });
});

Deno.test("invalid digest run status insert is rejected at DB level", async () => {
  await withTestDb(async (database) => {
    const user = await createUser(database, userInput());

    try {
      await database.execute(sql`
        insert into digest_runs
          (user_id, trigger, period_start_ms, period_end_ms, status, started_at)
        values
          (${user.id}, 'manual', 1, 2, 'bogus', ${Date.now()})
      `);
      throw new Error("expected insert to fail");
    } catch (error) {
      const msg = unwrapPostgresMessage(error);
      assertEquals(msg.includes("digest_runs_status_check"), true,
        `expected status check violation, got: ${msg}`);
    }
  });
});

Deno.test("invalid digest run trigger insert is rejected at DB level", async () => {
  await withTestDb(async (database) => {
    const user = await createUser(database, userInput());

    try {
      await database.execute(sql`
        insert into digest_runs
          (user_id, trigger, period_start_ms, period_end_ms, status, started_at)
        values
          (${user.id}, 'bogus_trigger', 1, 2, 'running', ${Date.now()})
      `);
      throw new Error("expected insert to fail");
    } catch (error) {
      const msg = unwrapPostgresMessage(error);
      assertEquals(msg.includes("digest_runs_trigger_check"), true,
        `expected trigger check violation, got: ${msg}`);
    }
  });
});

Deno.test("invalid digest run feed stage insert is rejected at DB level", async () => {
  await withTestDb(async (database) => {
    const user = await createUser(database, userInput());
    const run = await createDigestRun(database, runInput(user.id));

    try {
      await database.execute(sql`
        insert into digest_run_feeds
          (run_id, connector_id, stage, status, started_at)
        values
          (${run.id}, 'Telegram', 'bogus_stage', 'running', ${Date.now()})
      `);
      throw new Error("expected insert to fail");
    } catch (error) {
      const msg = unwrapPostgresMessage(error);
      assertEquals(msg.includes("digest_run_feeds_stage_check"), true,
        `expected stage check violation, got: ${msg}`);
    }
  });
});

Deno.test("invalid digest run feed status insert is rejected at DB level", async () => {
  await withTestDb(async (database) => {
    const user = await createUser(database, userInput());
    const run = await createDigestRun(database, runInput(user.id));

    try {
      await database.execute(sql`
        insert into digest_run_feeds
          (run_id, connector_id, stage, status, started_at)
        values
          (${run.id}, 'Telegram', 'ingestion', 'bogus_status', ${Date.now()})
      `);
      throw new Error("expected insert to fail");
    } catch (error) {
      const msg = unwrapPostgresMessage(error);
      assertEquals(msg.includes("digest_run_feeds_status_check"), true,
        `expected status check violation, got: ${msg}`);
    }
  });
});

Deno.test("period order constraint rejects start > end", async () => {
  await withTestDb(async (database) => {
    const user = await createUser(database, userInput());

    try {
      await database.execute(sql`
        insert into digest_runs
          (user_id, trigger, period_start_ms, period_end_ms, status, started_at)
        values
          (${user.id}, 'manual', 200, 100, 'running', ${Date.now()})
      `);
      throw new Error("expected insert to fail");
    } catch (error) {
      const msg = unwrapPostgresMessage(error);
      assertEquals(msg.includes("digest_runs_period_order_check"), true,
        `expected period order violation, got: ${msg}`);
    }
  });
});
