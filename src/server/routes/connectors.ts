import { Hono, type MiddlewareHandler } from "@hono/hono";
import { z } from "zod";
import type { Database } from "../../db/client.ts";
import { getConfig } from "../../config.ts";
import type { TelegramLoginSessionManager } from "../../connectors/telegram/login-session.ts";
import {
  type SubstackCredentials,
  substackCredentialSchema,
} from "../../connectors/credential-schemas.ts";
import type { AvailableFeed } from "../../connectors/connector.types.ts";
import type { PublicFeed } from "../../repositories/feed-repository.ts";
import type { PublicSource } from "../../repositories/source-repository.ts";
import {
  type SubstackPublicationResult,
  SubstackPublicationService,
} from "../../services/substack-publication-service.ts";
import {
  SubstackPublicationDiscoveryService,
} from "../../services/substack-publication-discovery-service.ts";
import { SubstackSessionService } from "../../services/substack-session-service.ts";
import type { ConnectorCommit } from "../../services/connector-commit.ts";
import { type AuthVariables, requireAuth } from "../middleware/require-auth.ts";
import { createRateLimitMiddleware } from "../middleware/rate-limit.ts";
import { validate } from "../validate.ts";

const loginSessionParamsSchema = z.object({
  id: z.string().uuid("id must be a valid UUID"),
});

const twoFactorAuthenticationBodySchema = z.object({
  password: z.string().min(1, "password is required"),
}).strict();
const publicationBodySchema = z.object({
  publicationUrl: z.string().min(1).max(2_048),
}).strict();

export interface SubstackSessionServiceLike {
  connect(
    userId: string,
    credentials: SubstackCredentials,
    signal?: AbortSignal,
    commitOperation?: ConnectorCommit,
  ): Promise<PublicSource>;
}

export interface SubstackPublicationServiceLike {
  add(
    userId: string,
    publicationUrl: string,
    signal?: AbortSignal,
    commitOperation?: ConnectorCommit,
  ): Promise<
    SubstackPublicationResult | { source: PublicSource; feed: PublicFeed }
  >;
}

export interface SubstackPublicationDiscoveryServiceLike {
  list(userId: string, signal?: AbortSignal): Promise<AvailableFeed[]>;
}

export type ConnectorDeadlineScheduler = (
  onDeadline: () => void,
  timeoutMs: number,
) => () => void;

export interface ConnectorRouteDependencies {
  telegramLoginSessionManager?: TelegramLoginSessionManager;
  telegramLoginRateLimiter?: MiddlewareHandler;
  telegramTwoFactorRateLimiter?: MiddlewareHandler;
  substackSessionService?: SubstackSessionServiceLike;
  substackPublicationService?: SubstackPublicationServiceLike;
  substackPublicationDiscoveryService?: SubstackPublicationDiscoveryServiceLike;
  substackSessionRateLimiter?: MiddlewareHandler;
  substackPublicationRateLimiter?: MiddlewareHandler;
  substackPublicationDiscoveryRateLimiter?: MiddlewareHandler;
  connectorTimeoutMs?: number;
  scheduleConnectorDeadline?: ConnectorDeadlineScheduler;
  trustedProxyCount?: number;
}

const CONNECTOR_RATE_LIMIT = {
  limit: 5,
  windowMs: 5 * 60_000,
};

function defaultTelegramLoginRateLimiter(
  database: Database,
  trustedProxyCount: number,
): MiddlewareHandler {
  return createRateLimitMiddleware({
    database,
    bucket: "telegram-login",
    trustedProxyCount,
    ...CONNECTOR_RATE_LIMIT,
  });
}

function defaultTelegramTwoFactorRateLimiter(
  database: Database,
  trustedProxyCount: number,
): MiddlewareHandler {
  return createRateLimitMiddleware({
    database,
    bucket: "telegram-two-factor",
    trustedProxyCount,
    ...CONNECTOR_RATE_LIMIT,
  });
}
function defaultSubstackSessionRateLimiter(
  database: Database,
  trustedProxyCount: number,
): MiddlewareHandler {
  return createRateLimitMiddleware({
    database,
    bucket: "substack-session",
    trustedProxyCount,
    ...CONNECTOR_RATE_LIMIT,
  });
}

