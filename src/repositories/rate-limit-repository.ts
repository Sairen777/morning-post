import { sql } from "drizzle-orm";
import type { Database } from "../db/client.ts";
import { rateLimitBuckets } from "../db/schema/rate-limit.ts";

// Keep opportunistic cleanup bounded so a request cannot turn into an
// unbounded maintenance query as expired buckets accumulate.
const CLEANUP_BATCH_SIZE = 100;

/**
 * Atomically consume one token from a fixed-window bucket.
 *
 * The upsert computes both the count and window boundary from the row that
 * won the unique-key conflict. This means concurrent requests serialize on
 * the bucket row and an expired window is reset without a check-then-act race.
 * The returned boolean is true when this request is within the configured
 * limit; the row remains recorded when the limit is exceeded so subsequent
 * callers cannot bypass the window.
 */
export async function consumeRateLimit(
  database: Database,
  bucketKey: string,
  limit: number,
  windowMs: number,
  now: number,
): Promise<boolean> {
  if (!bucketKey) {
    throw new Error("Rate-limit bucket key must not be empty");
  }
  if (!Number.isSafeInteger(limit) || limit < 1) {
    throw new Error("Rate-limit limit must be a positive integer");
  }
  if (!Number.isSafeInteger(windowMs) || windowMs < 1) {
    throw new Error("Rate-limit window must be a positive integer");
  }
  if (!Number.isFinite(now)) {
    throw new Error("Rate-limit timestamp must be finite");
  }

  const nextReset = now + windowMs;
  const rows = await database
    .insert(rateLimitBuckets)
    .values({ bucketKey, count: 1, resetsAt: nextReset })
    .onConflictDoUpdate({
      target: rateLimitBuckets.bucketKey,
      set: {
        count: sql`case when ${rateLimitBuckets.resetsAt} > ${now}
          then ${rateLimitBuckets.count} + 1 else 1 end`,
        resetsAt: sql`case when ${rateLimitBuckets.resetsAt} > ${now}
          then ${rateLimitBuckets.resetsAt} else ${nextReset} end`,
      },
    })
    .returning({ count: rateLimitBuckets.count });

  const count = Number(rows[0]?.count);
  if (!Number.isSafeInteger(count) || count < 1) {
    throw new Error("Rate-limit bucket upsert returned an invalid count");
  }

  const allowed = count <= limit;
  await database.execute(sql`
    with expired as (
      select bucket_key
      from rate_limit_buckets
      where resets_at <= ${now}
      order by resets_at asc
      limit ${CLEANUP_BATCH_SIZE}
    )
    delete from rate_limit_buckets as bucket
    using expired
    where bucket.bucket_key = expired.bucket_key
  `);

  return allowed;
}
