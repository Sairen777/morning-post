import type { Database } from "../db/client.ts";
import { findLatestDigestForUser } from "../repositories/digest-repository.ts";
import { listUsers } from "../repositories/user-repository.ts";
import type { DigestView } from "../services/digest-service.ts";
import type { OrchestratorDependencies } from "../services/orchestrator.ts";
import { runForUser, type DigestPeriod } from "../services/orchestrator.ts";
import type { Scheduler } from "./scheduler.ts";

export const DEFAULT_DIGEST_CRON = "0 6 * * *";
export const DIGEST_CADENCE_MS = 24 * 60 * 60 * 1000;


export type RunForUserFunction = (
  database: Database,
  userId: string,
  period: DigestPeriod,
  dependencies: OrchestratorDependencies,
) => Promise<DigestView>;
export interface DigestJobDependencies extends OrchestratorDependencies {
  now?: () => number;
  cadenceMs?: number;
  runForUser?: RunForUserFunction;
  logError?: (message: string) => void;
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

export async function runDigestTick(
  database: Database,
  dependencies: DigestJobDependencies = {},
): Promise<void> {
  const now = dependencies.now ?? Date.now;
  const cadenceMs = dependencies.cadenceMs ?? DIGEST_CADENCE_MS;
  const runDigestForUser = dependencies.runForUser ?? runForUser;
  const logError = dependencies.logError ?? ((message: string) => console.error(message));
  const users = await listUsers(database);

  await Promise.all(users.map(async (user) => {
    if (runningUsers.has(user.id)) {
      return;
    }
    runningUsers.add(user.id);
    try {
      const period = await computeDigestPeriod(database, user.id, now(), cadenceMs);
      await runDigestForUser(database, user.id, period, dependencies);
    } catch (error) {
      logError(`Digest tick failed for user ${user.id}: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      runningUsers.delete(user.id);
    }
  }));
}

export function scheduleDigestJob(
  scheduler: Scheduler,
  database: Database,
  dependencies: DigestJobDependencies = {},
  cron = DEFAULT_DIGEST_CRON,
): void {
  scheduler.schedule("digest-job", cron, async () => {
    await runDigestTick(database, dependencies);
  });
}
