import { test } from "bun:test";
import type { PublicFeed } from "../../src/repositories/feed-repository.ts";
import { assert, assertEquals, assertExists } from "../assertions.ts";
import type { Hono } from "hono";
import type { Database } from "../../src/db/client.ts";
import {
  type ConnectorCommit,
  commitImmediately,
} from "../../src/services/connector-commit.ts";
import { withTestDb } from "../../src/db/testing.ts";
import { buildApp, type ServerEnvironment } from "../../src/server/app.ts";
import { ConflictError, NotFoundError } from "../../src/server/errors.ts";
import type {
  XLoginSessionManagerLike,
  XTargetServiceLike,
} from "../../src/server/routes/connectors.ts";
import type { XLoginSessionStatus } from "../../src/services/x-login-service.ts";

const PASSWORD = "analytical-engine-1843";
const SESSION_ID = "11111111-1111-4111-8111-111111111111";
const EXPIRES_AT_MS = 123_456;

function jsonRequest(
  method: "POST" | "DELETE",
  cookie?: string,
  body?: unknown,
): RequestInit {
  return {
    method,
    headers: {
      ...(body === undefined ? {} : { "content-type": "application/json" }),
      ...(cookie === undefined ? {} : { cookie }),
      Origin: "http://127.0.0.1:5173",
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  };
}

function extractCookie(response: Response): string {
  const header = response.headers.get("set-cookie");
  assert(header, "login did not set a session cookie");
  return header.split(";")[0];
}

async function ownerSession(
  app: Hono<ServerEnvironment>,
): Promise<{ userId: string; cookie: string }> {
  const setup = await app.request(
    "/auth/setup",
    jsonRequest("POST", undefined, { name: "Ada Lovelace" }),
  );
  assertEquals(setup.status, 201);
  const user = await setup.json();
  const login = await app.request(
    "/auth/login",
    jsonRequest("POST", undefined, { password: PASSWORD }),
  );
  assertEquals(login.status, 200);
  return { userId: user.id, cookie: extractCookie(login) };
}

class InjectedXLoginSessionManager implements XLoginSessionManagerLike {
  startResult: XLoginSessionStatus = {
    sessionId: SESSION_ID,
    status: "awaiting_login",
    expiresAtMs: EXPIRES_AT_MS,
  };
  statusResult: XLoginSessionStatus = {
    sessionId: SESSION_ID,
    status: "awaiting_chat_unlock",
    expiresAtMs: EXPIRES_AT_MS,
  };
  verifyResult: XLoginSessionStatus = {
    sessionId: SESSION_ID,
    status: "complete",
    expiresAtMs: EXPIRES_AT_MS,
  };
  startError: Error | null = null;
  statusError: Error | null = null;
  verifyError: Error | null = null;
  cancelError: Error | null = null;
  readonly startCalls: Array<{
    userId: string;
    signal: AbortSignal | null;
  }> = [];
  readonly statusCalls: Array<{ sessionId: string; userId: string }> = [];
  readonly verifyCalls: Array<{
    sessionId: string;
    userId: string;
    signal: AbortSignal | null;
  }> = [];
  readonly cancelCalls: Array<{ sessionId: string; userId: string }> = [];

  async startLogin(
    userId: string,
    signal?: AbortSignal,
  ): Promise<XLoginSessionStatus> {
    this.startCalls.push({ userId, signal: signal ?? null });
    if (this.startError !== null) throw this.startError;
    return this.startResult;
  }

  async getStatus(
    sessionId: string,
    userId: string,
  ): Promise<XLoginSessionStatus> {
    this.statusCalls.push({ sessionId, userId });
    if (this.statusError !== null) throw this.statusError;
    return this.statusResult;
  }

  async verify(
    sessionId: string,
    userId: string,
    signal?: AbortSignal,
  ): Promise<XLoginSessionStatus> {
    this.verifyCalls.push({ sessionId, userId, signal: signal ?? null });
    if (this.verifyError !== null) throw this.verifyError;
    return this.verifyResult;
  }

  async cancel(sessionId: string, userId: string): Promise<void> {
    this.cancelCalls.push({ sessionId, userId });
    if (this.cancelError !== null) throw this.cancelError;
  }
}

class InjectedXTargetService implements XTargetServiceLike {
  readonly calls: Array<{
    userId: string;
    sourceId: string;
    url: string;
    signal: AbortSignal | null;
  }> = [];
  result: PublicFeed = {
    id: "33333333-3333-4333-8333-333333333333",
    sourceId: "22222222-2222-4222-8222-222222222222",
    externalId: "x:list:123",
    name: "Research",
    kind: "news",
    customPrompt: null,
    position: null,
    enabled: true,
    summarizationMode: "basic",
    relevanceFilterMode: "inherit",
    deletedAt: null,
    lastFetchedPeriodEndMs: null,
    createdAt: 100,
    updatedAt: 100,
  };

  add(
    userId: string,
    sourceId: string,
    url: string,
    signal?: AbortSignal,
    commitOperation: ConnectorCommit = commitImmediately,
  ): Promise<PublicFeed> {
    this.calls.push({ userId, sourceId, url, signal: signal ?? null });
    return commitOperation(() => Promise.resolve(this.result));
  }
}

function appWithManager(
  database: Database,
  manager: InjectedXLoginSessionManager,
): Hono<ServerEnvironment> {
  return buildApp(database, {
    connectors: { xLoginSessionManager: manager },
  });
}

function appWithXServices(
  database: Database,
  manager: InjectedXLoginSessionManager,
  targetService: InjectedXTargetService,
): Hono<ServerEnvironment> {
  return buildApp(database, {
    connectors: {
      xLoginSessionManager: manager,
      xTargetService: targetService,
    },
  });
}

test("the injected X login routes expose the lifecycle schema and authenticated owner", async () => {
  await withTestDb(async (database) => {
    const manager = new InjectedXLoginSessionManager();
    const app = appWithManager(database, manager);
    const { userId, cookie } = await ownerSession(app);

    const startedResponse = await app.request(
      "/connectors/x/login",
      jsonRequest("POST", cookie),
    );
    assertEquals(startedResponse.status, 202);
    assertEquals(await startedResponse.json(), {
      sessionId: SESSION_ID,
      status: "awaiting_login",
      expiresAtMs: EXPIRES_AT_MS,
    });
    assertEquals(manager.startCalls.length, 1);
    const startCall = manager.startCalls[0];
    assert(startCall);
    assertEquals(startCall.userId, userId);
    assert(startCall.signal instanceof AbortSignal);
    assertEquals(startCall.signal.aborted, false);

    const statusResponse = await app.request(
      `/connectors/x/login/${SESSION_ID}`,
      { headers: { cookie } },
    );
    assertEquals(statusResponse.status, 200);
    assertEquals(await statusResponse.json(), {
      sessionId: SESSION_ID,
      status: "awaiting_chat_unlock",
      expiresAtMs: EXPIRES_AT_MS,
    });
    assertEquals(manager.statusCalls, [{ sessionId: SESSION_ID, userId }]);

    const verifyResponse = await app.request(
      `/connectors/x/login/${SESSION_ID}/verify`,
      jsonRequest("POST", cookie),
    );
    assertEquals(verifyResponse.status, 200);
    assertEquals(await verifyResponse.json(), {
      sessionId: SESSION_ID,
      status: "complete",
      expiresAtMs: EXPIRES_AT_MS,
    });
    assertEquals(manager.verifyCalls.length, 1);
    const verifyCall = manager.verifyCalls[0];
    assert(verifyCall);
    assertEquals(
      { sessionId: verifyCall.sessionId, userId: verifyCall.userId },
      { sessionId: SESSION_ID, userId },
    );
    assert(verifyCall.signal instanceof AbortSignal);
    assertEquals(verifyCall.signal.aborted, false);

    const cancelResponse = await app.request(
      `/connectors/x/login/${SESSION_ID}`,
      jsonRequest("DELETE", cookie),
    );
    assertEquals(cancelResponse.status, 204);
    assertEquals(await cancelResponse.text(), "");
    assertEquals(manager.cancelCalls, [{ sessionId: SESSION_ID, userId }]);
  });
});

test("X login routes reject unauthenticated and malformed session access before invoking the service", async () => {
  await withTestDb(async (database) => {
    const manager = new InjectedXLoginSessionManager();
    const app = appWithManager(database, manager);

    const unauthenticated = await app.request(
      "/connectors/x/login",
      jsonRequest("POST"),
    );
    assertEquals(unauthenticated.status, 401);
    assertEquals(await unauthenticated.json(), {
      error: { code: "UNAUTHORIZED", message: "Unauthorized" },
    });
    assertEquals(manager.startCalls, []);

    const { cookie } = await ownerSession(app);
    const malformed = await app.request(
      "/connectors/x/login/not-a-uuid",
      { headers: { cookie } },
    );
    assertEquals(malformed.status, 422);
    assertEquals(await malformed.json(), {
      error: {
        code: "VALIDATION_ERROR",
        message: "sessionId must be a valid UUID",
      },
    });
    assertEquals(manager.statusCalls, []);
  });
});

test("X login route conflicts, ownership misses, and cleanup failures retain safe error schemas", async () => {
  await withTestDb(async (database) => {
    const manager = new InjectedXLoginSessionManager();
    const app = appWithManager(database, manager);
    const { cookie } = await ownerSession(app);

    manager.startError = new ConflictError(
      "an X login session is already active",
    );
    const conflict = await app.request(
      "/connectors/x/login",
      jsonRequest("POST", cookie),
    );
    assertEquals(conflict.status, 409);
    assertEquals(await conflict.json(), {
      error: {
        code: "CONFLICT",
        message: "an X login session is already active",
      },
    });

    manager.statusError = new NotFoundError("X login session not found");
    const missing = await app.request(
      `/connectors/x/login/${SESSION_ID}`,
      { headers: { cookie } },
    );
    assertEquals(missing.status, 404);
    assertEquals(await missing.json(), {
      error: {
        code: "NOT_FOUND",
        message: "X login session not found",
      },
    });

    manager.cancelError = new ConflictError(
      "X browser profile cleanup failed",
    );
    const cleanupFailure = await app.request(
      `/connectors/x/login/${SESSION_ID}`,
      jsonRequest("DELETE", cookie),
    );
    assertEquals(cleanupFailure.status, 409);
    assertEquals(await cleanupFailure.json(), {
      error: {
        code: "CONFLICT",
        message: "X browser profile cleanup failed",
      },
    });
  });
});

test("X target route validates and persists an owner-scoped target with cancellation", async () => {
  await withTestDb(async (database) => {
    const manager = new InjectedXLoginSessionManager();
    const targetService = new InjectedXTargetService();
    const app = appWithXServices(database, manager, targetService);
    const { userId, cookie } = await ownerSession(app);
    const sourceId = "22222222-2222-4222-8222-222222222222";
    const url = "https://x.com/i/lists/123";

    const response = await app.request(
      "/connectors/x/targets",
      jsonRequest("POST", cookie, { sourceId, url }),
    );

    assertEquals(response.status, 201);
    assertEquals(await response.json(), targetService.result);
    assertEquals(targetService.calls.length, 1);
    const call = targetService.calls[0];
    assert(call);
    assertEquals(
      { userId: call.userId, sourceId: call.sourceId, url: call.url },
      { userId, sourceId, url },
    );
    assert(call.signal instanceof AbortSignal);
    assertEquals(call.signal.aborted, false);

    const invalid = await app.request(
      "/connectors/x/targets",
      jsonRequest("POST", cookie, { sourceId, url, profileId: userId }),
    );
    assertEquals(invalid.status, 422);
    assertEquals(targetService.calls.length, 1);
  });
});

test("X target route cancels its deadline before a deferred feed commit", async () => {
  await withTestDb(async (database) => {
    const mutationStarted = Promise.withResolvers<void>();
    const mutation = Promise.withResolvers<PublicFeed>();
    let deadlineCallback: (() => void) | undefined;
    let deadlineCancelled = false;
    let responseSettled = false;
    const feed = new InjectedXTargetService().result;
    const service: XTargetServiceLike = {
      add: (
        _userId,
        _sourceId,
        _url,
        _signal,
        commitOperation = commitImmediately,
      ) =>
        commitOperation(async () => {
          mutationStarted.resolve();
          return await mutation.promise;
        }),
    };
    const app = buildApp(database, {
      connectors: {
        xLoginSessionManager: new InjectedXLoginSessionManager(),
        xTargetService: service,
        connectorTimeoutMs: 10,
        scheduleConnectorDeadline: (onDeadline) => {
          deadlineCallback = () => {
            if (!deadlineCancelled) onDeadline();
          };
          return () => {
            deadlineCancelled = true;
          };
        },
      },
    });
    const { cookie } = await ownerSession(app);
    const responsePromise = Promise.resolve(app.request(
      "/connectors/x/targets",
      jsonRequest("POST", cookie, {
        sourceId: feed.sourceId,
        url: "https://x.com/i/lists/123",
      }),
    )).then((response) => {
      responseSettled = true;
      return response;
    });

    await mutationStarted.promise;
    assertExists(deadlineCallback);
    deadlineCallback();
    const responseSettledBeforeMutation = responseSettled;
    const deadlineCancelledBeforeMutation = deadlineCancelled;
    mutation.resolve(feed);
    const response = await responsePromise;

    assertEquals(deadlineCancelledBeforeMutation, true);
    assertEquals(responseSettledBeforeMutation, false);
    assertEquals(response.status, 201);
  });
});

test("X target route blocks a late feed commit after its deadline wins", async () => {
  await withTestDb(async (database) => {
    const browserValidationStarted = Promise.withResolvers<void>();
    const finishBrowserValidation = Promise.withResolvers<void>();
    const losingOperationSettled = Promise.withResolvers<void>();
    let deadlineCallback: (() => void) | undefined;
    let mutationStarted = false;
    const feed = new InjectedXTargetService().result;
    const service: XTargetServiceLike = {
      add: async (
        _userId,
        _sourceId,
        _url,
        _signal,
        commitOperation = commitImmediately,
      ) => {
        browserValidationStarted.resolve();
        await finishBrowserValidation.promise;
        try {
          return await commitOperation(() => {
            mutationStarted = true;
            return Promise.resolve(feed);
          });
        } finally {
          losingOperationSettled.resolve();
        }
      },
    };
    const app = buildApp(database, {
      connectors: {
        xLoginSessionManager: new InjectedXLoginSessionManager(),
        xTargetService: service,
        connectorTimeoutMs: 10,
        scheduleConnectorDeadline: (onDeadline) => {
          deadlineCallback = onDeadline;
          return () => undefined;
        },
      },
    });
    const { cookie } = await ownerSession(app);
    const responsePromise = app.request(
      "/connectors/x/targets",
      jsonRequest("POST", cookie, {
        sourceId: feed.sourceId,
        url: "https://x.com/i/lists/123",
      }),
    );

    await browserValidationStarted.promise;
    assertExists(deadlineCallback);
    deadlineCallback();
    const response = await responsePromise;
    finishBrowserValidation.resolve();
    await losingOperationSettled.promise;

    assertEquals(response.status, 500);
    assertEquals(mutationStarted, false);
  });
});
