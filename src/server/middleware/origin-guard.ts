import type { MiddlewareHandler } from "@hono/hono";
import { getCookie } from "@hono/hono/cookie";
import { SESSION_COOKIE } from "../../auth/session-service.ts";
import { AuthError } from "../errors.ts";

const SAFE_METHODS: Record<string, true> = { GET: true, HEAD: true, OPTIONS: true };

/**
 * Protects cookie-authenticated state-changing requests from cross-site writes.
 *
 * Browser requests include an Origin header for all fetch/XHR mutations. Older
 * user agents may omit Origin, so a Referer origin is accepted as a fallback;
 * the fallback is deliberately limited to the exact configured origins. The
 * guard does not apply to requests without the session cookie (for example,
 * login and registration) because those requests cannot act on a session.
 */
export function createOriginGuard(allowedOrigins: string[]): MiddlewareHandler {
  const origins = new Set(allowedOrigins);

  return async (context, next) => {
    if (SAFE_METHODS[context.req.method.toUpperCase()] === true) {
      await next();
      return;
    }

    if (getCookie(context, SESSION_COOKIE) === undefined) {
      await next();
      return;
    }

    const origin = context.req.header("Origin");
    if (origin !== undefined) {
      if (!origins.has(origin)) {
        throw new AuthError("Invalid request origin");
      }
      await next();
      return;
    }

    const referer = context.req.header("Referer");
    if (referer !== undefined) {
      try {
        if (origins.has(new URL(referer).origin)) {
          await next();
          return;
        }
      } catch {
        // Treat malformed Referer values exactly like mismatched origins.
      }
    }

    throw new AuthError("Invalid request origin");
  };
}
