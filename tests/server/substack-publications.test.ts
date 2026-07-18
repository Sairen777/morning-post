import { assertEquals, assertExists } from "@std/assert";
import type { Hono, MiddlewareHandler } from "@hono/hono";
import { ConnectorId } from "../../src/constants.ts";
import { withTestDb } from "../../src/db/testing.ts";
import type { PublicFeed } from "../../src/repositories/feed-repository.ts";
import type { PublicSource } from "../../src/repositories/source-repository.ts";
import { buildApp } from "../../src/server/app.ts";
import type { SubstackPublicationServiceLike } from "../../src/server/routes/connectors.ts";

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

async function registerAndLogin(app: Hono, email: string): Promise<{ userId: string; cookie: string }> {
  const registration = await app.request("/auth/register", jsonRequest({
    name: "Ada Lovelace",
    email,
    password: PASSWORD,
  }));
  assertEquals(registration.status, 201);
  const user = await registration.json();
  const login = await app.request("/auth/login", jsonRequest({ email, password: PASSWORD }));
  assertEquals(login.status, 200);
  const setCookie = login.headers.get("set-cookie");
  assertExists(setCookie);
  return { userId: user.id, cookie: setCookie.split(";")[0] };
}

Deno.test("POST /connectors/substack/publications creates a canonical publication feed", async () => {
  await withTestDb(async (database) => {
    const calls: Array<{ userId: string; publicationUrl: string }> = [];
    const service: SubstackPublicationServiceLike = {
      add: (userId, publicationUrl) => {
        calls.push({ userId, publicationUrl });
        const now = Date.now();
        const source: PublicSource = {
          id: "00000000-0000-4000-8000-000000000211",
          userId,
          connectorId: ConnectorId.Substack,
          position: null,
          enabled: true,
          connected: true,
          createdAt: now,
          updatedAt: now,
        };
        const feed: PublicFeed = {
          id: "00000000-0000-4000-8000-000000000212",
          sourceId: source.id,
          externalId: "https://newsletter.example.com",
          name: "Example Letter",
          kind: "news",
          customPrompt: null,
          position: null,
          enabled: true,
          deletedAt: null,
          lastFetchedPeriodEndMs: null,
          createdAt: now,
          updatedAt: now,
        };
        return Promise.resolve({ source, feed });
      },
    };
    const app = buildApp(database, {
      connectors: {
        substackPublicationService: service,
        substackSessionRateLimiter: passRateLimit(),
        substackPublicationRateLimiter: passRateLimit(),
      },
    }, { allowedOrigins: [ORIGIN], maxRequestBodyBytes: 1_000_000 });
    const { userId, cookie } = await registerAndLogin(app, "substack-publication-route@example.com");
    const response = await app.request("/connectors/substack/publications", jsonRequest({
      publicationUrl: "https://example.substack.com/p/article",
    }, cookie));
    assertEquals(response.status, 201);
    const body = await response.json();
    assertEquals(body.feed.externalId, "https://newsletter.example.com");
    assertEquals(calls, [{ userId, publicationUrl: "https://example.substack.com/p/article" }]);
  });
});