function defaultSubstackPublicationRateLimiter(
  database: Database,
  trustedProxyCount: number,
): MiddlewareHandler {
  return createRateLimitMiddleware({
    database,
    bucket: "substack-publication",
    trustedProxyCount,
    ...CONNECTOR_RATE_LIMIT,
  });
}

function defaultSubstackPublicationDiscoveryRateLimiter(
  database: Database,
  trustedProxyCount: number,
): MiddlewareHandler {
  return createRateLimitMiddleware({
    database,
    bucket: "substack-publication-discovery",
    trustedProxyCount,
    ...CONNECTOR_RATE_LIMIT,
  });
}

const scheduleConnectorDeadline: ConnectorDeadlineScheduler = (
  onDeadline,
  timeoutMs,
) => {
  const timer = setTimeout(onDeadline, timeoutMs);
  return () => clearTimeout(timer);
};

async function withConnectorDeadline<T>(
  requestSignal: AbortSignal,
  timeoutMs: number,
  scheduleDeadline: ConnectorDeadlineScheduler,
  operation: (
    signal: AbortSignal,
    commitOperation: ConnectorCommit,
  ) => Promise<T>,
): Promise<T> {
  const controller = new AbortController();
  const deadline = Promise.withResolvers<never>();
  let deadlineActive = true;
  const cancelScheduledDeadline = scheduleDeadline(() => {
    if (!deadlineActive) {
      return;
    }
    deadlineActive = false;
    const error = new Error("connector deadline exceeded");
    controller.abort(error);
    deadline.reject(error);
  }, timeoutMs);
  const cancelDeadline = () => {
    if (!deadlineActive) {
      return;
    }
    deadlineActive = false;
    cancelScheduledDeadline();
  };
  const operationSignal = AbortSignal.any([requestSignal, controller.signal]);
  const commitOperation: ConnectorCommit = async (commit) => {
    if (operationSignal.aborted) {
      throw operationSignal.reason instanceof Error
        ? operationSignal.reason
        : new Error("connector operation aborted");
    }
    cancelDeadline();
    return await commit();
  };
  try {
    const result = operation(operationSignal, commitOperation);
    return await Promise.race([result, deadline.promise]);
  } finally {
    cancelDeadline();
  }
}

