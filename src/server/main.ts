import {
  type Config,
  getConfig,
  getSummarizerRuntimeConfig,
  resolveAllowRemoteSummarization,
  resolveServerHostname,
} from "../config.ts";
import { OpenAICompatibleSummarizerService } from "../summarizers/openai-compatible-summarizer.ts";
import type { SummarizerService } from "../summarizers/summarizer.types.ts";
import { database as defaultDatabase } from "../db/client.ts";
import type { Database } from "../db/client.ts";
import { recoverStaleDigestRuns } from "../repositories/digest-run-repository.ts";
import {
  scheduleDigestJob,
  scheduleMediaHousekeeping,
} from "../scheduler/digest-job.ts";
import { DenoCronScheduler, type Scheduler } from "../scheduler/scheduler.ts";
import { buildApp } from "./app.ts";
type ServerRequestHandler = (request: Request) => Response | Promise<Response>;
type ServerServeFunction = (
  options: { hostname: string; port: number },
  handler: ServerRequestHandler,
) => unknown;

export interface ServerBootDependencies {
  config?: Config;
  serverHostname?: string;
  database?: Database;
  scheduler?: Scheduler;
  serve?: ServerServeFunction;
  summarizer?: SummarizerService;
  recoverStaleRuns?: typeof recoverStaleDigestRuns;
  now?: () => number;
  log?: (message: string) => void;
}

export async function bootServer(
  dependencies: ServerBootDependencies = {},
): Promise<void> {
  const config = dependencies.config ?? getConfig();
  const serverHostname = resolveServerHostname(dependencies.serverHostname);
  const database = dependencies.database ?? defaultDatabase;
  const summarizer = dependencies.summarizer ??
    new OpenAICompatibleSummarizerService({
      models: getSummarizerRuntimeConfig(),
      allowRemoteSummarization: resolveAllowRemoteSummarization(
        config.allowRemoteSummarization,
      ),
    });
  const scheduler = dependencies.scheduler ?? new DenoCronScheduler();
  const app = buildApp(database, { digests: { summarizer } });
  const recoverStaleRuns = dependencies.recoverStaleRuns ??
    recoverStaleDigestRuns;
  await recoverStaleRuns(
    database,
    dependencies.now?.() ?? Date.now(),
    config.digestRunStaleAfterMs,
  );
  scheduleDigestJob(scheduler, database, {
    summarizer,
    schedulerLeaseMs: config.schedulerLeaseMs,
    digestRunStaleAfterMs: config.digestRunStaleAfterMs,
  });
  scheduleMediaHousekeeping(scheduler);

  const log = dependencies.log ?? console.log;
  const formattedServerHostname = serverHostname.includes(":")
    ? `[${serverHostname}]`
    : serverHostname;
  log(
    `Hono is running at http://${formattedServerHostname}:${
      String(config.port)
    }`,
  );
  const serve: ServerServeFunction = dependencies.serve ??
    ((options, handler) => {
      Deno.serve({ hostname: options.hostname, port: options.port }, handler);
    });
  serve({ hostname: serverHostname, port: config.port }, app.fetch);
}

if (import.meta.main) {
  await bootServer();
}
