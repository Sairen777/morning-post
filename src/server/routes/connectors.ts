import { Hono, type MiddlewareHandler } from "@hono/hono";
import { z } from "zod";
import type { Database } from "../../db/client.ts";
import {
  createDefaultTelegramLoginSessionManager,
  type TelegramLoginSessionManager,
} from "../../connectors/telegram/login-session.ts";
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

const CONNECTOR_RATE_LIMIT = {
  limit: 5,
  windowMs: 5 * 60_000,
};

export interface ConnectorRouteDependencies {
  telegramLoginSessionManager?: TelegramLoginSessionManager;
  telegramLoginRateLimiter?: MiddlewareHandler;
  telegramTwoFactorRateLimiter?: MiddlewareHandler;
}

function defaultTelegramLoginRateLimiter(instanceId: string): MiddlewareHandler {
  return createRateLimitMiddleware({
    bucket: `${instanceId}:telegram-login`,
    ...CONNECTOR_RATE_LIMIT,
  });
}

function defaultTelegramTwoFactorRateLimiter(instanceId: string): MiddlewareHandler {
  return createRateLimitMiddleware({
    bucket: `${instanceId}:telegram-two-factor`,
    ...CONNECTOR_RATE_LIMIT,
  });
}

export function buildConnectorRoutes(
  database: Database,
  dependencies: ConnectorRouteDependencies = {},
): Hono<{ Variables: AuthVariables }> {
  const routes = new Hono<{ Variables: AuthVariables }>();
  let telegramLoginSessionManager = dependencies.telegramLoginSessionManager;
  const instanceId = crypto.randomUUID();
  const telegramLoginRateLimiter = dependencies.telegramLoginRateLimiter ?? defaultTelegramLoginRateLimiter(instanceId);
  const telegramTwoFactorRateLimiter = dependencies.telegramTwoFactorRateLimiter ??
    defaultTelegramTwoFactorRateLimiter(instanceId);


  function getTelegramLoginSessionManager(): TelegramLoginSessionManager {
    telegramLoginSessionManager ??= createDefaultTelegramLoginSessionManager(database);
    return telegramLoginSessionManager;
  }

  routes.use("*", requireAuth(database));

  routes.post("/telegram/login", telegramLoginRateLimiter, async (context) => {
    const result = await getTelegramLoginSessionManager().startLogin(context.var.userId);
    return context.json(result, 201);
  });

  routes.get("/telegram/login/:id", async (context) => {
    const { id } = validate(loginSessionParamsSchema, context.req.param());
    const status = await getTelegramLoginSessionManager().getStatus(id, context.var.userId);
    return context.json(status, 200);
  });

  routes.post("/telegram/login/:id/2fa", telegramTwoFactorRateLimiter, async (context) => {
    const { id } = validate(loginSessionParamsSchema, context.req.param());
    const body = await context.req.json();
    const { password } = validate(twoFactorAuthenticationBodySchema, body);
    const status = await getTelegramLoginSessionManager().submitTwoFactorAuthentication(
      id,
      context.var.userId,
      password,
    );
    return context.json(status, status.status === "complete" || status.status === "error" ? 200 : 202);
  });

  return routes;
}
