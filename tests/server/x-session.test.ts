import { test } from "bun:test";
import { assertEquals, assertExists, assertStringIncludes } from "../assertions.ts";
import type { Hono, MiddlewareHandler } from "hono";
import { ConnectorId } from "../../src/constants.ts";
import { withTestDb } from "../../src/db/testing.ts";
import type { PublicSource } from "../../src/repositories/source-repository.ts";
import { buildApp } from "../../src/server/app.ts";
import type { ServerEnvironment } from "../../src/server/app.ts";
import { createRateLimitMiddleware } from "../../src/server/middleware/rate-limit.ts";
import type { XSessionServiceLike } from "../../src/server/routes/connectors.ts";
import type { XSessionInput } from "../../src/services/x-session-service.ts";
import { ValidationError } from "../../src/server/errors.ts";

const PASSWORD = "analytical-engine-1843";
const ORIGIN = "http://127.0.0.1:5173";
const API_KEY = "twex-api-key-route";
const AUTH_TOKEN = "x-auth-token-route";
const COOKIE = "auth_token=x-auth-token-route; ct0=csrf-token-route";

function xBody(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    apiKey: API_KEY,
    authToken: AUTH_TOKEN,
    cookie: COOKIE,
    ...overrides,
  };
}

function jsonRequest(body: unknown, cookie?: string): RequestInit {
  return {
    method: "POST",
    headers: {
      "content-type": "application/json",
      Origin: ORIGIN,
      ...(cookie ? { cookie } : {}),
    },
    body: JSON.stringify(body),
  };
}

function passRateLimit(): MiddlewareHandler {
  return async (_context, next) => await next();
}

async function registerAndLogin(
  app: Hono<ServerEnvironment>,
): Promise<{ userId: string; cookie: string }> {
  const registration = await app.request(
    "/auth/setup",
    jsonRequest({ name: "Ada Lovelace" }),
  );
  assertEquals(registration.status, 201);
  const user = await registration.json();
  const login = await app.request(
    "/auth/login",
    jsonRequest({ password: PASSWORD }),
  );
  assertEquals(login.status, 200);
  const setCookie = login.headers.get("set-cookie");
  assertExists(setCookie);
  return { userId: user.id, cookie: setCookie.split(";")[0] };
}

function sourceFor(userId: string): PublicSource {
  const now = Date.now();
  return {
    id: "00000000-0000-4000-8000-000000000211",
    userId,
    connectorId: ConnectorId.X,
    position: null,
    showPaidPostTitles: false,
    enabled: true,
    connected: true,
    relevanceFilterMode: "inherit",
    createdAt: now,
    updatedAt: now,
  };
}

test("POST /connectors/x/session validates the exact body shape and returns a secret-free source", async () => {
  await withTestDb(async (database) => {
    const calls: Array<{ userId: string; input: XSessionInput }> = [];
    const service: XSessionServiceLike = {
      connect: (userId, input) => {
        calls.push({ userId, input });
        return Promise.resolve(sourceFor(userId));
      },
    };
    const app = buildApp(database, {
      connectors: {
        xSessionService: service,
        xSessionRateLimiter: passRateLimit(),
      },
    }, { allowedOrigins: [ORIGIN], maxRequestBodyBytes: 1_000_000 });
    const { userId, cookie } = await registerAndLogin(app);

    const response = await app.request(
      "/connectors/x/session",
      jsonRequest(xBody({ pin: "9876", listQuery: "morning lists" }), cookie),
    );

    assertEquals(response.status, 200);
    const body = await response.json();
    assertEquals(body.source.connectorId, ConnectorId.X);
    assertEquals(body.source.userId, userId);
    // The response must not echo any secret material.
    const serialized = JSON.stringify(body);
    for (const secret of [API_KEY, AUTH_TOKEN, "csrf-token-route"]) {
      assertEquals(serialized.includes(secret), false, `leaked ${secret}`);
    }
    // The service received the parsed input unchanged and pinned to the user.
    assertEquals(calls, [{
      userId,
      input: {
        apiKey: API_KEY,
        authToken: AUTH_TOKEN,
        cookie: COOKIE,
        pin: "9876",
        listQuery: "morning lists",
      },
    }]);
  });
});

