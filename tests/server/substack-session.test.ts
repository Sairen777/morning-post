import { assertEquals, assertExists } from "@std/assert";
import type { Hono, MiddlewareHandler } from "@hono/hono";
import { ConnectorId } from "../../src/constants.ts";
import { withTestDb } from "../../src/db/testing.ts";
import type { PublicSource } from "../../src/repositories/source-repository.ts";
import { buildApp } from "../../src/server/app.ts";
import type { SubstackSessionServiceLike } from "../../src/server/routes/connectors.ts";

const PASSWORD = "analytical-engine-1843";
const ORIGIN = "http://127.0.0.1:5173";

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
  app: Hono,
  email: string,
): Promise<{ userId: string; cookie: string }> {
  const registration = await app.request(
    "/auth/register",
    jsonRequest({
      name: "Ada Lovelace",
      email,
      password: PASSWORD,
    }),
  );
  assertEquals(registration.status, 201);
  const user = await registration.json();
  const login = await app.request(
    "/auth/login",
    jsonRequest({ email, password: PASSWORD }),
  );
  assertEquals(login.status, 200);
  const setCookie = login.headers.get("set-cookie");
  assertExists(setCookie);
  return { userId: user.id, cookie: setCookie.split(";")[0] };
}

Deno.test("POST /connectors/substack/session validates and returns a secret-free source", async () => {
  await withTestDb(async (database) => {
    const calls: Array<{ userId: string; credentials: unknown }> = [];
    const service: SubstackSessionServiceLike = {
      connect: (userId, credentials) => {
        calls.push({ userId, credentials });
        const now = Date.now();
        return Promise.resolve(
          {
            id: "00000000-0000-4000-8000-000000000111",
            userId,
            connectorId: ConnectorId.Substack,
            position: null,
            showPaidPostTitles: false,
            enabled: true,
            connected: true,
            createdAt: now,
            updatedAt: now,
          } satisfies PublicSource,
        );
      },
    };
    const app = buildApp(database, {
      connectors: {
        substackSessionService: service,
        substackSessionRateLimiter: passRateLimit(),
        substackPublicationRateLimiter: passRateLimit(),
      },
    }, { allowedOrigins: [ORIGIN], maxRequestBodyBytes: 1_000_000 });
    const { userId, cookie } = await registerAndLogin(
      app,
      "substack-route@example.com",
    );
    const response = await app.request(
      "/connectors/substack/session",
      jsonRequest({
        substackSessionId: "s%3Asubstack.signature",
      }, cookie),
    );
    assertEquals(response.status, 200);
    const body = await response.json();
    assertEquals(body.source.connectorId, ConnectorId.Substack);
    assertEquals(JSON.stringify(body).includes("signature"), false);
    assertEquals(calls, [{
      userId,
      credentials: {
        substackSessionId: "s%3Asubstack.signature",
      },
    }]);
  });
});

Deno.test("Substack session route enforces Morning Post auth and strict body validation", async () => {
  await withTestDb(async (database) => {
    const service: SubstackSessionServiceLike = {
      connect: () => Promise.reject(new Error("must not be called")),
    };
    const app = buildApp(database, {
      connectors: {
        substackSessionService: service,
        substackSessionRateLimiter: passRateLimit(),
        substackPublicationRateLimiter: passRateLimit(),
      },
    }, { allowedOrigins: [ORIGIN], maxRequestBodyBytes: 1_000_000 });
    const unauthenticated = await app.request(
      "/connectors/substack/session",
      jsonRequest({ substackSessionId: "s%3Asubstack.signature" }),
    );
    assertEquals(unauthenticated.status, 401);

    const { cookie } = await registerAndLogin(
      app,
      "substack-route-validation@example.com",
    );

    const invalid = await app.request(
      "/connectors/substack/session",
      jsonRequest({
        substackSessionId: "s%3Asubstack.signature",
        connectSessionId: "s%3Aconnect.signature",
        rawCookieHeader: "other=secret",
      }, cookie),
    );
    assertEquals(invalid.status, 422);

    const malformed = await app.request("/connectors/substack/session", {
      method: "POST",
      headers: { "content-type": "application/json", Origin: ORIGIN, cookie },
      body: "{",
    });
    assertEquals(malformed.status, 400);
  });
});

Deno.test("Substack session route bounds services that ignore abort", async () => {
  await withTestDb(async (database) => {
    const service: SubstackSessionServiceLike = {
      connect: () => Promise.withResolvers<PublicSource>().promise,
    };
    const app = buildApp(database, {
      connectors: {
        substackSessionService: service,
        substackSessionRateLimiter: passRateLimit(),
        substackPublicationRateLimiter: passRateLimit(),
        connectorTimeoutMs: 10,
        scheduleConnectorDeadline: (onDeadline: () => void) => {
          queueMicrotask(onDeadline);
          return () => undefined;
        },
      },
    }, { allowedOrigins: [ORIGIN], maxRequestBodyBytes: 1_000_000 });
    const { cookie } = await registerAndLogin(
      app,
      "substack-route-timeout@example.com",
    );
    const response = await app.request(
      "/connectors/substack/session",
      jsonRequest({
        substackSessionId: "s%3Asubstack.signature",
        connectSessionId: "s%3Aconnect.signature",
      }, cookie),
    );
    assertEquals(response.status, 500);
  });
});

