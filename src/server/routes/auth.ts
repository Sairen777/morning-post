import { Hono, type MiddlewareHandler } from "@hono/hono";
import { z } from "zod";
import type { Database } from "../../db/client.ts";
import {
  type User,
} from "../../repositories/user-repository.ts";
import { registerUser } from "../../services/registration-service.ts";
import { authenticateUser } from "../../services/login-service.ts";
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

export interface PublicUser {
  id: string;
  name: string;
  email: string;
  systemPrompt: string;
  defaultLanguage: string | null;
  defaultModel: string | null;
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
    email: user.email,
    systemPrompt: user.systemPrompt,
    defaultLanguage: user.defaultLanguage,
    defaultModel: user.defaultModel,
    createdAt: user.createdAt,
    updatedAt: user.updatedAt,
  };
}

const loginSchema = z.object({
  email: z.string().min(1, "email is required"),
  password: z.string().min(1, "password is required"),
});

// Single message for both unknown-email and wrong-password so the response is
// byte-identical in either case — no user enumeration.
const INVALID_CREDENTIALS = "invalid email or password";

export interface AuthRouteOptions {
  registerRateLimiter?: MiddlewareHandler;
  loginRateLimiter?: MiddlewareHandler;
}

const AUTH_RATE_LIMIT = {
  limit: 5,
  windowMs: 5 * 60_000,
};

function defaultRegisterRateLimiter(authInstanceId: string): MiddlewareHandler {
  return createRateLimitMiddleware({
    bucket: `${authInstanceId}:auth-register`,
    ...AUTH_RATE_LIMIT,
  });
}

function defaultLoginRateLimiter(authInstanceId: string): MiddlewareHandler {
  return createRateLimitMiddleware({
    bucket: `${authInstanceId}:auth-login`,
    ...AUTH_RATE_LIMIT,
  });
}


export function buildAuthRoutes(
  database: Database,
  options: AuthRouteOptions = {},
): Hono<{ Variables: AuthVariables }> {
  const routes = new Hono<{ Variables: AuthVariables }>();
  const authInstanceId = crypto.randomUUID();
  const registerRateLimiter = options.registerRateLimiter ?? defaultRegisterRateLimiter(authInstanceId);
  const loginRateLimiter = options.loginRateLimiter ?? defaultLoginRateLimiter(authInstanceId);

  routes.post("/register", registerRateLimiter, async (context) => {
    const body = await context.req.json();
    const user = await registerUser(database, body);
    return context.json(toPublicUser(user), 201);
  });

  routes.post("/login", loginRateLimiter, async (context) => {
    const body = await context.req.json();
    const { email, password } = validate(loginSchema, body);
    const user = await authenticateUser(database, { email, password });
    if (!user) {
      throw new AuthError(INVALID_CREDENTIALS);
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
