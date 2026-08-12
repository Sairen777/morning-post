import { test } from "bun:test";
import type { Database as SQLiteDatabase } from "bun:sqlite";

import { openDatabase } from "../../src/db/sqlite.ts";
import { assertEquals, assertExists } from "../assertions.ts";

const PRE_WARMUP_MIGRATIONS = [
  "drizzle/0000_workable_living_lightning.sql",
  "drizzle/0001_little_bishop.sql",
  "drizzle/0002_wakeful_blob.sql",
  "drizzle/0003_icy_proteus.sql",
  "drizzle/0004_loyal_catalog.sql",
  "drizzle/0005_mellow_lagoon.sql",
  "drizzle/0006_bold_rain.sql",
  "drizzle/0007_previous_black_knight.sql",
] as const;

async function applySqlMigration(
  sqlite: SQLiteDatabase,
  path: string,
): Promise<void> {
  const migration = await Bun.file(path).text();
  for (const rawStatement of migration.split("--> statement-breakpoint")) {
    const statement = rawStatement.trim();
    if (statement !== "") sqlite.exec(statement);
  }
}

test("warmup relevance migration preserves populated source dependencies", async () => {
  const connection = openDatabase(":memory:");
  try {
    for (const path of PRE_WARMUP_MIGRATIONS) {
      await applySqlMigration(connection.sqlite, path);
    }

    connection.sqlite.exec(`
      INSERT INTO users (id, name, email, system_prompt, created_at, updated_at)
      VALUES ('owner', 'Owner', 'owner@example.test', '', 1000, 1000);

      INSERT INTO sources (id, user_id, connector_id, credentials, enabled, created_at, updated_at)
      VALUES ('source', 'owner', 'Telegram', '{"retained":"credential"}', 1, 1000, 1000);

      INSERT INTO feeds (id, source_id, external_id, name, kind, enabled, created_at, updated_at)
      VALUES ('feed', 'source', 'channel:1', 'Channel', 'news', 1, 1000, 1000);

      INSERT INTO items (id, feed_id, external_id, date, payload, fetched_at)
      VALUES ('item', 'feed', 'message:1', 1000, '{"connectorId":"Telegram","feedExternalId":"channel:1","externalId":"message:1","date":1000,"title":null,"text":"preserved","author":"Owner","url":null}', 1000);
    `);

    connection.sqlite.exec("BEGIN");
    await applySqlMigration(
      connection.sqlite,
      "drizzle/0008_warmup_relevance.sql",
    );
    connection.sqlite.exec("COMMIT");

    const source = connection.sqlite.query<{
      relevance_warmup: number;
      relevance_warmup_negative_feedback_count: number;
    }, []>(
      "SELECT relevance_warmup, relevance_warmup_negative_feedback_count FROM sources WHERE id = 'source'",
    ).get();
    assertExists(source);
    assertEquals(source.relevance_warmup, 0);
    assertEquals(source.relevance_warmup_negative_feedback_count, 0);
    assertExists(
      connection.sqlite.query("SELECT id FROM feeds WHERE id = 'feed'").get(),
    );
    assertExists(
      connection.sqlite.query("SELECT id FROM items WHERE id = 'item'").get(),
    );
  } finally {
    connection.close();
  }
});
