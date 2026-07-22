import { createMiddleware } from "hono/factory";
import type { Database } from "../../db/client.ts";
import { AuthError } from "../errors.ts";
import {
  readSessionToken,
  setSessionCookie,
  validateSessionToken,
} from "../../auth/session-service.ts";

/** Hono context variables set by `requireAuth`. */
export interface AuthVariables {
  userId: string;
}

/**
 * Guards a route: reads the session cookie, validates it against the store, and
 * exposes the authenticated `userId` via `c.var.userId`. Any failure — missing,
 * expired, tampered, or unknown token — throws `AuthError` (401) with one
 * generic message, so the guard reveals nothing about why it rejected.
 */
export function requireAuth(database: Database) {
  return createMiddleware<{ Variables: AuthVariables }>(async (context, next) => {
    const token = readSessionToken(context);
    if (!token) {
      throw new AuthError();
    }
    const session = await validateSessionToken(database, token, Date.now());
    if (!session) {
      throw new AuthError();
    }
    context.set("userId", session.userId);
    if (session.refreshExpiresAt !== null) {
      setSessionCookie(context, session.token, session.refreshExpiresAt);
    }
    await next();
  });
}
