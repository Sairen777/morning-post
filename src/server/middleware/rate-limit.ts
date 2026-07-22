import type { Context, MiddlewareHandler } from "hono";
import { getConnInfo } from "hono/bun";
import type { Database } from "../../db/client.ts";
import { consumeRateLimit } from "../../repositories/rate-limit-repository.ts";
import { RateLimitError } from "../errors.ts";

export interface RateLimitOptions {
  database: Database;
  bucket: string;
  limit: number;
  windowMs: number;
  now?: () => number;
  key?: (context: Context) => string;
  trustedProxyCount?: number;
}

/**
 * Resolve the client address without trusting spoofable forwarding headers by
 * default. Forwarded hops are considered only when the deployment explicitly
 * configures a trusted proxy chain.
 */
export function resolveClientAddress(context: Context, trustedProxyCount: number): string {
  let directAddress: string | undefined;
  try {
    directAddress = getConnInfo(context).remote.address?.trim() || undefined;
  } catch {
    // Hono's in-memory Request adapter has no Bun server binding. Production
    // Bun.serve requests always provide one.
  }

  if (trustedProxyCount <= 0) {
    return directAddress ?? "global";
  }

  const forwardedFor = context.req.header("x-forwarded-for");
  if (forwardedFor) {
    const hops = forwardedFor.split(",").map((hop) => hop.trim()).filter(Boolean);
    if (hops.length > 0) {
      // The right-most trusted hops are proxies. Select the first untrusted
      // address to their left; clamp malformed/short chains to the leftmost.
      const index = Math.max(0, hops.length - trustedProxyCount - 1);
      return hops[index] ?? directAddress ?? "global";
    }
  }

  const realIp = context.req.header("x-real-ip")?.trim();
  return realIp || directAddress || "global";
}

export function createRateLimitMiddleware(options: RateLimitOptions): MiddlewareHandler {
  const now = options.now ?? Date.now;
  const trustedProxyCount = options.trustedProxyCount ?? 0;
  const key = options.key ?? ((context: Context) => resolveClientAddress(context, trustedProxyCount));

  return async (context, next) => {
    const currentTime = now();
    const bucketKey = `${options.bucket}:${key(context)}`;
    const allowed = await consumeRateLimit(
      options.database,
      bucketKey,
      options.limit,
      options.windowMs,
      currentTime,
    );
    if (!allowed) {
      throw new RateLimitError();
    }
    await next();
  };
}
