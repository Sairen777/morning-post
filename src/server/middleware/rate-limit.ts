import type { Context, MiddlewareHandler } from "@hono/hono";
import { RateLimitError } from "../errors.ts";

interface RateLimitState {
  count: number;
  resetsAt: number;
}

const buckets = new Map<string, RateLimitState>();

export interface RateLimitOptions {
  bucket: string;
  limit: number;
  windowMs: number;
  now?: () => number;
  key?: (context: Context) => string;
}

function defaultKey(context: Context): string {
  const forwardedFor = context.req.header("x-forwarded-for");
  if (forwardedFor) {
    return forwardedFor.split(",", 1)[0].trim() || "global";
  }

  return context.req.header("x-real-ip")?.trim() || "global";
}

function pruneExpiredBuckets(now: number): void {
  for (const [key, state] of buckets) {
    if (now >= state.resetsAt) {
      buckets.delete(key);
    }
  }
}

export function createRateLimitMiddleware(options: RateLimitOptions): MiddlewareHandler {
  const now = options.now ?? Date.now;
  const key = options.key ?? defaultKey;

  return async (context, next) => {
    const currentTime = now();
    pruneExpiredBuckets(currentTime);

    const bucketKey = `${options.bucket}:${key(context)}`;
    const currentState = buckets.get(bucketKey);
    const state = currentState && currentTime < currentState.resetsAt
      ? currentState
      : { count: 0, resetsAt: currentTime + options.windowMs };

    state.count += 1;
    buckets.set(bucketKey, state);

    if (state.count > options.limit) {
      throw new RateLimitError();
    }

    await next();
  };
}
