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

export function createSession(
  database: Database,
  input: CreateSessionInput,
): Session {
  const rows = database
    .insert(sessions)
    .values({
      userId: input.userId,
      tokenHash: input.tokenHash,
      createdAt: Date.now(),
      expiresAt: input.expiresAt,
      lastSeenAt: null,
    })
    .returning()
    .all();
  return parseSession(rows[0]);
}

/**
 * Returns the session only if it exists and has not expired (expiresAt > now);
 * otherwise null. Expiry is enforced in the query so an expired row is never
 * treated as valid.
 */
export function findValidSessionByTokenHash(
  database: Database,
  tokenHash: string,
  now: number,
): Session | null {
  const rows = database
    .select()
    .from(sessions)
    .where(and(eq(sessions.tokenHash, tokenHash), gt(sessions.expiresAt, now)))
    .limit(1)
    .all();
  return rows[0] ? parseSession(rows[0]) : null;
}

export function deleteSession(
  database: Database,
  id: string,
): void {
  database.delete(sessions).where(eq(sessions.id, id)).run();
}

export function deleteSessionByTokenHash(
  database: Database,
  tokenHash: string,
): void {
  database.delete(sessions).where(eq(sessions.tokenHash, tokenHash)).run();
}

/**
 * Records activity at most once per interval. A near-expiry extension can
 * bypass the interval, but the expiry comparison remains atomic so concurrent
 * requests cannot repeatedly extend the same session.
 */
export function touchSessionIfDue(
  database: Database,
  id: string,
  now: number,
  nextExpiresAt: number,
  touchIntervalMs: number,
): Session | null {
  const rows = database
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
    .returning()
    .all();
  return rows[0] ? parseSession(rows[0]) : null;
}
