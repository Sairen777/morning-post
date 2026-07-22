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

function registerBody(email: string): Record<string, string> {
  return {
    name: "Ada Lovelace",
    email,
    password: PASSWORD,
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
    registerRateLimiter?: MiddlewareHandler;
    loginRateLimiter?: MiddlewareHandler;
  },
): Hono {
  const app = new Hono();
  app.onError(errorHandler);
  app.route("/auth", buildAuthRoutes(database, options));
  return app;
}

async function register(app: Hono, email: string): Promise<Response> {
  return await app.request("/auth/register", jsonBody(registerBody(email)));
}

async function login(app: Hono, email: string, password = PASSWORD): Promise<Response> {
  return await app.request("/auth/login", jsonBody({ email, password }));
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

test("register and login rate limits use separate buckets", async () => {
  await withTestDb(async (database) => {
    const app = buildAuthTestApp(database, {
      registerRateLimiter: createRateLimitMiddleware({
        database,
        bucket: "real-register-separate",
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

    const firstRegister = await register(app, "separate@example.com");
    const blockedRegister = await register(app, "blocked-register@example.com");
    const firstLogin = await login(app, "ghost@example.com");
    const blockedLogin = await login(app, "ghost@example.com");
    const stillBlockedRegister = await register(app, "still-blocked@example.com");

    assertEquals(firstRegister.status, 201);
    assertEquals(blockedRegister.status, 429);
    assertEquals(firstLogin.status, 401);
    assertEquals(blockedLogin.status, 429);
    assertEquals(stillBlockedRegister.status, 429);
  });
});

test("real auth route limits reset deterministically after the window", async () => {
  await withTestDb(async (database) => {
    let currentTime = 1_000;
    const app = buildAuthTestApp(database, {
      registerRateLimiter: noRateLimit(),
      loginRateLimiter: createRateLimitMiddleware({
        bucket: "real-login-reset",
        database,
        limit: 1,
        windowMs: 60_000,
        now: () => currentTime,
      }),
    });

    const first = await login(app, "ghost@example.com");
    const blocked = await login(app, "ghost@example.com");
    currentTime += 60_000;
    const afterReset = await login(app, "ghost@example.com");

    assertEquals(first.status, 401);
    assertEquals(blocked.status, 429);
    assertEquals(afterReset.status, 401);
  });
});

test("real auth route keeps different forwarded IP keys separate", async () => {
  await withTestDb(async (database) => {
    const app = buildAuthTestApp(database, {
      registerRateLimiter: createRateLimitMiddleware({
        bucket: "real-register-ip-keys",
        trustedProxyCount: 1,
        database,
        limit: 1,
        windowMs: 60_000,
        now: () => 1_000,
      }),
      loginRateLimiter: noRateLimit(),
    });

    const first = await app.request("/auth/register", {
      ...jsonBody(registerBody("ip-one@example.com")),
      headers: { "content-type": "application/json", Origin: "http://127.0.0.1:5173", "x-forwarded-for": "203.0.113.10" },
    });
    const sameIp = await app.request("/auth/register", {
      ...jsonBody(registerBody("same-ip@example.com")),
      headers: { "content-type": "application/json", Origin: "http://127.0.0.1:5173", "x-forwarded-for": "203.0.113.10" },
    });
    const differentIp = await app.request("/auth/register", {
      ...jsonBody(registerBody("ip-two@example.com")),
      headers: { "content-type": "application/json", Origin: "http://127.0.0.1:5173", "x-forwarded-for": "203.0.113.11" },
    });

    assertEquals(first.status, 201);
    assertEquals(sameIp.status, 429);
    assertEquals(differentIp.status, 201);
  });
});

test("real login preserves identical credential errors until rate limited", async () => {
  await withTestDb(async (database) => {
    const app = buildAuthTestApp(database, {
      registerRateLimiter: noRateLimit(),
      loginRateLimiter: createRateLimitMiddleware({
        bucket: "real-login-identical-errors",
        database,
        trustedProxyCount: 1,
        limit: 2,
        windowMs: 60_000,
        now: () => 1_000,
      }),
    });

    const registered = await register(app, "real-user@example.com");
    assertEquals(registered.status, 201);
    await registered.body?.cancel();

    const wrongPassword = await login(app, "real-user@example.com", "not-the-password");
    const unknownEmail = await login(app, "ghost@example.com");
    const rateLimitedWrongPassword = await login(app, "real-user@example.com", "not-the-password");
    const rateLimitedUnknownEmail = await login(app, "ghost@example.com");

    assertEquals(wrongPassword.status, 401);
    assertEquals(unknownEmail.status, 401);
    assertEquals(await wrongPassword.text(), await unknownEmail.text());

    assertEquals(rateLimitedWrongPassword.status, 429);
    assertEquals(rateLimitedUnknownEmail.status, 429);
    assertEquals(await rateLimitedWrongPassword.text(), await rateLimitedUnknownEmail.text());
  });
});
test("separate app instances share default auth rate limiter counters", async () => {
  await withTestDb(async (database) => {
    // Build app A with default limiters (no overrides)
    const appA = buildAuthTestApp(database, {});

    // Same forwarded IP for the whole test
    const ip = "10.0.0.1";
    const requestOpts = (email: string) => ({
      ...jsonBody(registerBody(email)),
      headers: { "content-type": "application/json", Origin: "http://127.0.0.1:5173", "x-forwarded-for": ip },
    });

    // Exhaust app A's default register limiter (limit=5)
    for (let i = 0; i < 5; i++) {
      const response = await appA.request("/auth/register", requestOpts(`isolated-a-${i}@example.com`));
      assertEquals(response.status, 201, `request ${i + 1} should succeed on app A`);
      await response.body?.cancel();
    }

    // 6th request hits the default limit
    const blocked = await appA.request("/auth/register", requestOpts("isolated-a-blocked@example.com"));
    assertEquals(blocked.status, 429);
    await blocked.body?.cancel();

    // Build app B separately — the DB-backed bucket namespace is shared.
    const appB = buildAuthTestApp(database, {});

    const blockedAcrossInstances = await appB.request("/auth/register", requestOpts("isolated-b-fresh@example.com"));
    assertEquals(blockedAcrossInstances.status, 429, "separate app instances should share rate limit state");
    await blockedAcrossInstances.body?.cancel();
  });
});
