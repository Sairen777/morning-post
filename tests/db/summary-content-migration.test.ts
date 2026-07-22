import { test } from "bun:test";
import { assertEquals } from "../assertions.ts"
import { readFile } from "node:fs/promises";
import postgres from "postgres";

test("summary content migration wraps legacy point arrays without data loss", async () => {
  const databaseUrl = process.env.TEST_DATABASE_URL;
  if (!databaseUrl) {
    throw new Error("TEST_DATABASE_URL environment variable is not set");
  }

  const client = postgres(databaseUrl, { max: 1 });
  try {
    await client.begin(async (transaction) => {
      await transaction.unsafe(`
        CREATE TEMPORARY TABLE summaries (
          id integer PRIMARY KEY,
          points jsonb NOT NULL
        ) ON COMMIT DROP
      `);
      await transaction`
        INSERT INTO summaries (id, points)
        VALUES
          (1, ${transaction.json([])}),
          (2, ${
        transaction.json([
          { text: "First", sourceUrl: null },
          {
            text: "Second",
            sourceUrl: "https://example.com/second",
            channel: "News",
          },
        ])
      })
      `;

      const migration = await readFile(
        "drizzle/0013_wandering_silver_fox.sql",
        "utf8",
      );
      await transaction.unsafe(migration);

      const rows =
        await transaction`SELECT id, content FROM summaries ORDER BY id`;
      assertEquals(Array.from(rows), [
        { id: 1, content: { kind: "aggregate", points: [] } },
        {
          id: 2,
          content: {
            kind: "aggregate",
            points: [
              { text: "First", sourceUrl: null },
              {
                text: "Second",
                sourceUrl: "https://example.com/second",
                channel: "News",
              },
            ],
          },
        },
      ]);

      const columns = await transaction`
        SELECT attribute.attname AS name
        FROM pg_attribute AS attribute
        WHERE attribute.attrelid = 'summaries'::regclass
          AND attribute.attnum > 0
          AND NOT attribute.attisdropped
        ORDER BY attribute.attnum
      `;
      assertEquals(Array.from(columns), [{ name: "id" }, { name: "content" }]);
    });
  } finally {
    await client.end();
  }
});
