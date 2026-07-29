import { test } from "bun:test";
import { eq, sql } from "drizzle-orm";
import {
  feeds,
  sources,
  summaries,
  users,
} from "../../src/db/schema/index.ts";
import { withTestDb } from "../../src/db/testing.ts";
import { assertEquals } from "../assertions.ts";

test("SQLite summary schema round-trips structured content without data loss", async () => {
  await withTestDb(async (database) => {
    const now = Date.now();
    const user = database.insert(users).values({
      name: "Migration fixture",
      email: "summary-migration@example.test",
      systemPrompt: "",
      createdAt: now,
      updatedAt: now,
    }).returning().get();
    assertEquals(user.storyDetailLevel, "balanced");
    const userColumns = database.all<{
      name: string;
      notnull: number;
      dflt_value: string | null;
    }>(sql`PRAGMA table_info(users)`);
    const detailColumn = userColumns.find(({ name }) => name === "story_detail_level");
    assertEquals(detailColumn?.notnull, 1);
    assertEquals(detailColumn?.dflt_value, "'balanced'");
    const source = database.insert(sources).values({
      userId: user.id,
      connectorId: "Telegram",
      enabled: false,
      createdAt: now,
      updatedAt: now,
    }).returning().get();
    const feed = database.insert(feeds).values({
      sourceId: source.id,
      externalId: "migration-feed",
      name: "Migration feed",
      kind: "news",
      createdAt: now,
      updatedAt: now,
    }).returning().get();
    const content = {
      kind: "aggregate" as const,
      points: [
        { text: "First", sourceUrl: null },
        {
          text: "Second",
          sourceUrl: "https://example.com/second",
          channel: "News",
        },
      ],
    };
    const inserted = database.insert(summaries).values({
      feedId: feed.id,
      periodStartMs: 1,
      periodEndMs: 2,
      content,
      feedNameSnapshot: feed.name,
      generatedAt: now,
    }).returning().get();

    const row = database.select().from(summaries)
      .where(eq(summaries.id, inserted.id)).get();
    assertEquals(row?.content, content);

    const columns = database.all<{ name: string; type: string }>(
      sql`PRAGMA table_info(summaries)`,
    );
    assertEquals(
      columns.find(({ name }) => name === "content")?.type,
      "TEXT",
    );
    assertEquals(columns.some(({ name }) => name === "points"), false);
  });
});
