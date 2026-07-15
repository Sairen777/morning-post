import { assertEquals } from "@std/assert";
import { sql } from "drizzle-orm";
import { rateLimitBuckets } from "../../src/db/schema/rate-limit.ts";
import { withTestDb } from "../../src/db/testing.ts";
import { consumeRateLimit } from "../../src/repositories/rate-limit-repository.ts";

Deno.test("consumeRateLimit allows up to the limit and records the resulting count", async () => {
  await withTestDb(async (database) => {
    const key = "rate-limit-repository-threshold";
    const now = 1_000;

    assertEquals(await consumeRateLimit(database, key, 2, 60_000, now), true);
    assertEquals(await consumeRateLimit(database, key, 2, 60_000, now + 1), true);
    assertEquals(await consumeRateLimit(database, key, 2, 60_000, now + 2), false);

    const rows = await database
      .select({ count: rateLimitBuckets.count })
      .from(rateLimitBuckets);
    assertEquals(rows, [{ count: 3 }]);
  });
});

Deno.test("consumeRateLimit resets an expired window atomically", async () => {
  await withTestDb(async (database) => {
    const key = "rate-limit-repository-expiry";
    const now = 10_000;

    assertEquals(await consumeRateLimit(database, key, 1, 100, now), true);
    assertEquals(await consumeRateLimit(database, key, 1, 100, now + 50), false);
    assertEquals(await consumeRateLimit(database, key, 1, 100, now + 100), true);

    const rows = await database
      .select({ count: rateLimitBuckets.count, resetsAt: rateLimitBuckets.resetsAt })
      .from(rateLimitBuckets);
    assertEquals(rows, [{ count: 1, resetsAt: now + 200 }]);
  });
});

Deno.test("consumeRateLimit serializes concurrent requests for one bucket", async () => {
  await withTestDb(async (database) => {
    const key = "rate-limit-repository-concurrency";
    const results = await Promise.all(
      Array.from({ length: 12 }, (_, index) =>
        consumeRateLimit(database, key, 5, 60_000, 20_000 + index),
      ),
    );

    assertEquals(results.filter(Boolean).length, 5);
    assertEquals(results.filter((allowed) => !allowed).length, 7);

    const rows = await database
      .select({ count: rateLimitBuckets.count })
      .from(rateLimitBuckets);
    assertEquals(rows, [{ count: 12 }]);
  });
});

Deno.test("consumeRateLimit cleanup removes only a bounded batch of expired buckets", async () => {
  await withTestDb(async (database) => {
    const now = 50_000;
    await database.insert(rateLimitBuckets).values(
      Array.from({ length: 150 }, (_, index) => ({
        bucketKey: `rate-limit-repository-expired-${index}`,
        count: 1,
        resetsAt: now - 1,
      })),
    );

    assertEquals(
      await consumeRateLimit(database, "rate-limit-repository-cleanup", 1, 60_000, now),
      true,
    );

    const remaining = await database.execute(
      sql`select count(*) as count
          from rate_limit_buckets
          where bucket_key like 'rate-limit-repository-expired-%'`,
    );
    // Cleanup is intentionally bounded to one maintenance batch per request.
    assertEquals(Number(remaining[0].count), 50);
  });
});