export function buildConnectorRoutes(
  database: Database,
  dependencies: ConnectorRouteDependencies = {},
): Hono<{ Variables: AuthVariables }> {
  const routes = new Hono<{ Variables: AuthVariables }>();
  routes.use("*", requireAuth(database));
  let telegramLoginSessionManager = dependencies.telegramLoginSessionManager;
  let telegramLoginSessionManagerLoader:
    | Promise<TelegramLoginSessionManager>
    | undefined;
  let substackSessionService = dependencies.substackSessionService;
  let substackPublicationService = dependencies.substackPublicationService;
  let substackPublicationDiscoveryService =
    dependencies.substackPublicationDiscoveryService;
  const trustedProxyCount = dependencies.trustedProxyCount ??
    getConfig().trustedProxyCount;
  const telegramLoginRateLimiter = dependencies.telegramLoginRateLimiter ??
    defaultTelegramLoginRateLimiter(database, trustedProxyCount);
  const telegramTwoFactorRateLimiter =
    dependencies.telegramTwoFactorRateLimiter ??
      defaultTelegramTwoFactorRateLimiter(database, trustedProxyCount);
  const substackSessionRateLimiter = dependencies.substackSessionRateLimiter ??
    defaultSubstackSessionRateLimiter(database, trustedProxyCount);
  const substackPublicationRateLimiter =
    dependencies.substackPublicationRateLimiter ??
      defaultSubstackPublicationRateLimiter(database, trustedProxyCount);
  const substackPublicationDiscoveryRateLimiter =
    dependencies.substackPublicationDiscoveryRateLimiter ??
      defaultSubstackPublicationDiscoveryRateLimiter(
        database,
        trustedProxyCount,
      );
  const connectorTimeoutMs = dependencies.connectorTimeoutMs ??
    getConfig().connectorTimeoutMs;
  const connectorDeadlineScheduler = dependencies.scheduleConnectorDeadline ??
    scheduleConnectorDeadline;

  async function getTelegramLoginSessionManager(): Promise<
    TelegramLoginSessionManager
  > {
    if (telegramLoginSessionManager === undefined) {
      telegramLoginSessionManagerLoader ??= (async () => {
        try {
          // Deliberately lazy: Telegram login loads the GramJS runtime only at its use boundary.
          const { createDefaultTelegramLoginSessionManager } = await import(
            "../../connectors/telegram/login-session.ts"
          );
          return createDefaultTelegramLoginSessionManager(database);
        } catch (error) {
          throw new Error("Failed to load Telegram login session manager", {
            cause: error,
          });
        }
      })();
      telegramLoginSessionManager = await telegramLoginSessionManagerLoader;
    }
    return telegramLoginSessionManager;
  }

  function getSubstackSessionService(): SubstackSessionServiceLike {
    substackSessionService ??= new SubstackSessionService(database);
    return substackSessionService;
  }

  function getSubstackPublicationService(): SubstackPublicationServiceLike {
    substackPublicationService ??= new SubstackPublicationService(database);
    return substackPublicationService;
  }

  function getSubstackPublicationDiscoveryService(): SubstackPublicationDiscoveryServiceLike {
    substackPublicationDiscoveryService ??=
      new SubstackPublicationDiscoveryService(database);
    return substackPublicationDiscoveryService;
  }

  routes.post("/telegram/login", telegramLoginRateLimiter, async (context) => {
    const manager = await getTelegramLoginSessionManager();
    const result = await manager.startLogin(context.var.userId);
    return context.json(result, 201);
  });

  routes.get("/telegram/login/:id", async (context) => {
    const { id } = validate(loginSessionParamsSchema, context.req.param());
    const manager = await getTelegramLoginSessionManager();
    const status = await manager.getStatus(id, context.var.userId);
    return context.json(status, 200);
  });

  routes.post(
    "/telegram/login/:id/2fa",
    telegramTwoFactorRateLimiter,
    async (context) => {
      const { id } = validate(loginSessionParamsSchema, context.req.param());
      const body = await context.req.json();
      const { password } = validate(twoFactorAuthenticationBodySchema, body);
      const manager = await getTelegramLoginSessionManager();
      const status = await manager.submitTwoFactorAuthentication(
        id,
        context.var.userId,
        password,
      );
      return context.json(
        status,
        status.status === "complete" || status.status === "error" ? 200 : 202,
      );
    },
  );

  routes.post(
    "/substack/session",
    substackSessionRateLimiter,
    async (context) => {
      const body = await context.req.json();
      const credentials = validate(substackCredentialSchema, body);
      const source = await withConnectorDeadline(
        context.req.raw.signal,
        connectorTimeoutMs,
        connectorDeadlineScheduler,
        (signal, commitOperation) =>
          getSubstackSessionService().connect(
            context.var.userId,
            credentials,
            signal,
            commitOperation,
          ),
      );
      return context.json({ source }, 200);
    },
  );

  routes.get(
    "/substack/publications",
    substackPublicationDiscoveryRateLimiter,
    async (context) => {
      const publications = await withConnectorDeadline(
        context.req.raw.signal,
        connectorTimeoutMs,
        connectorDeadlineScheduler,
        (signal) =>
          getSubstackPublicationDiscoveryService().list(
            context.var.userId,
            signal,
          ),
      );
      return context.json(publications, 200);
    },
  );

  routes.post(
    "/substack/publications",
    substackPublicationRateLimiter,
    async (context) => {
      const body = await context.req.json();
      const { publicationUrl } = validate(publicationBodySchema, body);
      const result = await withConnectorDeadline(
        context.req.raw.signal,
        connectorTimeoutMs,
        connectorDeadlineScheduler,
        (signal, commitOperation) =>
          getSubstackPublicationService().add(
            context.var.userId,
            publicationUrl,
            signal,
            commitOperation,
          ),
      );
      return context.json(result, 201);
    },
  );

  return routes;
}
