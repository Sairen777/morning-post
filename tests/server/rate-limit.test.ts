import { test } from "bun:test";
import { assertEquals } from "../assertions.ts";
import { Hono, type Context, type MiddlewareHandler } from "hono";
import { createRateLimitMiddleware, resolveClientAddress } from "../../src/server/middleware/rate-limit.ts";
import { errorHandler } from "../../src/server/errors.ts";
import { buildAuthRoutes } from "../../src/server/routes/auth.ts";
import { withTestDb } from "../../src/db/testing.ts";
import type { ServerBindings } from "../../src/server/app.ts";
import type { Database } from "../../src/db/client.ts";

const PASSWORD = "analytical-engine-1843";

function noRateLimit(): MiddlewareHandler {
  return async (_context, next) => {
    await next();
  };
}

function jsonBody(body: unknown): RequestInit {
  return {
    method: "POST",
    headers: { "content-type": "application/json", Origin: "http://127.0.0.1:5173" },
    body: JSON.stringify(body),
  };
}

function setupBody(): Record<string, string> {
  return {
    name: "Ada Lovelace",
  };
}

function buildRateLimitedTestApp(
  database: Database,
  options: {
    bucket: string;
    limit: number;
    windowMs: number;
    now: () => number;
    trustedProxyCount?: number;
    key?: (context: Context) => string;
  },
): Hono {
  const app = new Hono();
  app.onError(errorHandler);
  app.get(
    "/limited",
    createRateLimitMiddleware({ database, ...options }),
    (context) => context.json({ ok: true }),
  );
  return app;
}

function buildAuthTestApp(
  database: Database,
  options: {
    setupRateLimiter?: MiddlewareHandler;
    loginRateLimiter?: MiddlewareHandler;
  },
): Hono {
  const app = new Hono();
  app.onError(errorHandler);
  app.route("/auth", buildAuthRoutes(database, options));
  return app;
}

async function setupUser(app: Hono): Promise<Response> {
  return await app.request("/auth/setup", jsonBody(setupBody()));
}

async function loginWithPassword(app: Hono, password: string): Promise<Response> {
  return await app.request("/auth/login", jsonBody({ password }));
}

 test("rate limit middleware allows requests until the threshold is crossed", async () => {
  await withTestDb(async (database) => {
    let currentTime = 1_000;
    const app = buildRateLimitedTestApp(database, {
      bucket: "middleware-threshold",
      limit: 2,
      windowMs: 60_000,
      now: () => currentTime,
    });
 
    const first = await app.request("/limited");
    const second = await app.request("/limited");
    const third = await app.request("/limited");
 
    assertEquals(first.status, 200);
    assertEquals(second.status, 200);
    assertEquals(third.status, 429);
    assertEquals(await third.json(), {
      error: { code: "RATE_LIMITED", message: "Too many requests" },
    });
 
    currentTime += 60_000;
    const reset = await app.request("/limited");
    assertEquals(reset.status, 200);
  });
 });

 test("rate limit middleware keys callers by forwarded IP", async () => {
  await withTestDb(async (database) => {
    const app = buildRateLimitedTestApp(database, {
      bucket: "middleware-ip-keys",
      limit: 1,
      windowMs: 60_000,
      now: () => 1_000,
      trustedProxyCount: 1,
    });
 
    const first = await app.request("/limited", {
      headers: { "x-forwarded-for": "203.0.113.1, 10.0.0.1" },
    });
    const sameForwardedIp = await app.request("/limited", {
      headers: { "x-forwarded-for": "203.0.113.1, 10.0.0.2" },
    });
    const differentForwardedIp = await app.request("/limited", {
      headers: { "x-forwarded-for": "203.0.113.2" },
    });
 
    assertEquals(first.status, 200);
    assertEquals(sameForwardedIp.status, 429);
    assertEquals(differentForwardedIp.status, 200);
  });
 });

 test("rate limit middleware ignores forwarded IP spoofing without trusted proxies", async () => {
  await withTestDb(async (database) => {
    const app = buildRateLimitedTestApp(database, {
      bucket: "middleware-real-ip",
      limit: 1,
      windowMs: 60_000,
      now: () => 1_000,
      trustedProxyCount: 0,
    });
 
    const first = await app.request("/limited", {
      headers: { "x-real-ip": "198.51.100.1" },
    });
    const sameRealIp = await app.request("/limited", {
      headers: { "x-real-ip": "198.51.100.1" },
    });
    const differentRealIp = await app.request("/limited", {
      headers: { "x-real-ip": "198.51.100.2" },
    });
 
    assertEquals(first.status, 200);
    assertEquals(sameRealIp.status, 429);
    assertEquals(differentRealIp.status, 429);
  });
 });

test("in-memory Hono requests fall back to the global client key", async () => {
  const app = new Hono();
  app.get("/address", (context) =>
    context.json({ address: resolveClientAddress(context, 0) })
  );
  const response = await app.request("/address", {
    headers: { "x-forwarded-for": "198.51.100.20" },
  });
  assertEquals(await response.json(), { address: "global" });
});

test("Bun server binding supplies the socket address and ignores spoofed forwarding headers", async () => {
  const app = new Hono<{ Bindings: ServerBindings }>();
  app.get("/address", (context) =>
    context.json({ address: resolveClientAddress(context, 0) })
  );

  let callbackServer: Bun.Server<undefined> | undefined;
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(request, bunServer) {
      callbackServer = bunServer;
      return app.fetch(request, { server: bunServer });
    },
  });

  try {
    const response = await fetch(`http://127.0.0.1:${server.port}/address`, {
      headers: {
        "x-forwarded-for": "198.51.100.20",
        "x-real-ip": "198.51.100.21",
      },
    });
    assertEquals(response.status, 200);
    assertEquals(callbackServer, server);
    assertEquals(await response.json(), { address: "127.0.0.1" });
  } finally {
    await server.stop();
  }
});

