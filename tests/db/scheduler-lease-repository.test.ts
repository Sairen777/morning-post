import { test } from "bun:test";
import { assertEquals } from "../assertions.ts"
import { sql } from "drizzle-orm";
import type { Database } from "../../src/db/client.ts";
import { withTestDb } from "../../src/db/testing.ts";
import { tryAcquireSchedulerLease } from "../../src/repositories/scheduler-lease-repository.ts";

test("scheduler lease schema has the fixed lease fields", async () => {
  await withTestDb(async (database: Database) => {
    const rows = await database.execute(sql`
      select column_name, data_type
      from information_schema.columns
      where table_schema = 'public' and table_name = 'scheduler_leases'
      order by ordinal_position
    `);
    assertEquals(rows.map((row) => [row.column_name, row.data_type]), [
      ["name", "text"],
      ["owner_id", "text"],
      ["expires_at", "bigint"],
    ]);

    const primaryKey = await database.execute(sql`
      select 1
      from pg_constraint
      where conrelid = 'scheduler_leases'::regclass
        and contype = 'p'
        and conname = 'scheduler_leases_pkey'
    `);
    assertEquals(primaryKey.length, 1);
  });
});

test("scheduler lease acquisition elects exactly one concurrent worker", async () => {
  await withTestDb(async (database: Database) => {
    const results = await Promise.all([
      tryAcquireSchedulerLease(database, "digest-job", "worker-a", 1_000, 90_000),
      tryAcquireSchedulerLease(database, "digest-job", "worker-b", 1_000, 90_000),
    ]);
    assertEquals(results.filter(Boolean).length, 1);
  });
});

test("scheduler lease acquisition replaces an expired owner", async () => {
  await withTestDb(async (database: Database) => {
    await database.execute(sql`
      insert into scheduler_leases (name, owner_id, expires_at)
      values ('digest-job', 'old-worker', 1_000)
    `);

    assertEquals(
      await tryAcquireSchedulerLease(database, "digest-job", "new-worker", 1_001, 90_000),
      true,
    );
    const rows = await database.execute(sql`
      select owner_id, expires_at
      from scheduler_leases
      where name = 'digest-job'
    `);
    const row = rows[0] as { owner_id: string; expires_at: number };
    assertEquals(row.owner_id, "new-worker");
    assertEquals(Number(row.expires_at), 91_001);
  });
});

test("scheduler lease acquisition rejects a non-expired owner", async () => {
  await withTestDb(async (database: Database) => {
    await database.execute(sql`
      insert into scheduler_leases (name, owner_id, expires_at)
      values ('digest-job', 'current-worker', 2_000)
    `);

    assertEquals(
      await tryAcquireSchedulerLease(database, "digest-job", "other-worker", 1_999, 90_000),
      false,
    );
    const rows = await database.execute(sql`
      select owner_id, expires_at
      from scheduler_leases
      where name = 'digest-job'
    `);
    const row = rows[0] as { owner_id: string; expires_at: number };
    assertEquals(row.owner_id, "current-worker");
    assertEquals(Number(row.expires_at), 2_000);
  });
});
