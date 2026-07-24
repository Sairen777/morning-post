import { test } from "bun:test";
import { assertEquals, assertRejects } from "../assertions.ts"
import { sql } from "drizzle-orm";
import { withTestDb } from "../../src/db/testing.ts";
import {
  createDigestRun,
  type CreateDigestRunInput,
  DigestRunAlreadyRunningError,
  finishDigestRun,
  findNewestDigestRunByDigestIdForUser,
  finishDigestRunFeed,
  listDigestRunFeedsForRun,
  listDigestRunsForUser,
  recoverStaleDigestRuns,
  startDigestRunFeed,
} from "../../src/repositories/digest-run-repository.ts";
import { upsertDigestForPeriod } from "../../src/repositories/digest-repository.ts";
import {
  createUser,
  type CreateUserInput,
} from "../../src/repositories/user-repository.ts";

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

test("createDigestRun round-trips all fields", async () => {
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
    assertEquals(
      run.startedAt > 1_000_000_000_000,
      true,
      "startedAt should be epoch-ms",
    );
  });
});

test("finishDigestRun sets finishedAt, status", async () => {
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
    assertEquals(
      finished.finishedAt! >= run.startedAt,
      true,
      "finishedAt should be >= startedAt",
    );
  });
});

test("finishDigestRun with partial status and errorMessage", async () => {
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

test("findNewestDigestRunByDigestIdForUser scopes exact links to the owner", async () => {
  await withTestDb(async (database) => {
    const owner = await createUser(database, userInput());
    const other = await createUser(database, userInput({
      email: "other@example.com",
    }));
    const digest = await upsertDigestForPeriod(database, {
      userId: owner.id,
      periodStartMs: 100,
      periodEndMs: 200,
      status: "failed",
    }, 200);
    const older = await createDigestRun(database, runInput(owner.id), 1_000);
    await finishDigestRun(database, older.id, {
      digestId: digest.id,
      status: "failed",
      errorMessage: "older",
    }, 1_001);
    const newest = await createDigestRun(database, runInput(owner.id), 2_000);
    await finishDigestRun(database, newest.id, {
      digestId: digest.id,
      status: "failed",
      errorMessage: "newest",
    }, 2_001);
    const otherRun = await createDigestRun(database, runInput(other.id), 3_000);
    await finishDigestRun(database, otherRun.id, {
      digestId: digest.id,
      status: "failed",
      errorMessage: "other owner",
    }, 3_001);

    assertEquals(
      (await findNewestDigestRunByDigestIdForUser(
        database,
        owner.id,
        digest.id,
      ))?.id,
      newest.id,
    );
    assertEquals(
      await findNewestDigestRunByDigestIdForUser(
        database,
        owner.id,
        "00000000-0000-0000-0000-000000000099",
      ),
      null,
    );
  });
});

test("findNewestDigestRunByDigestIdForUser deterministically breaks startedAt ties", async () => {
  await withTestDb(async (database) => {
    const owner = await createUser(database, userInput());
    const digest = await upsertDigestForPeriod(database, {
      userId: owner.id,
      periodStartMs: 100,
      periodEndMs: 200,
      status: "failed",
    }, 200);
    const olderFinished = await createDigestRun(
      database,
      runInput(owner.id, { status: "failed" }),
      1_000,
    );
    await finishDigestRun(database, olderFinished.id, {
      digestId: digest.id,
      status: "failed",
      errorMessage: "older finish",
    }, 1_001);
    const newerFinished = await createDigestRun(
      database,
      runInput(owner.id, { status: "failed" }),
      1_000,
    );
    await finishDigestRun(database, newerFinished.id, {
      digestId: digest.id,
      status: "failed",
      errorMessage: "newer finish",
    }, 1_002);
    const unfinished = await createDigestRun(database, runInput(owner.id), 1_000);
    await database.execute(sql`
      update digest_runs
      set digest_id = ${digest.id}
      where id = ${unfinished.id}
    `);

    assertEquals(
      (await findNewestDigestRunByDigestIdForUser(
        database,
        owner.id,
        digest.id,
      ))?.id,
      newerFinished.id,
    );
  });
});

test("finishDigestRun of a missing id throws", async () => {
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

test("startDigestRunFeed round-trips fields", async () => {
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
    assertEquals(
      feedRun.startedAt > 1_000_000_000_000,
      true,
      "startedAt should be epoch-ms",
    );
  });
});

test("finishDigestRunFeed sets finishedAt, status, itemCount", async () => {
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
    assertEquals(
      finished.finishedAt! >= feedRun.startedAt,
      true,
      "finishedAt should be >= startedAt",
    );
  });
});

