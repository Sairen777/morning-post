import { Hono, type MiddlewareHandler } from "hono";
import { z } from "zod";
import type { Database } from "../../db/client.ts";
import { getConfig, getXBrowserConfig } from "../../config.ts";
import type { TelegramLoginSessionManager } from "../../connectors/telegram/login-session.ts";
import {
  type SubstackCredentials,
  substackCredentialSchema,
} from "../../connectors/credential-schemas.ts";
import type { AvailableFeed } from "../../connectors/connector.types.ts";
import { CredentialCipher } from "../../crypto/credential-cipher.ts";
import { EnvMasterKeyProvider } from "../../crypto/key-provider.ts";
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
import {
  type XLoginSessionStatus,
  XLoginSessionManager,
} from "../../services/x-login-service.ts";
import { XTargetService } from "../../services/x-target-service.ts";
import { type AuthVariables, requireAuth } from "../middleware/require-auth.ts";
import { createRateLimitMiddleware } from "../middleware/rate-limit.ts";
import { validate } from "../validate.ts";

const loginSessionParamsSchema = z.object({
  id: z.string().uuid("id must be a valid UUID"),
});

const xLoginSessionParamsSchema = z.object({
  sessionId: z.string().uuid("sessionId must be a valid UUID"),
});

const xTargetBodySchema = z.object({
  sourceId: z.string().uuid("sourceId must be a valid UUID"),
  url: z.string().min(1, "url is required").max(2_048),
}).strict();

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

export interface XLoginSessionManagerLike {
  startLogin(userId: string, signal?: AbortSignal): Promise<XLoginSessionStatus>;
  getStatus(sessionId: string, userId: string): Promise<XLoginSessionStatus>;
  verify(
    sessionId: string,
    userId: string,
    signal?: AbortSignal,
  ): Promise<XLoginSessionStatus>;
  cancel(sessionId: string, userId: string): Promise<void>;
}

export interface XTargetServiceLike {
  add(
    userId: string,
    sourceId: string,
    url: string,
    signal?: AbortSignal,
    commitOperation?: ConnectorCommit,
  ): Promise<PublicFeed>;
}

export type ConnectorDeadlineScheduler = (
  onDeadline: () => void,
  timeoutMs: number,
) => () => void;

export interface ConnectorRouteDependencies {
  telegramLoginSessionManager?: TelegramLoginSessionManager;
  telegramLoginRateLimiter?: MiddlewareHandler;
  telegramTwoFactorRateLimiter?: MiddlewareHandler;
  xLoginSessionManager?: XLoginSessionManagerLike;
  xTargetService?: XTargetServiceLike;
  xLoginRateLimiter?: MiddlewareHandler;
  xLoginVerifyRateLimiter?: MiddlewareHandler;
  xTargetRateLimiter?: MiddlewareHandler;
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

function defaultXRateLimiter(
  database: Database,
  trustedProxyCount: number,
  bucket: "x-login" | "x-login-verify" | "x-target",
): MiddlewareHandler {
  return createRateLimitMiddleware({
    database,
    bucket,
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
  let xLoginSessionManager = dependencies.xLoginSessionManager;
  let xTargetService = dependencies.xTargetService;
  let defaultXServicesLoader:
    | Promise<{
      loginSessionManager: XLoginSessionManager;
      targetService: XTargetService;
    }>
    | undefined;
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
  const xLoginRateLimiter = dependencies.xLoginRateLimiter ??
    defaultXRateLimiter(database, trustedProxyCount, "x-login");
  const xLoginVerifyRateLimiter = dependencies.xLoginVerifyRateLimiter ??
    defaultXRateLimiter(database, trustedProxyCount, "x-login-verify");
  const xTargetRateLimiter = dependencies.xTargetRateLimiter ??
    defaultXRateLimiter(database, trustedProxyCount, "x-target");
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

  async function getDefaultXServices(): Promise<{
    loginSessionManager: XLoginSessionManager;
    targetService: XTargetService;
  }> {
    defaultXServicesLoader ??= (async () => {
      const { XBrowserRuntime } = await import(
        "../../connectors/x/index.ts"
      );
      const xBrowserConfig = getXBrowserConfig();
      const browserRuntime = new XBrowserRuntime({
        profileRoot: xBrowserConfig.profileRoot,
      });
      const credentialCipher = new CredentialCipher(
        new EnvMasterKeyProvider(),
      );
      return {
        loginSessionManager: new XLoginSessionManager({
          database,
          credentialCipher,
          browserRuntime,
          loginTimeoutMs: xBrowserConfig.loginTimeoutMs,
        }),
        targetService: new XTargetService({
          database,
          credentialCipher,
          browserRuntime,
        }),
      };
    })();
    return await defaultXServicesLoader;
  }

  async function getXLoginSessionManager(): Promise<XLoginSessionManagerLike> {
    if (xLoginSessionManager === undefined) {
      xLoginSessionManager =
        (await getDefaultXServices()).loginSessionManager;
    }
    return xLoginSessionManager;
  }

  async function getXTargetService(): Promise<XTargetServiceLike> {
    if (xTargetService === undefined) {
      xTargetService = (await getDefaultXServices()).targetService;
    }
    return xTargetService;
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

  routes.post("/x/login", xLoginRateLimiter, async (context) => {
    const manager = await getXLoginSessionManager();
    const status = await manager.startLogin(
      context.var.userId,
      context.req.raw.signal,
    );
    return context.json(status, 202);
  });

  routes.get("/x/login/:sessionId", async (context) => {
    const { sessionId } = validate(
      xLoginSessionParamsSchema,
      context.req.param(),
    );
    const manager = await getXLoginSessionManager();
    const status = await manager.getStatus(sessionId, context.var.userId);
    return context.json(status, 200);
  });

  routes.post(
    "/x/login/:sessionId/verify",
    xLoginVerifyRateLimiter,
    async (context) => {
      const { sessionId } = validate(
        xLoginSessionParamsSchema,
        context.req.param(),
      );
      const manager = await getXLoginSessionManager();
      const status = await manager.verify(
        sessionId,
        context.var.userId,
        context.req.raw.signal,
      );
      return context.json(status, 200);
    },
  );

  routes.delete("/x/login/:sessionId", async (context) => {
    const { sessionId } = validate(
      xLoginSessionParamsSchema,
      context.req.param(),
    );
    const manager = await getXLoginSessionManager();
    await manager.cancel(sessionId, context.var.userId);
    return context.body(null, 204);
  });

  routes.post("/x/targets", xTargetRateLimiter, async (context) => {
    const { sourceId, url } = validate(
      xTargetBodySchema,
      await context.req.json(),
    );
    const feed = await withConnectorDeadline(
      context.req.raw.signal,
      connectorTimeoutMs,
      connectorDeadlineScheduler,
      (signal, commitOperation) =>
        getXTargetService().then((service) =>
          service.add(
            context.var.userId,
            sourceId,
            url,
            signal,
            commitOperation,
          )
        ),
    );
    return context.json(feed, 201);
  });

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
