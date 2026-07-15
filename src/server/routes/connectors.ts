import { Hono, type MiddlewareHandler } from "@hono/hono";
import { z } from "zod";
import type { Database } from "../../db/client.ts";
import { getConfig } from "../../config.ts";
import type { TelegramLoginSessionManager } from "../../connectors/telegram/login-session.ts";
import {
  type AuthVariables,
  requireAuth,
} from "../middleware/require-auth.ts";
import { createRateLimitMiddleware } from "../middleware/rate-limit.ts";
import { validate } from "../validate.ts";

const loginSessionParamsSchema = z.object({
  id: z.string().uuid("id must be a valid UUID"),
});

const twoFactorAuthenticationBodySchema = z.object({
  password: z.string().min(1, "password is required"),
}).strict();


export interface ConnectorRouteDependencies {
  telegramLoginSessionManager?: TelegramLoginSessionManager;
  telegramLoginRateLimiter?: MiddlewareHandler;
  telegramTwoFactorRateLimiter?: MiddlewareHandler;
  trustedProxyCount?: number;
}

const CONNECTOR_RATE_LIMIT = {
  limit: 5,
  windowMs: 5 * 60_000,
};

function defaultTelegramLoginRateLimiter(database: Database, trustedProxyCount: number): MiddlewareHandler {
  return createRateLimitMiddleware({
    database,
    bucket: "telegram-login",
    trustedProxyCount,
    ...CONNECTOR_RATE_LIMIT,
  });
}

function defaultTelegramTwoFactorRateLimiter(database: Database, trustedProxyCount: number): MiddlewareHandler {
  return createRateLimitMiddleware({
    database,
    bucket: "telegram-two-factor",
    trustedProxyCount,
    ...CONNECTOR_RATE_LIMIT,
  });
}

export function buildConnectorRoutes(
  database: Database,
  dependencies: ConnectorRouteDependencies = {},
): Hono<{ Variables: AuthVariables }> {
  const routes = new Hono<{ Variables: AuthVariables }>();
  let telegramLoginSessionManager = dependencies.telegramLoginSessionManager;
  let telegramLoginSessionManagerLoader: Promise<TelegramLoginSessionManager> | undefined;
  const trustedProxyCount = dependencies.trustedProxyCount ?? getConfig().trustedProxyCount;
  const telegramLoginRateLimiter = dependencies.telegramLoginRateLimiter ??
    defaultTelegramLoginRateLimiter(database, trustedProxyCount);
  const telegramTwoFactorRateLimiter = dependencies.telegramTwoFactorRateLimiter ??
    defaultTelegramTwoFactorRateLimiter(database, trustedProxyCount);

  async function getTelegramLoginSessionManager(): Promise<TelegramLoginSessionManager> {
    if (telegramLoginSessionManager === undefined) {
      telegramLoginSessionManagerLoader ??= (async () => {
        try {
          // Deliberately lazy: Telegram login loads the GramJS runtime only at its use boundary.
          const { createDefaultTelegramLoginSessionManager } = await import(
            "../../connectors/telegram/login-session.ts"
          );
          return createDefaultTelegramLoginSessionManager(database);
        } catch (error) {
          throw new Error("Failed to load Telegram login session manager", { cause: error });
        }
      })();
      telegramLoginSessionManager = await telegramLoginSessionManagerLoader;
    }
    return telegramLoginSessionManager;
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

  routes.post("/telegram/login/:id/2fa", telegramTwoFactorRateLimiter, async (context) => {
    const { id } = validate(loginSessionParamsSchema, context.req.param());
    const body = await context.req.json();
    const { password } = validate(twoFactorAuthenticationBodySchema, body);
    const manager = await getTelegramLoginSessionManager();
    const status = await manager.submitTwoFactorAuthentication(
      id,
      context.var.userId,
      password,
    );
    return context.json(status, status.status === "complete" || status.status === "error" ? 200 : 202);
  });

  return routes;
}
