import { and, desc, eq, inArray, lt, or, sql } from "drizzle-orm";
import { z } from "zod";
import type { Database } from "../db/client.ts";
import {
  digests,
  type DigestContentMode,
  digestContentModes,
  digestStatuses,
  type DigestStatus,
} from "../db/schema/digest.ts";
import { digestRuns } from "../db/schema/digest-run.ts";
import { NotFoundError } from "../server/errors.ts";
import { type PageResult, encodeDigestCursor, decodeDigestCursor } from "../server/cursor.ts";

const publicDigestSchema = z.object({
  id: z.string().uuid(),
  userId: z.string().uuid(),
  periodStartMs: z.number(),
  periodEndMs: z.number(),
  status: z.enum(digestStatuses),
  contentMode: z.enum(digestContentModes),
  createdAt: z.number(),
  updatedAt: z.number(),
  latestRunStartedAt: z.number().nullable().optional(),
  latestRunFinishedAt: z.number().nullable().optional(),
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
function attachLatestRunTiming(
  database: Database,
  values: PublicDigest[],
): PublicDigest[] {
  if (values.length === 0) return [];
  const rows = database
    .select({
      digestId: digestRuns.digestId,
      startedAt: digestRuns.startedAt,
      finishedAt: digestRuns.finishedAt,
    })
    .from(digestRuns)
    .where(and(
      eq(digestRuns.userId, values[0]!.userId),
      inArray(digestRuns.digestId, values.map(({ id }) => id)),
      sql`${digestRuns.id} in (
        select ranked.id
        from (
          select
            ${digestRuns.id} as id,
            row_number() over (
              partition by ${digestRuns.digestId}
              order by
                ${digestRuns.startedAt} desc,
                ${digestRuns.finishedAt} desc nulls last,
                ${digestRuns.id} desc
            ) as row_number
          from ${digestRuns}
        ) as ranked
        where ranked.row_number = 1
      )`,
    ))
    .all();
  const latestByDigestId = new Map(
    rows.flatMap((row) => row.digestId === null ? [] : [[row.digestId, row]]),
  );
  return values.map((digest) => {
    const run = latestByDigestId.get(digest.id);
    return {
      ...digest,
      latestRunStartedAt: run?.startedAt ?? null,
      latestRunFinishedAt: run?.finishedAt ?? null,
    };
  });
}

export function upsertDigestForPeriod(database: Database,
input: UpsertDigestInput,
now = Date.now(),): PublicDigest { const rows = database
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
  .returning()
  .all();
return parsePublicDigest(rows[0]); }

export function setDigestStatus(database: Database,
id: string,
userId: string,
status: DigestStatus,
now = Date.now(),): PublicDigest { const rows = database
  .update(digests)
  .set({ status, updatedAt: now })
  .where(and(eq(digests.id, id), eq(digests.userId, userId)))
  .returning()
  .all();
if (!rows[0]) {
  throw new NotFoundError("digest not found");
}
return parsePublicDigest(rows[0]); }
export function setDigestContentMode(database: Database,
id: string,
userId: string,
contentMode: DigestContentMode,
now = Date.now(),): void { const parsedMode = z.enum(digestContentModes).parse(contentMode);
const rows = database
  .update(digests)
  .set({ contentMode: parsedMode, updatedAt: now })
  .where(and(eq(digests.id, id), eq(digests.userId, userId)))
  .returning({ id: digests.id })
  .all();
if (!rows[0]) {
  throw new NotFoundError("digest not found");
} }

export function getDigestContentMode(database: Database,
id: string,
userId: string,): DigestContentMode { const rows = database
  .select({ contentMode: digests.contentMode })
  .from(digests)
  .where(and(eq(digests.id, id), eq(digests.userId, userId)))
  .limit(1)
  .all();
if (!rows[0]) {
  throw new NotFoundError("digest not found");
}
return z.enum(digestContentModes).parse(rows[0].contentMode); }


export function findDigestForUserPeriod(database: Database,
userId: string,
periodStartMs: number,
periodEndMs: number,): PublicDigest | null { const rows = database
  .select()
  .from(digests)
  .where(and(
    eq(digests.userId, userId),
    eq(digests.periodStartMs, periodStartMs),
    eq(digests.periodEndMs, periodEndMs),
  ))
  .limit(1)
  .all();
return rows[0] ? parsePublicDigest(rows[0]) : null; }

export function findDigestById(database: Database,
id: string,
userId: string,): PublicDigest | null { const rows = database
  .select()
  .from(digests)
  .where(and(eq(digests.id, id), eq(digests.userId, userId)))
  .limit(1)
  .all();
return rows[0] ? parsePublicDigest(rows[0]) : null; }

export function findLatestDigestForUser(database: Database,
userId: string,): PublicDigest | null { const rows = database
  .select()
  .from(digests)
  .where(eq(digests.userId, userId))
  .orderBy(desc(digests.periodEndMs), desc(digests.createdAt))
  .limit(1)
  .all();
return rows[0] ? parsePublicDigest(rows[0]) : null; }

export function listDigestsForUser(database: Database, userId: string): PublicDigest[] { const rows = database
  .select()
  .from(digests)
  .where(eq(digests.userId, userId))
  .orderBy(desc(digests.periodEndMs), desc(digests.createdAt))
  .all();
return attachLatestRunTiming(database, rows.map(parsePublicDigest)); }

export function listDigestPageForUser(database: Database,
userId: string,
options: { cursor?: string; limit?: number } = {},): PageResult<PublicDigest> { const limit = (() => {
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

const rows = database
  .select()
  .from(digests)
  .where(and(...conditions))
  .orderBy(desc(digests.periodEndMs), desc(digests.createdAt), desc(digests.id))
  .limit(limit + 1)
  .all();

const hasMore = rows.length > limit;
const data = attachLatestRunTiming(
  database,
  rows.slice(0, limit).map(parsePublicDigest),
);
const nextCursor: string | null = hasMore
  ? encodeDigestCursor(data[data.length - 1].periodEndMs, data[data.length - 1].createdAt, data[data.length - 1].id)
  : null;

return { data, nextCursor }; }

export function deleteDigestForUser(database: Database,
id: string,
userId: string,): PublicDigest { const rows = database
  .delete(digests)
  .where(and(eq(digests.id, id), eq(digests.userId, userId)))
  .returning()
  .all();
if (!rows[0]) {
  throw new NotFoundError("digest not found");
}
return parsePublicDigest(rows[0]); }
