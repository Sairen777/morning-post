import { and, asc, desc, eq, gt, lt, or } from "drizzle-orm";
import { z } from "zod";
import type { Database } from "../db/client.ts";
import { digests, digestStatuses, type DigestStatus } from "../db/schema/digest.ts";
import { NotFoundError } from "../server/errors.ts";
import { type PageResult, encodeDigestCursor, decodeDigestCursor } from "../server/cursor.ts";

const publicDigestSchema = z.object({
  id: z.string().uuid(),
  userId: z.string().uuid(),
  periodStartMs: z.number(),
  periodEndMs: z.number(),
  status: z.enum(digestStatuses),
  createdAt: z.number(),
  updatedAt: z.number(),
});

export type PublicDigest = z.infer<typeof publicDigestSchema>;

export interface UpsertDigestInput {
  userId: string;
  periodStartMs: number;
  periodEndMs: number;
  status: DigestStatus;
}

function parsePublicDigest(row: unknown): PublicDigest {
  return publicDigestSchema.parse(row);
}

export async function upsertDigestForPeriod(
  database: Database,
  input: UpsertDigestInput,
  now = Date.now(),
): Promise<PublicDigest> {
  const rows = await database
    .insert(digests)
    .values({
      userId: input.userId,
      periodStartMs: input.periodStartMs,
      periodEndMs: input.periodEndMs,
      status: input.status,
      createdAt: now,
      updatedAt: now,
    })
    .onConflictDoUpdate({
      target: [digests.userId, digests.periodStartMs, digests.periodEndMs],
      set: {
        status: input.status,
        updatedAt: now,
      },
    })
    .returning();
  return parsePublicDigest(rows[0]);
}

export async function setDigestStatus(
  database: Database,
  id: string,
  userId: string,
  status: DigestStatus,
  now = Date.now(),
): Promise<PublicDigest> {
  const rows = await database
    .update(digests)
    .set({ status, updatedAt: now })
    .where(and(eq(digests.id, id), eq(digests.userId, userId)))
    .returning();
  if (!rows[0]) {
    throw new NotFoundError("digest not found");
  }
  return parsePublicDigest(rows[0]);
}

export async function findDigestForUserPeriod(
  database: Database,
  userId: string,
  periodStartMs: number,
  periodEndMs: number,
): Promise<PublicDigest | null> {
  const rows = await database
    .select()
    .from(digests)
    .where(and(
      eq(digests.userId, userId),
      eq(digests.periodStartMs, periodStartMs),
      eq(digests.periodEndMs, periodEndMs),
    ))
    .limit(1);
  return rows[0] ? parsePublicDigest(rows[0]) : null;
}

export async function findDigestById(
  database: Database,
  id: string,
  userId: string,
): Promise<PublicDigest | null> {
  const rows = await database
    .select()
    .from(digests)
    .where(and(eq(digests.id, id), eq(digests.userId, userId)))
    .limit(1);
  return rows[0] ? parsePublicDigest(rows[0]) : null;
}

export async function findLatestDigestForUser(
  database: Database,
  userId: string,
): Promise<PublicDigest | null> {
  const rows = await database
    .select()
    .from(digests)
    .where(eq(digests.userId, userId))
    .orderBy(desc(digests.periodEndMs), desc(digests.createdAt))
    .limit(1);
  return rows[0] ? parsePublicDigest(rows[0]) : null;
}

export async function listDigestsForUser(database: Database, userId: string): Promise<PublicDigest[]> {
  const rows = await database
    .select()
    .from(digests)
    .where(eq(digests.userId, userId))
    .orderBy(desc(digests.periodEndMs), desc(digests.createdAt));
  return rows.map(parsePublicDigest);
}

export async function listDigestPageForUser(
  database: Database,
  userId: string,
  options: { cursor?: string; limit?: number } = {},
): Promise<PageResult<PublicDigest>> {
  const limit = (() => {
    const n = options.limit ?? 20;
    if (!Number.isInteger(n) || n < 1 || n > 100) {
      throw new TypeError("limit must be an integer between 1 and 100");
    }
    return n;
  })();

  const conditions = [eq(digests.userId, userId)];
  if (options.cursor) {
    const c = decodeDigestCursor(options.cursor);
    const cursorCondition = or(
      lt(digests.periodEndMs, c.p),
      and(eq(digests.periodEndMs, c.p), lt(digests.createdAt, c.c)),
      and(eq(digests.periodEndMs, c.p), eq(digests.createdAt, c.c), lt(digests.id, c.i)),
    );
    if (cursorCondition) conditions.push(cursorCondition);
  }

  const rows = await database
    .select()
    .from(digests)
    .where(and(...conditions))
    .orderBy(desc(digests.periodEndMs), desc(digests.createdAt), desc(digests.id))
    .limit(limit + 1);

  const hasMore = rows.length > limit;
  const data = rows.slice(0, limit).map(parsePublicDigest);
  const nextCursor: string | null = hasMore
    ? encodeDigestCursor(data[data.length - 1].periodEndMs, data[data.length - 1].createdAt, data[data.length - 1].id)
    : null;

  return { data, nextCursor };
}

export async function deleteDigestForUser(
  database: Database,
  id: string,
  userId: string,
): Promise<PublicDigest> {
  const rows = await database
    .delete(digests)
    .where(and(eq(digests.id, id), eq(digests.userId, userId)))
    .returning();
  if (!rows[0]) {
    throw new NotFoundError("digest not found");
  }
  return parsePublicDigest(rows[0]);
}