test("setup and login rate limits use separate buckets", async () => {
  await withTestDb(async (database) => {
    const app = buildAuthTestApp(database, {
      setupRateLimiter: createRateLimitMiddleware({
        database,
        bucket: "real-setup-separate",
        limit: 1,
        windowMs: 60_000,
        now: () => 1_000,
      }),
      loginRateLimiter: createRateLimitMiddleware({
        bucket: "real-login-separate",
        database,
        limit: 1,
        windowMs: 60_000,
        now: () => 1_000,
      }),
    });

    const firstSetup = await setupUser(app);
    const blockedSetup = await setupUser(app);
    const firstLogin = await loginWithPassword(app, PASSWORD);
    const blockedLogin = await loginWithPassword(app, "wrong-password");
    const stillBlockedSetup = await setupUser(app);

    assertEquals(firstSetup.status, 201);
    assertEquals(blockedSetup.status, 429);
    assertEquals(firstLogin.status, 200);
    assertEquals(blockedLogin.status, 429);
    assertEquals(stillBlockedSetup.status, 429);
  });
});
test("real auth route limits reset deterministically after the window", async () => {
  await withTestDb(async (database) => {
    let currentTime = 1_000;
    const app = buildAuthTestApp(database, {
      setupRateLimiter: noRateLimit(),
      loginRateLimiter: createRateLimitMiddleware({
        bucket: "real-login-reset",
        database,
        limit: 1,
        windowMs: 60_000,
        now: () => currentTime,
      }),
    });

    const first = await loginWithPassword(app, "wrong-password");
    const blocked = await loginWithPassword(app, "wrong-password");
    currentTime += 60_000;
    const afterReset = await loginWithPassword(app, "wrong-password");

    assertEquals(first.status, 401);
    assertEquals(blocked.status, 429);
    assertEquals(afterReset.status, 401);
  });
});
test("real auth route keeps different forwarded IP keys separate", async () => {
  await withTestDb(async (database) => {
    const app = buildAuthTestApp(database, {
      setupRateLimiter: createRateLimitMiddleware({
        bucket: "real-setup-ip-keys",
        trustedProxyCount: 1,
        database,
        limit: 1,
        windowMs: 60_000,
        now: () => 1_000,
      }),
      loginRateLimiter: noRateLimit(),
    });

    const first = await app.request("/auth/setup", {
      ...jsonBody(setupBody()),
      headers: { "content-type": "application/json", Origin: "http://127.0.0.1:5173", "x-forwarded-for": "203.0.113.10" },
    });
    const sameIp = await app.request("/auth/setup", {
      ...jsonBody(setupBody()),
      headers: { "content-type": "application/json", Origin: "http://127.0.0.1:5173", "x-forwarded-for": "203.0.113.10" },
    });
    const differentIp = await app.request("/auth/setup", {
      ...jsonBody(setupBody()),
      headers: { "content-type": "application/json", Origin: "http://127.0.0.1:5173", "x-forwarded-for": "203.0.113.11" },
    });

    assertEquals(first.status, 201);
    assertEquals(sameIp.status, 429);
    assertEquals(differentIp.status, 409);
  });
});
test("real login preserves identical missing-owner errors until rate limited", async () => {
  await withTestDb(async (database) => {
    const app = buildAuthTestApp(database, {
      setupRateLimiter: noRateLimit(),
      loginRateLimiter: createRateLimitMiddleware({
        bucket: "real-login-identical-errors",
        database,
        trustedProxyCount: 1,
        limit: 2,
        windowMs: 60_000,
        now: () => 1_000,
      }),
    });


    const wrongFirst = await loginWithPassword(app, "not-the-password");
    const wrongSecond = await loginWithPassword(app, "also-wrong");
    const rateLimitedFirst = await loginWithPassword(app, "not-the-password");
    const rateLimitedSecond = await loginWithPassword(app, "still-wrong");

    assertEquals(wrongFirst.status, 401);
    assertEquals(wrongSecond.status, 401);
    assertEquals(await wrongFirst.text(), await wrongSecond.text());

    assertEquals(rateLimitedFirst.status, 429);
    assertEquals(rateLimitedSecond.status, 429);
    assertEquals(await rateLimitedFirst.text(), await rateLimitedSecond.text());
  });
});
test("separate app instances share default auth rate limiter counters", async () => {
  await withTestDb(async (database) => {
    // Build app A with default limiters (no overrides)
    const appA = buildAuthTestApp(database, {});

    // Same forwarded IP for the whole test
    const ip = "10.0.0.1";
    const requestOpts = () => ({
      ...jsonBody(setupBody()),
      headers: { "content-type": "application/json", Origin: "http://127.0.0.1:5173", "x-forwarded-for": ip },
    });

    // Exhaust app A's default setup limiter (limit=5)
    for (let i = 0; i < 5; i++) {
      const status = (await appA.request("/auth/setup", requestOpts())).status;
      assertEquals(status, i === 0 ? 201 : 409, `request ${i + 1} on app A`);
    }

    // 6th request hits the default limit
    const blocked = await appA.request("/auth/setup", requestOpts());
    assertEquals(blocked.status, 429);
    await blocked.body?.cancel();

    // Build app B separately — the DB-backed bucket namespace is shared.
    const appB = buildAuthTestApp(database, {});

    const blockedAcrossInstances = await appB.request("/auth/setup", requestOpts());
    assertEquals(blockedAcrossInstances.status, 429, "separate app instances should share rate limit state");
    await blockedAcrossInstances.body?.cancel();
  });
});