test("finishDigestRunFeed with failed status and errorMessage", async () => {
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

test("finishDigestRunFeed of a missing id throws", async () => {
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

test("listDigestRunsForUser returns only that user's runs, ordered desc", async () => {
  await withTestDb(async (database) => {
    const alice = await createUser(
      database,
      userInput({ email: "alice@example.com" }),
    );
    const bob = await createUser(
      database,
      userInput({ email: "bob@example.com" }),
    );

    const aliceRun1 = await createDigestRun(
      database,
      runInput(alice.id, { status: "complete" }),
      1000,
    );
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

test("listDigestRunsForUser respects limit", async () => {
  await withTestDb(async (database) => {
    const user = await createUser(database, userInput());

    await createDigestRun(database, runInput(user.id, { status: "complete" }));
    await createDigestRun(database, runInput(user.id, { status: "partial" }));
    await createDigestRun(database, runInput(user.id, { status: "failed" }));

    const limited = await listDigestRunsForUser(database, user.id, {
      limit: 2,
    });
    assertEquals(limited.length, 2);
  });
});

test("createDigestRun surfaces a typed conflict for an active run", async () => {
  await withTestDb(async (database) => {
    const user = await createUser(
      database,
      userInput({ email: "active-run@example.com" }),
    );
    await createDigestRun(database, runInput(user.id), 1_000);

    await assertRejects(
      () => createDigestRun(database, runInput(user.id), 2_000),
      DigestRunAlreadyRunningError,
      "digest already running",
    );
  });
});

test("recoverStaleDigestRuns atomically fails only stale runs and their running stages", async () => {
  await withTestDb(async (database) => {
    const staleUser = await createUser(
      database,
      userInput({ email: "stale-run@example.com" }),
    );
    const freshUser = await createUser(
      database,
      userInput({ email: "fresh-run@example.com" }),
    );
    const terminalUser = await createUser(
      database,
      userInput({ email: "terminal-run@example.com" }),
    );
    const staleRun = await createDigestRun(
      database,
      runInput(staleUser.id),
      1_000,
    );
    const freshRun = await createDigestRun(
      database,
      runInput(freshUser.id),
      5_000,
    );
    const terminalRun = await createDigestRun(
      database,
      runInput(terminalUser.id, { status: "complete" }),
      2_000,
    );

    const staleRunningStage = await startDigestRunFeed(database, {
      runId: staleRun.id,
      connectorId: "stale-running-connector",
      stage: "ingestion",
      status: "running",
    }, 3_000);
    const staleCompletedStage = await startDigestRunFeed(database, {
      runId: staleRun.id,
      connectorId: "stale-completed-connector",
      stage: "summarization",
      status: "running",
    }, 3_100);
    const staleCompletedStageBeforeRecovery = await finishDigestRunFeed(
      database,
      staleCompletedStage.id,
      { status: "complete", itemCount: 7 },
      4_000,
    );
    const freshRunningStage = await startDigestRunFeed(database, {
      runId: freshRun.id,
      connectorId: "fresh-running-connector",
      stage: "summarization",
      status: "running",
    }, 5_100);
    const terminalRunStage = await startDigestRunFeed(database, {
      runId: terminalRun.id,
      connectorId: "terminal-run-connector",
      stage: "connector",
      status: "running",
    }, 2_100);

    const recoveryTime = 10_000;
    const staleAfterMs = 5_000;
    assertEquals(
      await recoverStaleDigestRuns(database, recoveryTime, staleAfterMs),
      1,
    );
    assertEquals(
      await recoverStaleDigestRuns(database, recoveryTime, staleAfterMs),
      0,
    );

    const [recoveredRun] = await listDigestRunsForUser(database, staleUser.id);
    assertEquals(recoveredRun.id, staleRun.id);
    assertEquals(recoveredRun.status, "failed");
    assertEquals(recoveredRun.finishedAt, recoveryTime);
    assertEquals(recoveredRun.errorMessage, "digest run lease expired");

    const staleStages = await listDigestRunFeedsForRun(
      database,
      staleRun.id,
      staleUser.id,
    );
    const recoveredRunningStage = staleStages.find(
      (stage) => stage.id === staleRunningStage.id,
    );
    const unchangedCompletedStage = staleStages.find(
      (stage) => stage.id === staleCompletedStage.id,
    );
    assertEquals(recoveredRunningStage?.status, "failed");
    assertEquals(recoveredRunningStage?.finishedAt, recoveryTime);
    assertEquals(
      recoveredRunningStage?.errorMessage,
      "digest run lease expired",
    );
    assertEquals(unchangedCompletedStage, staleCompletedStageBeforeRecovery);

    const [unchangedFreshRun] = await listDigestRunsForUser(
      database,
      freshUser.id,
    );
    assertEquals(unchangedFreshRun, freshRun);
    const freshStages = await listDigestRunFeedsForRun(
      database,
      freshRun.id,
      freshUser.id,
    );
    assertEquals(freshStages, [freshRunningStage]);

    const [unchangedTerminalRun] = await listDigestRunsForUser(
      database,
      terminalUser.id,
    );
    assertEquals(unchangedTerminalRun, terminalRun);
    const terminalRunStages = await listDigestRunFeedsForRun(
      database,
      terminalRun.id,
      terminalUser.id,
    );
    assertEquals(terminalRunStages, [terminalRunStage]);

    const nextRun = await createDigestRun(
      database,
      runInput(staleUser.id),
      recoveryTime + 1,
    );
    assertEquals(nextRun.status, "running");
  });
});

test("invalid digest run status insert is rejected at DB level", async () => {
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
      assertEquals(
        msg.includes("digest_runs_status_check"),
        true,
        `expected status check violation, got: ${msg}`,
      );
    }
  });
});

test("invalid digest run trigger insert is rejected at DB level", async () => {
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
      assertEquals(
        msg.includes("digest_runs_trigger_check"),
        true,
        `expected trigger check violation, got: ${msg}`,
      );
    }
  });
});

test("invalid digest run feed stage insert is rejected at DB level", async () => {
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
      assertEquals(
        msg.includes("digest_run_feeds_stage_check"),
        true,
        `expected stage check violation, got: ${msg}`,
      );
    }
  });
});

test("invalid digest run feed status insert is rejected at DB level", async () => {
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
      assertEquals(
        msg.includes("digest_run_feeds_status_check"),
        true,
        `expected status check violation, got: ${msg}`,
      );
    }
  });
});

test("period order constraint rejects start > end", async () => {
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
      assertEquals(
        msg.includes("digest_runs_period_order_check"),
        true,
        `expected period order violation, got: ${msg}`,
      );
    }
  });
});
