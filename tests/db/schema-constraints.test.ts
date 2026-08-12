import { test } from "bun:test";
import { assertEquals, assertThrows } from "../assertions.ts"
import { sql } from "drizzle-orm";
import type { Database } from "../../src/db/sqlite.ts";
import { withTestDb } from "../../src/db/testing.ts";
import { createUser } from "../../src/repositories/user-repository.ts";

function indexExists(
  database: Database,
  name: string,
): boolean {
  return database.get(
    sql`select 1 from sqlite_schema
        where type = 'index' and name = ${name}
        limit 1`,
  ) !== undefined;
}

function constraintExists(
  database: Database,
  tableName: string,
  constraintName: string,
): boolean {
  return database.get(
    sql`select 1 from sqlite_schema
        where type = 'table'
          and name = ${tableName}
          and instr(sql, ${constraintName}) > 0
        limit 1`,
  ) !== undefined;
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
        "sources",
        "sources_relevance_warmup_negative_feedback_count_check",
      ),
      true,
      "sources_relevance_warmup_negative_feedback_count_check should exist on sources",
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
    assertThrows(
      () =>
        database.run(sql`insert into sources (user_id, connector_id, credentials, enabled, created_at, updated_at)
          values ('00000000-0000-0000-0000-000000000001', 'unknown', null, true, ${now}, ${now})`),
    );
  });
});

test("database schema rejects negative warmup negative feedback counts", async () => {
  await withTestDb(async (database) => {
    const now = Date.now();
    const user = createUser(database, {
      name: "Constraint Owner",
      email: `constraint-${now}@example.com`,
      passwordHash: "$argon2id$fakehash",
      systemPrompt: "",
    });
    assertThrows(
      () =>
        database.run(sql`insert into sources (user_id, connector_id, credentials, enabled, relevance_warmup, relevance_warmup_negative_feedback_count, created_at, updated_at)
          values (${user.id}, 'Telegram', null, false, true, -1, ${now}, ${now})`),
    );
  });
});
