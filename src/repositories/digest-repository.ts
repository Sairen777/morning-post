import { and, asc, desc, eq } from "drizzle-orm";
import { z } from "zod";
import type { Database } from "../db/client.ts";
import { digests, digestStatuses, type DigestStatus } from "../db/schema/digest.ts";
import { NotFoundError } from "../server/errors.ts";

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
