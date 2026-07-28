import { test } from "bun:test";
import { eq, sql } from "drizzle-orm";
import { sources, users } from "../../src/db/schema/index.ts";
import { withTestDb } from "../../src/db/testing.ts";
import { assertEquals } from "../assertions.ts";

test("SQLite source schema defaults paid-post titles without losing row fields", async () => {
  await withTestDb(async (database) => {
    const now = Date.now();
    const user = database.insert(users).values({
      name: "Migration fixture",
      email: "source-migration@example.test",
      systemPrompt: "",
      createdAt: now,
      updatedAt: now,
    }).returning().get();
    const inserted = database.insert(sources).values({
      userId: user.id,
      connectorId: "Telegram",
      enabled: false,
      position: 7,
      createdAt: now,
      updatedAt: now,
    }).returning().get();

    const row = database.select().from(sources)
      .where(eq(sources.id, inserted.id)).get();
    assertEquals(row?.connectorId, "Telegram");
    assertEquals(row?.position, 7);
    assertEquals(row?.enabled, false);
    assertEquals(row?.showPaidPostTitles, false);

    const columns = database.all<{
      name: string;
      notnull: number;
      dflt_value: string | null;
    }>(sql`PRAGMA table_info(sources)`);
    const column = columns.find(({ name }) => name === "show_paid_post_titles");
    assertEquals(column?.notnull, 1);
    assertEquals(column?.dflt_value, "false");
  });
});
