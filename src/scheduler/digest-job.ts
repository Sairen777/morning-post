import type { Database } from "../db/client.ts";
import { findLatestDigestForUser } from "../repositories/digest-repository.ts";
import { recoverStaleDigestRuns, isDigestRunAlreadyRunningError } from "../repositories/digest-run-repository.ts";
import { sanitizeErrorForOps } from "../server/error-sanitizer.ts";
import { findOwner } from "../repositories/user-repository.ts";
import type { DigestView } from "../services/digest-service.ts";
import type { OrchestratorDependencies } from "../services/orchestrator.ts";
import type { DigestPeriod } from "../services/orchestrator.ts";
import type { Scheduler } from "./scheduler.ts";
import { cleanupExpiredMedia } from "../services/media-cleanup-service.ts";
import { getConfig } from "../config.ts";

export const DEFAULT_DIGEST_CRON = "0 6 * * *";
export const DIGEST_CADENCE_MS = 24 * 60 * 60 * 1000;
export const DEFAULT_DIGEST_RUN_STALE_AFTER_MS = 15 * 60 * 1000;
export const DIGEST_JOB_NAME = "digest-job";

export type RunForUserFunction = (
  database: Database,
  userId: string,
  period: DigestPeriod,
  dependencies: OrchestratorDependencies,
) => Promise<DigestView>;
type RecoverStaleDigestRunsFunction = (
  database: Database,
  now: number,
  staleAfterMs: number,
) => Promise<number>;


export interface DigestJobDependencies extends OrchestratorDependencies {
  now?: () => number;
  cadenceMs?: number;
  runForUser?: RunForUserFunction;
  logError?: (message: string) => void;
  digestRunStaleAfterMs?: number;
  recoverStaleRuns?: RecoverStaleDigestRunsFunction;
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
  const tickTimestamp = (dependencies.now ?? Date.now)();
  const staleAfterMs = dependencies.digestRunStaleAfterMs ?? DEFAULT_DIGEST_RUN_STALE_AFTER_MS;
  const recoverStaleRuns = dependencies.recoverStaleRuns ?? recoverStaleDigestRuns;
  await recoverStaleRuns(database, tickTimestamp, staleAfterMs);

  const owner = await findOwner(database);
  if (!owner) return;

  const cadenceMs = dependencies.cadenceMs ?? DIGEST_CADENCE_MS;
  const runDigestForUser = dependencies.runForUser ?? await loadDefaultRunForUser();
  const logError = dependencies.logError ?? ((message: string) => console.error(message));
  try {
    const period = await computeDigestPeriod(database, owner.id, tickTimestamp, cadenceMs);
    await runDigestForUser(database, owner.id, period, { ...dependencies, trigger: "scheduled" });
  } catch (error) {
    if (isDigestRunAlreadyRunningError(error)) return;
    logError(`Digest tick failed for owner ${owner.id}: ${sanitizeErrorForOps(error)}`);
  }
}

export function scheduleDigestJob(
  scheduler: Scheduler,
  database: Database,
  dependencies: DigestJobDependencies = {},
  cron = DEFAULT_DIGEST_CRON,
): void {
  scheduler.schedule(DIGEST_JOB_NAME, cron, async () => {
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
