import { assertEquals } from "@std/assert";
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

Deno.test("database schema exposes required performance indexes", async () => {
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
  });
});

Deno.test("database schema rejects invalid persisted states", async () => {
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
  });
});
