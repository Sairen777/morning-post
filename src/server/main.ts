import {
  type Config,
  getConfig,
  getSummarizerRuntimeConfig,
  getXBrowserConfig,
  resolveAllowRemoteSummarization,
  resolveServerHostname,
} from "../config.ts";
import {
  ConnectorFactory,
  type ConnectorFactoryLike,
} from "../connectors/connector-factory.ts";
import { XBrowserRuntime } from "../connectors/x/index.ts";
import { CredentialCipher } from "../crypto/credential-cipher.ts";
import { EnvMasterKeyProvider } from "../crypto/key-provider.ts";
import {
  DefaultFeedDiscoveryFactory,
  type FeedDiscoveryFactory,
} from "../services/feed-service.ts";
import { XLoginSessionManager } from "../services/x-login-service.ts";
import { XTargetService } from "../services/x-target-service.ts";
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

export interface ServerInstance {
  stop(closeActiveConnections?: boolean): Promise<void> | void;
}

export type ServerServeFunction = (
  options: {
    hostname: string;
    port: number;
    fetch: ServerRequestHandler;
  },
) => ServerInstance | void;

export interface ServerBootDependencies {
  config?: Config;
  serverHostname?: string;
  database?: Database;
  scheduler?: Scheduler;
  serve?: ServerServeFunction;
  credentialCipher?: CredentialCipher;
  xBrowserRuntime?: XBrowserRuntime;
  xLoginSessionManager?: XLoginSessionManager;
  xTargetService?: XTargetService;
  connectorFactory?: ConnectorFactoryLike;
  feedDiscoveryFactory?: FeedDiscoveryFactory;
  summarizer?: SummarizerService;
  recoverStaleRuns?: typeof recoverStaleDigestRuns;
  now?: () => number;
  log?: (message: string) => void;
}

export interface ServerLifecycle {
  dispose(): Promise<void>;
}

export async function bootServer(
  dependencies: ServerBootDependencies = {},
): Promise<ServerLifecycle> {
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
  const credentialCipher = dependencies.credentialCipher ??
    new CredentialCipher(new EnvMasterKeyProvider());
  const xBrowserConfig = getXBrowserConfig({
    profileRoot: config.xBrowserProfileRoot,
    loginTimeoutMs: config.xBrowserLoginTimeoutMs,
  });
  const xBrowserRuntime = dependencies.xBrowserRuntime ??
    new XBrowserRuntime({ profileRoot: xBrowserConfig.profileRoot });
  const xLoginSessionManager = dependencies.xLoginSessionManager ??
    new XLoginSessionManager({
      database,
      credentialCipher,
      browserRuntime: xBrowserRuntime,
      loginTimeoutMs: xBrowserConfig.loginTimeoutMs,
    });
  const xTargetService = dependencies.xTargetService ??
    new XTargetService({
      database,
      credentialCipher,
      browserRuntime: xBrowserRuntime,
    });
  const connectorFactory = dependencies.connectorFactory ??
    new ConnectorFactory(database, {
      credentialCipher,
      xBrowserRuntime,
    });
  const feedDiscoveryFactory = dependencies.feedDiscoveryFactory ??
    new DefaultFeedDiscoveryFactory(
      database,
      credentialCipher,
      undefined,
      xBrowserRuntime,
    );
  const progressReporter = createConsoleDigestProgressReporter(
    config.digestProgressLogging,
    log,
  );
  const shutdownController = new AbortController();
  const app = buildApp(database, {
    connectors: {
      xLoginSessionManager,
      xTargetService,
      connectorTimeoutMs: config.connectorTimeoutMs,
      trustedProxyCount: config.trustedProxyCount,
    },
    sources: {
      xBrowserRuntime,
    },
    feeds: {
      discoveryFactory: feedDiscoveryFactory,
    },
    digests: {
      summarizer,
      timeoutMs: config.summarizerTimeoutMs,
      summarizationConcurrency: config.summarizationConcurrency,
      progressReporter,
      connectorFactory,
      signal: shutdownController.signal,
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
    digestRunStaleAfterMs: config.digestRunStaleAfterMs,
    connectorFactory,
    signal: shutdownController.signal,
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
    ((options) =>
      Bun.serve({
        hostname: options.hostname,
        port: options.port,
        fetch(request, server) {
          return options.fetch(request, server);
        },
      }));
  const server = serve({
    hostname: serverHostname,
    port: config.port,
    fetch: (request, server) => app.fetch(request, { server }),
  });
  let disposePromise: Promise<void> | undefined;
  const disposeResources = async (): Promise<void> => {
    shutdownController.abort(
      new DOMException("Morning Post server is shutting down", "AbortError"),
    );
    const results = await Promise.allSettled([
      (async () => await server?.stop(true))(),
      (async () => {
        if ("stop" in scheduler && typeof scheduler.stop === "function") {
          scheduler.stop();
        }
      })(),
      xLoginSessionManager.dispose(),
    ]);
    const failures = results.flatMap((result) =>
      result.status === "rejected" ? [result.reason] : []
    );
    if (failures.length > 0) {
      throw new AggregateError(failures, "server shutdown cleanup failed");
    }
  };
  return {
    dispose(): Promise<void> {
      disposePromise ??= disposeResources();
      return disposePromise;
    },
  };
}

if (import.meta.main) {
  const lifecycle = await bootServer();
  let shuttingDown = false;
  const shutdown = async (): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    try {
      await lifecycle.dispose();
    } catch (error) {
      console.error(error);
      process.exitCode = 1;
    }
  };
  process.once("SIGINT", () => void shutdown());
  process.once("SIGTERM", () => void shutdown());
}
