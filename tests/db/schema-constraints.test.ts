import { test } from "bun:test";
import { assertEquals, assertRejects } from "../assertions.ts"
import { sql } from "drizzle-orm";
import type { Database } from "../../src/db/client.ts";
import { withTestDb } from "../../src/db/testing.ts";

async function indexExists(
  database: Database,
  name: string,
): Promise<boolean> {
  const rows = await database.execute(
    sql`select 1 from pg_indexes where indexname = ${name} limit 1`,
  );
  return rows.length === 1;
}

async function constraintExists(
  database: Database,
  tableName: string,
  constraintName: string,
): Promise<boolean> {
  const rows = await database.execute(
    sql`select 1
        from pg_constraint c
        join pg_class t on c.conrelid = t.oid
        where c.conname = ${constraintName}
          and t.relname = ${tableName}
        limit 1`,
  );
  return rows.length === 1;
}

test("database schema exposes required performance indexes", async () => {
  await withTestDb(async (database) => {
    assertEquals(
      await indexExists(database, "sessions_token_hash_unique"),
      true,
      "sessions_token_hash_unique should exist",
    );
    assertEquals(
      await indexExists(database, "items_feed_date_external_id_idx"),
      true,
      "items_feed_date_external_id_idx should exist",
    );
    assertEquals(
      await indexExists(database, "digests_user_latest_idx"),
      true,
      "digests_user_latest_idx should exist",
    );
    assertEquals(
      await indexExists(database, "users_created_at_id_idx"),
      true,
      "users_created_at_id_idx should exist",
    );
    assertEquals(
      await indexExists(database, "sources_user_id_idx"),
      true,
      "sources_user_id_idx should exist",
    );
    assertEquals(
      await indexExists(database, "feeds_source_id_idx"),
      true,
      "feeds_source_id_idx should exist",
    );
    assertEquals(
      await indexExists(database, "feeds_source_order_idx"),
      true,
      "feeds_source_order_idx should exist",
    );
  });
});

test("database schema rejects invalid persisted states", async () => {
  await withTestDb(async (database) => {
    assertEquals(
      await constraintExists(
        database,
        "sources",
        "sources_credentials_disabled_check",
      ),
      true,
      "sources_credentials_disabled_check should exist on sources",
    );
    assertEquals(
      await constraintExists(database, "feeds", "feeds_kind_check"),
      true,
      "feeds_kind_check should exist on feeds",
    );
    assertEquals(
      await constraintExists(database, "digests", "digests_status_check"),
      true,
      "digests_status_check should exist on digests",
    );
    assertEquals(
      await constraintExists(
        database,
        "digests",
        "digests_period_order_check",
      ),
      true,
      "digests_period_order_check should exist on digests",
    );
    assertEquals(
      await constraintExists(
        database,
        "summaries",
        "summaries_period_order_check",
      ),
      true,
      "summaries_period_order_check should exist on summaries",
    );
    assertEquals(
      await constraintExists(
        database,
        "sources",
        "sources_connector_id_check",
      ),
      true,
      "sources_connector_id_check should exist on sources",
    );
    assertEquals(
      await constraintExists(
        database,
        "digest_runs",
        "digest_runs_status_check",
      ),
      true,
      "digest_runs_status_check should exist on digest_runs",
    );
    assertEquals(
      await constraintExists(
        database,
        "digest_runs",
        "digest_runs_trigger_check",
      ),
      true,
      "digest_runs_trigger_check should exist on digest_runs",
    );
    assertEquals(
      await constraintExists(
        database,
        "digest_run_feeds",
        "digest_run_feeds_stage_check",
      ),
      true,
      "digest_run_feeds_stage_check should exist on digest_run_feeds",
    );
    assertEquals(
      await constraintExists(
        database,
        "digest_run_feeds",
        "digest_run_feeds_status_check",
      ),
      true,
      "digest_run_feeds_status_check should exist on digest_run_feeds",
    );
  });
});

test("database schema rejects invalid connector id", async () => {
  await withTestDb(async (database) => {
    const now = Date.now();
    await assertRejects(
      () =>
        database.execute(sql`insert into sources (user_id, connector_id, credentials, enabled, created_at, updated_at)
          values ('00000000-0000-0000-0000-000000000001', 'unknown', null, true, ${now}, ${now})`),
    );
  });
});
