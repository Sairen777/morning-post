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
import { createConsoleDigestProgressReporter } from "../services/digest-progress.ts";
import {
  scheduleDigestJob,
  scheduleMediaHousekeeping,
} from "../scheduler/digest-job.ts";
import { CronScheduler, type Scheduler } from "../scheduler/scheduler.ts";
import { buildApp, type ServerBindings } from "./app.ts";

export type ServerRequestHandler = (
  request: Request,
  server: ServerBindings["server"],
) => Response | Promise<Response>;

export type ServerServeFunction = (
  options: {
    hostname: string;
    port: number;
    fetch: ServerRequestHandler;
  },
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
  const scheduler = dependencies.scheduler ?? new CronScheduler();
  const log = dependencies.log ?? console.log;
  const progressReporter = createConsoleDigestProgressReporter(
    config.digestProgressLogging,
    log,
  );
  const app = buildApp(database, {
    digests: {
      summarizer,
      timeoutMs: config.summarizerTimeoutMs,
      summarizationConcurrency: config.summarizationConcurrency,
      progressReporter,
    },
  });
  const recoverStaleRuns = dependencies.recoverStaleRuns ??
    recoverStaleDigestRuns;
  await recoverStaleRuns(
    database,
    dependencies.now?.() ?? Date.now(),
    config.digestRunStaleAfterMs,
  );
  scheduleDigestJob(scheduler, database, {
    summarizer,
    timeoutMs: config.summarizerTimeoutMs,
    summarizationConcurrency: config.summarizationConcurrency,
    progressReporter,
    schedulerLeaseMs: config.schedulerLeaseMs,
    digestRunStaleAfterMs: config.digestRunStaleAfterMs,
  });
  scheduleMediaHousekeeping(scheduler);

  const formattedServerHostname = serverHostname.includes(":")
    ? `[${serverHostname}]`
    : serverHostname;
  log(
    `Hono is running at http://${formattedServerHostname}:${
      String(config.port)
    }`,
  );
  const serve: ServerServeFunction = dependencies.serve ??
    ((options) => {
      Bun.serve({
        hostname: options.hostname,
        port: options.port,
        fetch(request, server) {
          return options.fetch(request, server);
        },
      });
    });
  serve({
    hostname: serverHostname,
    port: config.port,
    fetch: (request, server) => app.fetch(request, { server }),
  });
}

if (import.meta.main) {
  await bootServer();
}
