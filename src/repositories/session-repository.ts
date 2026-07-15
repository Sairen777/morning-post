import { and, eq, gt, isNull, lte, lt, or } from "drizzle-orm";
import { z } from "zod";
import type { Database } from "../db/client.ts";
import { sessions } from "../db/schema/session.ts";

/**
 * Shape-check applied to every row leaving the repository, so callers can rely
 * on the runtime shape matching the type (catches drift between the migration
 * and the schema definition).
 */
const sessionRowSchema = z.object({
  id: z.string().uuid(),
  userId: z.string().uuid(),
  tokenHash: z.string(),
  createdAt: z.number(),
  expiresAt: z.number(),
  lastSeenAt: z.number().nullable(),
});

export type Session = z.infer<typeof sessionRowSchema>;

export interface CreateSessionInput {
  userId: string;
  tokenHash: string;
  expiresAt: number;
}

function parseSession(row: unknown): Session {
  return sessionRowSchema.parse(row);
}

export async function createSession(
  database: Database,
  input: CreateSessionInput,
): Promise<Session> {
  const rows = await database
    .insert(sessions)
    .values({
      userId: input.userId,
      tokenHash: input.tokenHash,
      createdAt: Date.now(),
      expiresAt: input.expiresAt,
      lastSeenAt: null,
    })
    .returning();
  return parseSession(rows[0]);
}

/**
 * Returns the session only if it exists and has not expired (expiresAt > now);
 * otherwise null. Expiry is enforced in the query so an expired row is never
 * treated as valid.
 */
export async function findValidSessionByTokenHash(
  database: Database,
  tokenHash: string,
  now: number,
): Promise<Session | null> {
  const rows = await database
    .select()
    .from(sessions)
    .where(and(eq(sessions.tokenHash, tokenHash), gt(sessions.expiresAt, now)))
    .limit(1);
  return rows[0] ? parseSession(rows[0]) : null;
}

export async function deleteSession(
  database: Database,
  id: string,
): Promise<void> {
  await database.delete(sessions).where(eq(sessions.id, id));
}

export async function deleteSessionByTokenHash(
  database: Database,
  tokenHash: string,
): Promise<void> {
  await database.delete(sessions).where(eq(sessions.tokenHash, tokenHash));
}

/**
 * Records activity at most once per interval. A near-expiry extension can
 * bypass the interval, but the expiry comparison remains atomic so concurrent
 * requests cannot repeatedly extend the same session.
 */
export async function touchSessionIfDue(
  database: Database,
  id: string,
  now: number,
  nextExpiresAt: number,
  touchIntervalMs: number,
): Promise<Session | null> {
  const rows = await database
    .update(sessions)
    .set({ lastSeenAt: now, expiresAt: nextExpiresAt })
    .where(and(
      eq(sessions.id, id),
      or(
        isNull(sessions.lastSeenAt),
        lte(sessions.lastSeenAt, now - touchIntervalMs),
        lt(sessions.expiresAt, nextExpiresAt),
      ),
    ))
    .returning();
  return rows[0] ? parseSession(rows[0]) : null;
}