Deno.test("Substack publication route cancels its deadline before a deferred feed commit", async () => {
  await withTestDb(async (database) => {
    const mutationStarted = Promise.withResolvers<void>();
    const mutation = Promise.withResolvers<{ source: PublicSource; feed: PublicFeed }>();
    let deadlineCallback: (() => void) | undefined;
    let deadlineCancelled = false;
    const now = Date.now();
    const source: PublicSource = {
      id: "00000000-0000-4000-8000-000000000213",
      userId: "replaced-after-login",
      connectorId: ConnectorId.Substack,
      position: null,
      enabled: true,
      connected: true,
      createdAt: now,
      updatedAt: now,
    };
    const feed: PublicFeed = {
      id: "00000000-0000-4000-8000-000000000214",
      sourceId: source.id,
      externalId: "https://newsletter.example.com",
      name: "Example Letter",
      kind: "news",
      customPrompt: null,
      position: null,
      enabled: true,
      deletedAt: null,
      lastFetchedPeriodEndMs: null,
      createdAt: now,
      updatedAt: now,
    };
    const commitImmediately = async <Result>(operation: () => Promise<Result>): Promise<Result> =>
      await operation();
    const service: SubstackPublicationServiceLike = {
      add: (
        userId,
        _publicationUrl,
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
        substackPublicationService: service,
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
    const { cookie } = await registerAndLogin(app, "substack-publication-deferred-commit@example.com");
    let responseSettled = false;
    const responsePromise = Promise.resolve(app.request(
      "/connectors/substack/publications",
      jsonRequest({ publicationUrl: "https://example.substack.com" }, cookie),
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
    mutation.resolve({ source, feed });
    const response = await responsePromise;

    assertEquals(deadlineCancelledBeforeMutation, true);
    assertEquals(responseSettledBeforeMutation, false);
    assertEquals(response.status, 201);
  });
});

Deno.test("Substack publication route blocks a late feed commit after the deadline wins", async () => {
  await withTestDb(async (database) => {
    const remoteProbeStarted = Promise.withResolvers<void>();
    const finishRemoteProbe = Promise.withResolvers<void>();
    const losingOperationSettled = Promise.withResolvers<void>();
    let deadlineCallback: (() => void) | undefined;
    let mutationStarted = false;
    const now = Date.now();
    const source: PublicSource = {
      id: "00000000-0000-4000-8000-000000000215",
      userId: "replaced-after-login",
      connectorId: ConnectorId.Substack,
      position: null,
      enabled: true,
      connected: true,
      createdAt: now,
      updatedAt: now,
    };
    const feed: PublicFeed = {
      id: "00000000-0000-4000-8000-000000000216",
      sourceId: source.id,
      externalId: "https://newsletter.example.com",
      name: "Example Letter",
      kind: "news",
      customPrompt: null,
      position: null,
      enabled: true,
      deletedAt: null,
      lastFetchedPeriodEndMs: null,
      createdAt: now,
      updatedAt: now,
    };
    const commitImmediately = async <Result>(operation: () => Promise<Result>): Promise<Result> =>
      await operation();
    const service: SubstackPublicationServiceLike = {
      add: async (
        userId,
        _publicationUrl,
        _signal,
        commitOperation = commitImmediately,
      ) => {
        source.userId = userId;
        remoteProbeStarted.resolve();
        await finishRemoteProbe.promise;
        try {
          return await commitOperation(() => {
            mutationStarted = true;
            return Promise.resolve({ source, feed });
          });
        } finally {
          losingOperationSettled.resolve();
        }
      },
    };
    const app = buildApp(database, {
      connectors: {
        substackPublicationService: service,
        substackSessionRateLimiter: passRateLimit(),
        substackPublicationRateLimiter: passRateLimit(),
        connectorTimeoutMs: 10,
        scheduleConnectorDeadline: (onDeadline) => {
          deadlineCallback = onDeadline;
          return () => undefined;
        },
      },
    }, { allowedOrigins: [ORIGIN], maxRequestBodyBytes: 1_000_000 });
    const { cookie } = await registerAndLogin(app, "substack-publication-late-commit@example.com");
    const responsePromise = Promise.resolve(app.request(
      "/connectors/substack/publications",
      jsonRequest({ publicationUrl: "https://example.substack.com" }, cookie),
    ));

    await remoteProbeStarted.promise;
    assertExists(deadlineCallback);
    deadlineCallback();
    const response = await responsePromise;
    finishRemoteProbe.resolve();
    await losingOperationSettled.promise;

    assertEquals(response.status, 500);
    assertEquals(mutationStarted, false);
  });
});

Deno.test("Substack publication route rejects schema-invalid bodies", async () => {
  await withTestDb(async (database) => {
    const service: SubstackPublicationServiceLike = {
      add: () => Promise.reject(new Error("must not be called")),
    };
    const app = buildApp(database, {
      connectors: {
        substackPublicationService: service,
        substackSessionRateLimiter: passRateLimit(),
        substackPublicationRateLimiter: passRateLimit(),
      },
    }, { allowedOrigins: [ORIGIN], maxRequestBodyBytes: 1_000_000 });
    const { cookie } = await registerAndLogin(app, "substack-publication-validation@example.com");
    const response = await app.request("/connectors/substack/publications", jsonRequest({
      publicationUrl: "https://example.substack.com",
      externalId: "client-controlled",
    }, cookie));
    assertEquals(response.status, 422);
  });
});