test("POST /connectors/x/session enforces auth, strict validation, and never calls the service on bad input", async () => {
  await withTestDb(async (database) => {
    let serviceCalls = 0;
    const service: XSessionServiceLike = {
      connect: () => {
        serviceCalls += 1;
        return Promise.reject(new Error("must not be called"));
      },
    };
    const app = buildApp(database, {
      connectors: {
        xSessionService: service,
        xSessionRateLimiter: passRateLimit(),
      },
    }, { allowedOrigins: [ORIGIN], maxRequestBodyBytes: 1_000_000 });

    const unauthenticated = await app.request(
      "/connectors/x/session",
      jsonRequest(xBody()),
    );
    assertEquals(unauthenticated.status, 401);

    const { cookie } = await registerAndLogin(app);

    const missingCookieCt0 = await app.request(
      "/connectors/x/session",
      jsonRequest(xBody({ cookie: "auth_token=x-auth-token-route" }), cookie),
    );
    assertEquals(missingCookieCt0.status, 422);

    const mismatchedAuthToken = await app.request(
      "/connectors/x/session",
      jsonRequest(
        xBody({ cookie: "auth_token=different-token; ct0=csrf-token-route" }),
        cookie,
      ),
    );
    assertEquals(mismatchedAuthToken.status, 422);

    const duplicateAuthToken = await app.request(
      "/connectors/x/session",
      jsonRequest(
        xBody({
          cookie:
            "auth_token=x-auth-token-route; auth_token=x-auth-token-route; ct0=csrf-token-route",
        }),
        cookie,
      ),
    );
    assertEquals(duplicateAuthToken.status, 422);
    const duplicateAuthTokenBody = await duplicateAuthToken.json();
    assertStringIncludes(
      duplicateAuthTokenBody.error.message,
      "exactly one auth_token pair",
    );

    const duplicateCt0 = await app.request(
      "/connectors/x/session",
      jsonRequest(
        xBody({
          cookie:
            "auth_token=x-auth-token-route; ct0=csrf-token-route; ct0=csrf-token-route",
        }),
        cookie,
      ),
    );
    assertEquals(duplicateCt0.status, 422);
    const duplicateCt0Body = await duplicateCt0.json();
    assertStringIncludes(
      duplicateCt0Body.error.message,
      "exactly one ct0 pair",
    );

    const controlCharacters = await app.request(
      "/connectors/x/session",
      jsonRequest(
        xBody({ cookie: "auth_token=x-auth-token-route; ct0=csrf-token-\u0000route" }),
        cookie,
      ),
    );
    assertEquals(controlCharacters.status, 422);
    const controlCharactersBody = await controlCharacters.json();
    assertStringIncludes(
      controlCharactersBody.error.message,
      "control characters",
    );

    const missingApiKey = await app.request(
      "/connectors/x/session",
      jsonRequest({ authToken: AUTH_TOKEN, cookie: COOKIE }, cookie),
    );
    assertEquals(missingApiKey.status, 422);

    const unknownKey = await app.request(
      "/connectors/x/session",
      jsonRequest(xBody({ profileId: "legacy" }), cookie),
    );
    assertEquals(unknownKey.status, 422);

    const malformed = await app.request("/connectors/x/session", {
      method: "POST",
      headers: { "content-type": "application/json", Origin: ORIGIN, cookie },
      body: "{",
    });
    assertEquals(malformed.status, 400);

    // Validation errors never echo the submitted secrets.
    const errorBodies = [
      await missingCookieCt0.json(),
      await mismatchedAuthToken.json(),
      duplicateAuthTokenBody,
      duplicateCt0Body,
      controlCharactersBody,
      await missingApiKey.json(),
      await unknownKey.json(),
    ];
    for (const errorBody of errorBodies) {
      const serialized = JSON.stringify(errorBody);
      for (const secret of [API_KEY, AUTH_TOKEN, "different-token"]) {
        assertEquals(serialized.includes(secret), false, `leaked ${secret}`);
      }
    }

    assertEquals(serviceCalls, 0);
  });
});

