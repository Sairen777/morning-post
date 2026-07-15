import { getConfig, resolveServerHostname, type Config } from "../config.ts";
import { database as defaultDatabase } from "../db/client.ts";
import type { Database } from "../db/client.ts";
import { scheduleDigestJob, scheduleMediaHousekeeping } from "../scheduler/digest-job.ts";
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
  log?: (message: string) => void;
}

export function bootServer(dependencies: ServerBootDependencies = {}): void {
  const config = dependencies.config ?? getConfig();
  const serverHostname = resolveServerHostname(dependencies.serverHostname);
  const database = dependencies.database ?? defaultDatabase;
  const app = buildApp(database);
  const scheduler = dependencies.scheduler ?? new DenoCronScheduler();
  scheduleDigestJob(scheduler, database, {
    schedulerLeaseMs: config.schedulerLeaseMs,
    digestRunStaleAfterMs: config.digestRunStaleAfterMs,
  });
  scheduleMediaHousekeeping(scheduler);

  const log = dependencies.log ?? console.log;
  const formattedServerHostname = serverHostname.includes(":") ? `[${serverHostname}]` : serverHostname;
  log(`Hono is running at http://${formattedServerHostname}:${String(config.port)}`);
  const serve: ServerServeFunction = dependencies.serve ?? ((options, handler) => {
    Deno.serve({ hostname: options.hostname, port: options.port }, handler);
  });
  serve({ hostname: serverHostname, port: config.port }, app.fetch);
}

if (import.meta.main) {
  bootServer();
}
