import { lte } from "drizzle-orm";
import type { Database } from "../db/client.ts";
import { schedulerLeases } from "../db/schema/scheduler-lease.ts";

/**
 * Atomically acquire or renew a named scheduler lease.
 *
 * The unique lease name is the serialization boundary: a concurrent insert
 * races through PostgreSQL's primary key, and an existing lease is replaced
 * only after its expiration boundary has been reached. A false result means
 * another owner still holds a non-expired lease.
 */
export async function tryAcquireSchedulerLease(
  database: Database,
  name: string,
  ownerId: string,
  now: number,
  leaseMs: number,
): Promise<boolean> {
  if (!name) {
    throw new Error("Scheduler lease name must not be empty");
  }
  if (!ownerId) {
    throw new Error("Scheduler lease ownerId must not be empty");
  }
  if (!Number.isFinite(now)) {
    throw new Error("Scheduler lease timestamp must be finite");
  }
  if (!Number.isFinite(leaseMs) || leaseMs <= 0) {
    throw new Error("Scheduler lease duration must be positive");
  }

  const expiresAt = now + leaseMs;
  const rows = await database
    .insert(schedulerLeases)
    .values({ name, ownerId, expiresAt })
    .onConflictDoUpdate({
      target: schedulerLeases.name,
      set: { ownerId, expiresAt },
      where: lte(schedulerLeases.expiresAt, now),
    })
    .returning({ name: schedulerLeases.name });

  return rows.length > 0;
}