test("POST /connectors/x/session maps service failures without leaking secrets", async () => {
  await withTestDb(async (database) => {
    // Credential failures surface as 422 VALIDATION_ERROR with the generic
    // message the service produces; never the submitted secrets.
    const credentialFailure: XSessionServiceLike = {
      connect: () =>
        Promise.reject(
          new ValidationError("X credentials are invalid or expired"),
        ),
    };
    const app = buildApp(database, {
      connectors: {
        xSessionService: credentialFailure,
        xSessionRateLimiter: passRateLimit(),
      },
    }, { allowedOrigins: [ORIGIN], maxRequestBodyBytes: 1_000_000 });
    const { cookie } = await registerAndLogin(app);

    const credentialResponse = await app.request(
      "/connectors/x/session",
      jsonRequest(xBody(), cookie),
    );
    assertEquals(credentialResponse.status, 422);
    const credentialBody = await credentialResponse.json();
    assertEquals(credentialBody.error.code, "VALIDATION_ERROR");
    assertEquals(credentialBody.error.message, "X credentials are invalid or expired");
    assertEquals(
      JSON.stringify(credentialBody).includes(COOKIE),
      false,
      "error body leaked the cookie",
    );
  });
});

test("POST /connectors/x/session returns a fixed 500 for unexpected service errors", async () => {
  await withTestDb(async (database) => {
    const service: XSessionServiceLike = {
      connect: () => Promise.reject(new Error(`boom ${COOKIE}`)),
    };
    const app = buildApp(database, {
      connectors: {
        xSessionService: service,
        xSessionRateLimiter: passRateLimit(),
      },
    }, { allowedOrigins: [ORIGIN], maxRequestBodyBytes: 1_000_000 });
    const { cookie } = await registerAndLogin(app);

    const response = await app.request(
      "/connectors/x/session",
      jsonRequest(xBody(), cookie),
    );

    assertEquals(response.status, 500);
    const body = await response.json();
    assertEquals(body.error.code, "INTERNAL_ERROR");
    assertEquals(body.error.message, "Internal server error");
    assertEquals(
      JSON.stringify(body).includes(COOKIE),
      false,
      "error body leaked the cookie",
    );
  });
});

test("POST /connectors/x/session uses its own rate-limit bucket", async () => {
  await withTestDb(async (database) => {
    let now = 1_000;
    const service: XSessionServiceLike = {
      connect: (userId) => Promise.resolve(sourceFor(userId)),
    };
    const app = buildApp(database, {
      connectors: {
        xSessionService: service,
        xSessionRateLimiter: createRateLimitMiddleware({
          database,
          bucket: "x-session-route-test",
          limit: 1,
          windowMs: 60_000,
          now: () => now,
        }),
      },
    }, { allowedOrigins: [ORIGIN], maxRequestBodyBytes: 1_000_000 });
    const { cookie } = await registerAndLogin(app);

    const first = await app.request(
      "/connectors/x/session",
      jsonRequest(xBody(), cookie),
    );
    assertEquals(first.status, 200);

    const second = await app.request(
      "/connectors/x/session",
      jsonRequest(xBody(), cookie),
    );
    assertEquals(second.status, 429);

    now += 60_001;
    const third = await app.request(
      "/connectors/x/session",
      jsonRequest(xBody(), cookie),
    );
    assertEquals(third.status, 200);
  });
});