Deno.test("Substack session route cancels its deadline before a deferred credential commit", async () => {
  await withTestDb(async (database) => {
    const mutationStarted = Promise.withResolvers<void>();
    const mutation = Promise.withResolvers<PublicSource>();
    let deadlineCallback: (() => void) | undefined;
    let deadlineCancelled = false;
    const now = Date.now();
    const source: PublicSource = {
      id: "00000000-0000-4000-8000-000000000112",
      userId: "replaced-after-login",
      connectorId: ConnectorId.Substack,
      position: null,
      showPaidPostTitles: false,
      enabled: true,
      connected: true,
      createdAt: now,
      updatedAt: now,
    };
    const commitImmediately = async <Result>(
      operation: () => Promise<Result>,
    ): Promise<Result> => await operation();
    const service: SubstackSessionServiceLike = {
      connect: (
        userId,
        _credentials,
        _signal,
        commitOperation = commitImmediately,
      ) => {
        source.userId = userId;
        return commitOperation(async () => {
          mutationStarted.resolve();
          return await mutation.promise;
        });
      },
    };
    const app = buildApp(database, {
      connectors: {
        substackSessionService: service,
        substackSessionRateLimiter: passRateLimit(),
        substackPublicationRateLimiter: passRateLimit(),
        connectorTimeoutMs: 10,
        scheduleConnectorDeadline: (onDeadline) => {
          deadlineCallback = () => {
            if (!deadlineCancelled) {
              onDeadline();
            }
          };
          return () => {
            deadlineCancelled = true;
          };
        },
      },
    }, { allowedOrigins: [ORIGIN], maxRequestBodyBytes: 1_000_000 });
    const { cookie } = await registerAndLogin(
      app,
      "substack-route-deferred-commit@example.com",
    );
    let responseSettled = false;
    const responsePromise = Promise.resolve(app.request(
      "/connectors/substack/session",
      jsonRequest({
        substackSessionId: "s%3Asubstack.signature",
        connectSessionId: "s%3Aconnect.signature",
      }, cookie),
    )).then((response) => {
      responseSettled = true;
      return response;
    });

    await mutationStarted.promise;
    assertExists(deadlineCallback);
    deadlineCallback();
    await new Promise((resolve) => setTimeout(resolve, 0));
    const responseSettledBeforeMutation = responseSettled;
    const deadlineCancelledBeforeMutation = deadlineCancelled;
    mutation.resolve(source);
    const response = await responsePromise;

    assertEquals(deadlineCancelledBeforeMutation, true);
    assertEquals(responseSettledBeforeMutation, false);
    assertEquals(response.status, 200);
  });
});

Deno.test("Substack session route blocks a late credential commit after the deadline wins", async () => {
  await withTestDb(async (database) => {
    const remoteValidationStarted = Promise.withResolvers<void>();
    const finishRemoteValidation = Promise.withResolvers<void>();
    const losingOperationSettled = Promise.withResolvers<void>();
    let deadlineCallback: (() => void) | undefined;
    let mutationStarted = false;
    const now = Date.now();
    const source: PublicSource = {
      id: "00000000-0000-4000-8000-000000000113",
      userId: "replaced-after-login",
      connectorId: ConnectorId.Substack,
      position: null,
      showPaidPostTitles: false,
      enabled: true,
      connected: true,
      createdAt: now,
      updatedAt: now,
    };
    const commitImmediately = async <Result>(
      operation: () => Promise<Result>,
    ): Promise<Result> => await operation();
    const service: SubstackSessionServiceLike = {
      connect: async (
        userId,
        _credentials,
        _signal,
        commitOperation = commitImmediately,
      ) => {
        source.userId = userId;
        remoteValidationStarted.resolve();
        await finishRemoteValidation.promise;
        try {
          return await commitOperation(() => {
            mutationStarted = true;
            return Promise.resolve(source);
          });
        } finally {
          losingOperationSettled.resolve();
        }
      },
    };
    const app = buildApp(database, {
      connectors: {
        substackSessionService: service,
        substackSessionRateLimiter: passRateLimit(),
        substackPublicationRateLimiter: passRateLimit(),
        connectorTimeoutMs: 10,
        scheduleConnectorDeadline: (onDeadline) => {
          deadlineCallback = onDeadline;
          return () => undefined;
        },
      },
    }, { allowedOrigins: [ORIGIN], maxRequestBodyBytes: 1_000_000 });
    const { cookie } = await registerAndLogin(
      app,
      "substack-route-late-commit@example.com",
    );
    const responsePromise = Promise.resolve(app.request(
      "/connectors/substack/session",
      jsonRequest({
        substackSessionId: "s%3Asubstack.signature",
        connectSessionId: "s%3Aconnect.signature",
      }, cookie),
    ));

    await remoteValidationStarted.promise;
    assertExists(deadlineCallback);
    deadlineCallback();
    const response = await responsePromise;
    finishRemoteValidation.resolve();
    await losingOperationSettled.promise;

    assertEquals(response.status, 500);
    assertEquals(mutationStarted, false);
  });
});
