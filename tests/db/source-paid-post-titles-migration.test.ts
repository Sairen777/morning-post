import { test } from "bun:test";
import { assertEquals } from "../assertions.ts"
import { readFile } from "node:fs/promises";
import postgres from "postgres";

test("source paid-post title migration defaults existing rows without data loss", async () => {
  const databaseUrl = process.env.TEST_DATABASE_URL;
  if (!databaseUrl) {
    throw new Error("TEST_DATABASE_URL environment variable is not set");
  }

  const client = postgres(databaseUrl, { max: 1 });
  try {
    await client.begin(async (transaction) => {
      await transaction.unsafe(`
        CREATE TEMPORARY TABLE sources (
          id integer PRIMARY KEY,
          connector_id text NOT NULL,
          enabled boolean NOT NULL DEFAULT true,
          position integer
        ) ON COMMIT DROP
      `);
      await transaction`
        INSERT INTO sources (id, connector_id, enabled, position)
        VALUES
          (1, 'substack', true, 7),
          (2, 'telegram', false, NULL)
      `;

      const migration = await readFile(
        "drizzle/0014_cynical_malice.sql",
        "utf8",
      );
      await transaction.unsafe(migration);

      const rows = await transaction`
        SELECT id, connector_id, enabled, position, show_paid_post_titles
        FROM sources
        ORDER BY id
      `;
      assertEquals(Array.from(rows), [
        {
          id: 1,
          connector_id: "substack",
          enabled: true,
          position: 7,
          show_paid_post_titles: false,
        },
        {
          id: 2,
          connector_id: "telegram",
          enabled: false,
          position: null,
          show_paid_post_titles: false,
        },
      ]);

      const nullableAndDefault = await transaction`
        SELECT
          column_name,
          is_nullable,
          column_default
        FROM information_schema.columns
        WHERE table_schema LIKE 'pg_temp_%'
          AND table_name = 'sources'
          AND column_name = 'show_paid_post_titles'
      `;
      assertEquals(Array.from(nullableAndDefault), [{
        column_name: "show_paid_post_titles",
        is_nullable: "NO",
        column_default: "false",
      }]);
    });
  } finally {
    await client.end();
  }
});
