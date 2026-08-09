import { test } from "bun:test";
import type { Database as SQLiteDatabase } from "bun:sqlite";

import { openDatabase } from "../../src/db/sqlite.ts";
import { assertEquals, assertExists } from "../assertions.ts";

const PRE_RESTORATION_MIGRATIONS = [
  "drizzle/0000_workable_living_lightning.sql",
  "drizzle/0001_little_bishop.sql",
  "drizzle/0002_wakeful_blob.sql",
  "drizzle/0003_icy_proteus.sql",
  "drizzle/0004_loyal_catalog.sql",
  "drizzle/0005_mellow_lagoon.sql",
  "drizzle/0006_bold_rain.sql",
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

test("X browser restoration migration disconnects incompatible X sessions without deleting captured items", async () => {
  const connection = openDatabase(":memory:");
  try {
    for (const path of PRE_RESTORATION_MIGRATIONS) {
      await applySqlMigration(connection.sqlite, path);
    }

    connection.sqlite.exec(`
      INSERT INTO users (id, name, email, system_prompt, created_at, updated_at)
      VALUES ('owner', 'Owner', 'owner@example.test', '', 1000, 1000);

      INSERT INTO sources (id, user_id, connector_id, credentials, enabled, created_at, updated_at)
      VALUES
        ('x-source', 'owner', 'X', '{"retired":"session"}', 1, 1000, 1000),
        ('telegram-source', 'owner', 'Telegram', '{"retained":"credential"}', 1, 1000, 1000);

      INSERT INTO feeds (id, source_id, external_id, name, kind, enabled, created_at, updated_at)
      VALUES
        ('x-feed', 'x-source', 'x:following', 'Following', 'news', 1, 1000, 1000),
        ('telegram-feed', 'telegram-source', 'channel:1', 'Channel', 'news', 1, 1000, 1000);

      INSERT INTO items (id, feed_id, external_id, date, payload, fetched_at)
      VALUES ('captured-x-item', 'x-feed', 'post:1', 1000, '{"connectorId":"X","feedExternalId":"x:following","externalId":"post:1","date":1000,"title":null,"text":"preserved","author":"@owner","url":"https://x.com/owner/status/1","meta":{"messageKind":"post"}}', 1000);

      INSERT INTO x_discovered_feeds (
        id, source_id, credential_revision, external_id, name, kind, created_at
      ) VALUES ('catalog-entry', 'x-source', 1, 'x:following', 'Following', 'news', 1000);
    `);

    await applySqlMigration(
      connection.sqlite,
      "drizzle/0007_previous_black_knight.sql",
    );

    const xSource = connection.sqlite.query<{
      credentials: string | null;
      enabled: number;
    }, []>(
      "SELECT credentials, enabled FROM sources WHERE id = 'x-source'",
    ).get();
    assertExists(xSource);
    assertEquals(xSource.credentials, null);
    assertEquals(xSource.enabled, 0);

    const xFeed = connection.sqlite.query<{
      enabled: number;
      deleted_at: number | null;
    }, []>(
      "SELECT enabled, deleted_at FROM feeds WHERE id = 'x-feed'",
    ).get();
    assertExists(xFeed);
    assertEquals(xFeed.enabled, 0);
    assertEquals(typeof xFeed.deleted_at, "number");

    const capturedItem = connection.sqlite.query<{
      id: string;
      feed_id: string;
      external_id: string;
      date: number;
      payload: string;
      fetched_at: number;
    }, []>(
      "SELECT id, feed_id, external_id, date, payload, fetched_at FROM items WHERE id = 'captured-x-item'",
    ).get();
    assertExists(capturedItem);
    assertEquals({
      ...capturedItem,
      payload: JSON.parse(capturedItem.payload) as unknown,
    }, {
      id: "captured-x-item",
      feed_id: "x-feed",
      external_id: "post:1",
      date: 1000,
      payload: {
        connectorId: "X",
        feedExternalId: "x:following",
        externalId: "post:1",
        date: 1000,
        title: null,
        text: "preserved",
        author: "@owner",
        url: "https://x.com/owner/status/1",
        meta: { messageKind: "post" },
      },
      fetched_at: 1000,
    });
    assertEquals(
      connection.sqlite.query(
        "SELECT credentials, enabled FROM sources WHERE id = 'telegram-source'",
      ).get(),
      { credentials: '{"retained":"credential"}', enabled: 1 },
    );
    assertEquals(
      connection.sqlite.query(
        "SELECT enabled, deleted_at FROM feeds WHERE id = 'telegram-feed'",
      ).get(),
      { enabled: 1, deleted_at: null },
    );

    const tableNames = connection.sqlite.query<{ name: string }, []>(
      "SELECT name FROM sqlite_schema WHERE type = 'table'",
    ).all().map(({ name }) => name);
    for (
      const obsoleteTable of [
        "x_content_cache_items",
        "x_content_cache_ranges",
        "x_content_fetch_progress",
        "x_discovered_feeds",
      ]
    ) {
      assertEquals(tableNames.includes(obsoleteTable), false);
    }

    const sourceColumns = connection.sqlite.query<{ name: string }, []>(
      "PRAGMA table_info(sources)",
    ).all().map(({ name }) => name);
    assertEquals(sourceColumns.includes("credential_revision"), false);
  } finally {
    connection.close();
  }
});
