import type { Database } from "../db/client.ts";
import { findLatestDigestForUser } from "../repositories/digest-repository.ts";
import { recoverStaleDigestRuns, isDigestRunAlreadyRunningError } from "../repositories/digest-run-repository.ts";
import { sanitizeErrorForOps } from "../server/error-sanitizer.ts";
import { tryAcquireSchedulerLease } from "../repositories/scheduler-lease-repository.ts";
import { listUsersPage, type User } from "../repositories/user-repository.ts";
import type { DigestView } from "../services/digest-service.ts";
import type { OrchestratorDependencies } from "../services/orchestrator.ts";
import type { DigestPeriod } from "../services/orchestrator.ts";
import type { Scheduler } from "./scheduler.ts";
import { cleanupExpiredMedia } from "../services/summarization-service.ts";
import { getConfig } from "../config.ts";

export const DEFAULT_DIGEST_CRON = "0 6 * * *";
export const DIGEST_CADENCE_MS = 24 * 60 * 60 * 1000;
export const DEFAULT_USER_PAGE_SIZE = 100;
export const DEFAULT_USER_CONCURRENCY = 5;
export const DEFAULT_DIGEST_RUN_STALE_AFTER_MS = 15 * 60 * 1000;
export const DEFAULT_SCHEDULER_LEASE_MS = 90 * 1000;
export const SCHEDULER_LEASE_NAME = "digest-job";

export type RunForUserFunction = (
  database: Database,
  userId: string,
  period: DigestPeriod,
  dependencies: OrchestratorDependencies,
) => Promise<DigestView>;
type AcquireSchedulerLeaseFunction = (
  database: Database,
  name: string,
  ownerId: string,
  now: number,
  leaseMs: number,
) => Promise<boolean>;
type RecoverStaleDigestRunsFunction = (
  database: Database,
  now: number,
  staleAfterMs: number,
) => Promise<number>;

const defaultOwnerId = (): string => crypto.randomUUID();

export interface DigestJobDependencies extends OrchestratorDependencies {
  now?: () => number;
  cadenceMs?: number;
  runForUser?: RunForUserFunction;
  logError?: (message: string) => void;
  userPageSize?: number;
  userConcurrency?: number;
  digestRunStaleAfterMs?: number;
  schedulerLeaseMs?: number;
  ownerId?: string;
  acquireLease?: AcquireSchedulerLeaseFunction;
  recoverStaleRuns?: RecoverStaleDigestRunsFunction;
}

const runningUsers = new Set<string>();

export function clearDigestJobStateForTesting(): void {
  runningUsers.clear();
}

export async function computeDigestPeriod(
  database: Database,
  userId: string,
  now: number,
  cadenceMs = DIGEST_CADENCE_MS,
): Promise<DigestPeriod> {
  const latestDigest = await findLatestDigestForUser(database, userId);
  return {
    startMs: latestDigest === null ? now - cadenceMs + 1 : latestDigest.periodEndMs + 1,
    endMs: now,
  };
}
async function loadDefaultRunForUser(): Promise<RunForUserFunction> {
  try {
    // Deliberately lazy: scheduled work loads the Telegram connector graph only when a tick runs.
    const { runForUser } = await import("../services/orchestrator.ts");
    return runForUser;
  } catch (error) {
    throw new Error("Failed to load digest orchestrator", { cause: error });
  }
}

export async function runDigestTick(
  database: Database,
  dependencies: DigestJobDependencies = {},
): Promise<void> {
  const now = dependencies.now ?? Date.now;
  const cadenceMs = dependencies.cadenceMs ?? DIGEST_CADENCE_MS;
  const staleAfterMs = dependencies.digestRunStaleAfterMs ?? DEFAULT_DIGEST_RUN_STALE_AFTER_MS;
  const recoverStaleRuns = dependencies.recoverStaleRuns ?? recoverStaleDigestRuns;
  await recoverStaleRuns(database, now(), staleAfterMs);
  const runDigestForUser = dependencies.runForUser ?? await loadDefaultRunForUser();
  const logError = dependencies.logError ?? ((message: string) => console.error(message));
  const userPageSize = Math.max(1, Math.floor(dependencies.userPageSize ?? DEFAULT_USER_PAGE_SIZE));
  const userConcurrency = Math.max(1, Math.floor(dependencies.userConcurrency ?? DEFAULT_USER_CONCURRENCY));

  const runOneUser = async (user: User): Promise<void> => {
    if (runningUsers.has(user.id)) {
      return;
    }
    runningUsers.add(user.id);
    try {
      const period = await computeDigestPeriod(database, user.id, now(), cadenceMs);
      await runDigestForUser(database, user.id, period, { ...dependencies, trigger: "scheduled" });
    } catch (error) {
      if (isDigestRunAlreadyRunningError(error)) return;
      logError(`Digest tick failed for user ${user.id}: ${sanitizeErrorForOps(error)}`);
    } finally {
      runningUsers.delete(user.id);
    }
  };

  let afterCreatedAt: number | undefined;
  let afterId: string | undefined;
  while (true) {
    const page = await listUsersPage(database, { afterCreatedAt, afterId, limit: userPageSize });
    for (let index = 0; index < page.length; index += userConcurrency) {
      await Promise.all(page.slice(index, index + userConcurrency).map(runOneUser));
    }
    if (page.length < userPageSize) {
      break;
    }
    const lastUser = page[page.length - 1];
    afterCreatedAt = lastUser.createdAt;
    afterId = lastUser.id;
  }
}

export function scheduleDigestJob(
  scheduler: Scheduler,
  database: Database,
  dependencies: DigestJobDependencies = {},
  cron = DEFAULT_DIGEST_CRON,
): void {
  const now = dependencies.now ?? Date.now;
  const ownerId = dependencies.ownerId ?? defaultOwnerId();
  const leaseMs = dependencies.schedulerLeaseMs ?? DEFAULT_SCHEDULER_LEASE_MS;
  const acquireLease = dependencies.acquireLease ?? tryAcquireSchedulerLease;
  scheduler.schedule(SCHEDULER_LEASE_NAME, cron, async () => {
    const acquired = await acquireLease(database, SCHEDULER_LEASE_NAME, ownerId, now(), leaseMs);
    if (!acquired) return;
    await runDigestTick(database, dependencies);
  });
}

export const MEDIA_HOUSEKEEPING_CRON = "0 6 * * SUN"; // Weekly on Sunday 06:00

/**
 * Register a weekly housekeeping callback that removes media files older than
 * MEDIA_TTL_MS across all connector media directories.
 */
export function scheduleMediaHousekeeping(scheduler: Scheduler): void {
  scheduler.schedule("media-housekeeping", MEDIA_HOUSEKEEPING_CRON, async () => {
    const config = getConfig();
    await cleanupExpiredMedia(Date.now(), config.mediaTtlMs);
  });
}
