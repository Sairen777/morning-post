import { Hono, type MiddlewareHandler } from "hono";
import { z } from "zod";
import type { Database } from "../../db/client.ts";
import { getConfig } from "../../config.ts";
import { findOwner, type User } from "../../repositories/user-repository.ts";
import { setupOwner } from "../../services/owner-setup-service.ts";
import { authenticateOwner } from "../../services/login-service.ts";
import { getProfile, updateProfile } from "../../services/profile-service.ts";
import {
  clearSessionCookie,
  createSession,
  readSessionToken,
  revokeSessionToken,
  setSessionCookie,
} from "../../auth/session-service.ts";
import {
  type AuthVariables,
  requireAuth,
} from "../middleware/require-auth.ts";
import { createRateLimitMiddleware } from "../middleware/rate-limit.ts";
import { AuthError } from "../errors.ts";
import { validate } from "../validate.ts";
import { normalizeInterestPrompt } from "../../summarizers/prompts.ts";
import type { StoryDetailLevel } from "../../story-detail-level.ts";

export interface PublicUser {
  id: string;
  name: string;
  systemPrompt: string;
  summaryPrompt: string;
  defaultLanguage: string | null;
  defaultRelevanceFilterMode: "personalized" | "include_all";
  storyDetailLevel: StoryDetailLevel;
  relevanceThreshold: number;
  maximumStoriesPerDigest: number | null;
  interestProfileVersion: number;
  createdAt: number;
  updatedAt: number;
}

// Structurally projects a user to the fields safe to expose. Listing the fields
// explicitly (rather than deleting passwordHash) guarantees no secret ever
// reaches the response, even if the row gains new sensitive columns later.
export function toPublicUser(user: User): PublicUser {
  return {
    id: user.id,
    name: user.name,
    systemPrompt: normalizeInterestPrompt(user.systemPrompt),
    summaryPrompt: user.summaryPrompt,
    defaultLanguage: user.defaultLanguage,
    defaultRelevanceFilterMode: user.defaultRelevanceFilterMode,
    storyDetailLevel: user.storyDetailLevel,
    relevanceThreshold: user.relevanceThreshold,
    maximumStoriesPerDigest: user.maximumStoriesPerDigest,
    interestProfileVersion: user.interestProfileVersion,
    createdAt: user.createdAt,
    updatedAt: user.updatedAt,
  };
}

const loginSchema = z.object({
  password: z.string().optional(),
}).strict();

const INVALID_PASSWORD = "invalid password";

export interface AuthRouteOptions {
  setupRateLimiter?: MiddlewareHandler;
  loginRateLimiter?: MiddlewareHandler;
  trustedProxyCount?: number;
}

const AUTH_RATE_LIMIT = {
  limit: 5,
  windowMs: 5 * 60_000,
};

function defaultSetupRateLimiter(database: Database, trustedProxyCount: number): MiddlewareHandler {
  return createRateLimitMiddleware({
    database,
    bucket: "auth-setup",
    trustedProxyCount,
    ...AUTH_RATE_LIMIT,
  });
}

function defaultLoginRateLimiter(database: Database, trustedProxyCount: number): MiddlewareHandler {
  return createRateLimitMiddleware({
    database,
    bucket: "auth-login",
    trustedProxyCount,
    ...AUTH_RATE_LIMIT,
  });
}

export function buildAuthRoutes(
  database: Database,
  options: AuthRouteOptions = {},
): Hono<{ Variables: AuthVariables }> {
  const routes = new Hono<{ Variables: AuthVariables }>();
  const trustedProxyCount = options.trustedProxyCount ?? getConfig().trustedProxyCount;
  const setupRateLimiter = options.setupRateLimiter ??
    defaultSetupRateLimiter(database, trustedProxyCount);
  const loginRateLimiter = options.loginRateLimiter ??
    defaultLoginRateLimiter(database, trustedProxyCount);



  routes.get("/setup", async (context) => {
    const owner = await findOwner(database);
    return context.json({
      setupRequired: owner === null,
      passwordRequired: owner !== null && owner.passwordHash !== null,
    }, 200);
  });

  routes.post("/setup", setupRateLimiter, async (context) => {
    const body = await context.req.json();
    const user = await setupOwner(database, body);
    const { token, expiresAt } = await createSession(database, user.id);
    setSessionCookie(context, token, expiresAt);
    return context.json(toPublicUser(user), 201);
  });

  routes.post("/login", loginRateLimiter, async (context) => {
    const body = await context.req.json();
    const { password } = validate(loginSchema, body);
    const user = await authenticateOwner(database, { password });
    if (!user) {
      throw new AuthError(INVALID_PASSWORD);
    }
    const { token, expiresAt } = await createSession(database, user.id);
    setSessionCookie(context, token, expiresAt);
    return context.json(toPublicUser(user), 200);
  });

  routes.post("/logout", async (context) => {
    const token = readSessionToken(context);
    if (token) {
      await revokeSessionToken(database, token);
    }
    clearSessionCookie(context);
    return context.body(null, 204);
  });

  routes.get("/me", requireAuth(database), async (context) => {
    const user = await getProfile(database, context.var.userId);
    return context.json(toPublicUser(user), 200);
  });

  routes.patch("/me", requireAuth(database), async (context) => {
    const body = await context.req.json();
    const user = await updateProfile(database, context.var.userId, body);
    return context.json(toPublicUser(user), 200);
  });

  return routes;
}
