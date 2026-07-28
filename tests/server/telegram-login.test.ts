import { test } from "bun:test";
import { assert, assertEquals, assertExists } from "../assertions.ts";
import type { Hono } from "hono";
import { and, eq } from "drizzle-orm";
import { ConnectorId } from "../../src/constants.ts";
import { telegramCredentialSchema } from "../../src/connectors/credential-schemas.ts";
import {
  CredentialCipher,
  type EncryptedBlob,
} from "../../src/crypto/credential-cipher.ts";
import { EnvMasterKeyProvider } from "../../src/crypto/key-provider.ts";
import type { Database } from "../../src/db/client.ts";
import { sources } from "../../src/db/schema/source.ts";
import { withTestDb } from "../../src/db/testing.ts";
import {
  findSourceByConnectorId,
  getDecryptedCredentials,
  upsertSourceCredentials,
} from "../../src/repositories/source-repository.ts";
import { buildApp } from "../../src/server/app.ts";
import { createUser } from "../../src/repositories/user-repository.ts";
import { createSession } from "../../src/auth/session-service.ts";
import type { ServerEnvironment } from "../../src/server/app.ts";
import {
  type TelegramLoginClient,
  type TelegramLoginClientFactory,
  TelegramLoginSessionManager,
} from "../../src/connectors/telegram/login-session.ts";

const PASSWORD = "analytical-engine-1843";
const TWO_FACTOR_AUTHENTICATION_PASSWORD = "correct horse battery staple";
const MASTER_KEY_BYTES = new Uint8Array(32).fill(7);

type FakeLoginMode = "approval" | "two-factor-authentication";

interface RegisteredUser {
  id: string;
}

interface LoginHarness {
  app: Hono<ServerEnvironment>;
  manager: TelegramLoginSessionManager;
  factory: FakeTelegramLoginClientFactory;
  credentialCipher: CredentialCipher;
}

function buildCredentialCipher(): CredentialCipher {
  return new CredentialCipher(new EnvMasterKeyProvider(MASTER_KEY_BYTES));
}

function jsonRequest(method: "POST" | "PATCH", body?: unknown): RequestInit {
  return {
    method,
    headers: {
      "content-type": "application/json",
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

async function ownerSession(app: Hono<ServerEnvironment>): Promise<{ user: { id: string }; cookie: string }> {
  const response = await app.request(
    "/auth/setup",
    jsonRequest("POST", { name: "Ada Lovelace" }),
  );
  assertEquals(response.status, 201);
  const user = await response.json();
  const loginResp = await app.request(
    "/auth/login",
    jsonRequest("POST", { password: PASSWORD }),
  );
  assertEquals(loginResp.status, 200);
  return { user: { id: user.id }, cookie: extractCookie(loginResp) };
}

async function strangerSession(database: Database, email: string): Promise<string> {
  const stranger = await createUser(database, {
    name: "Stranger",
    email,
    passwordHash: "$argon2id$fakehash",
    systemPrompt: "Summarize tersely.",
  });
  const { token } = await createSession(database, stranger.id);
  return `__Host-session=${token}`;
}

async function registerAndLogin(
  app: Hono<ServerEnvironment>,
): Promise<{ user: RegisteredUser; cookie: string }> {
  const { user, cookie } = await ownerSession(app);
  return { user, cookie };
}

function buildHarness(
  database: Database,
  now: () => number = Date.now,
): LoginHarness {
  const credentialCipher = buildCredentialCipher();
  const factory = new FakeTelegramLoginClientFactory();
  const manager = new TelegramLoginSessionManager({
    database,
    credentialCipher,
    clientFactory: factory,
    now,
  });
  const app = buildApp(database, {
    connectors: { telegramLoginSessionManager: manager },
  });
  return { app, manager, factory, credentialCipher };
}

async function startTelegramLogin(
  app: Hono<ServerEnvironment>,
  cookie: string,
): Promise<Record<string, unknown>> {
  const response = await app.request("/connectors/telegram/login", {
    method: "POST",
    headers: { cookie, Origin: "http://127.0.0.1:5173" },
  });
  assertEquals(response.status, 201);
  return await response.json();
}

async function regenerateTelegramLogin(
  app: Hono<ServerEnvironment>,
  cookie: string,
  loginSessionId: string,
): Promise<Response> {
  return await app.request(
    `/connectors/telegram/login/${loginSessionId}/regenerate`,
    {
      method: "POST",
      headers: { cookie, Origin: "http://127.0.0.1:5173" },
    },
  );
}

async function pollTelegramLogin(
  app: Hono<ServerEnvironment>,
  cookie: string,
  loginSessionId: string,
): Promise<Record<string, unknown>> {
  const response = await app.request(
    `/connectors/telegram/login/${loginSessionId}`,
    {
      headers: { cookie },
    },
  );
  assertEquals(response.status, 200);
  return await response.json();
}

async function submitTwoFactorAuthentication(
  app: Hono<ServerEnvironment>,
  cookie: string,
  loginSessionId: string,
  password: string,
): Promise<Response> {
  return await app.request(`/connectors/telegram/login/${loginSessionId}/2fa`, {
    ...jsonRequest("POST", { password }),
    headers: {
      "content-type": "application/json",
      cookie,
      Origin: "http://127.0.0.1:5173",
    },
  });
}

async function waitForCompleteStatus(
  app: Hono<ServerEnvironment>,
  cookie: string,
  loginSessionId: string,
): Promise<Record<string, unknown>> {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const status = await pollTelegramLogin(app, cookie, loginSessionId);
    if (status.status === "complete") {
      return status;
    }
    await Promise.resolve();
  }
  throw new Error("telegram login did not complete");
}

async function encryptedTelegramSessionString(
  database: Database,
  credentialCipher: CredentialCipher,
  userId: string,
): Promise<string> {
  const source = await findSourceByConnectorId(
    database,
    userId,
    ConnectorId.Telegram,
  );
  assertExists(source);
  const credentials = await getDecryptedCredentials(
    database,
    source.id,
    userId,
    credentialCipher,
  );
  return telegramCredentialSchema.parse(credentials).sessionString;
}

async function encryptTelegramCredentials(
  credentialCipher: CredentialCipher,
  userId: string,
  sessionString: string,
): Promise<EncryptedBlob> {
  return await credentialCipher.encrypt(JSON.stringify({ sessionString }), {
    userId,
    connectorId: ConnectorId.Telegram,
  });
}

class FakeTelegramLoginClientFactory implements TelegramLoginClientFactory {
  readonly clients: FakeTelegramLoginClient[] = [];
  #queuedModes: FakeLoginMode[] = [];
  #clientCreationGate: Promise<void> | null = null;
  #clientCreationAttempts = 0;
  #attemptWaiters: Array<{ count: number; resolve: () => void }> = [];

  blockClientCreationUntil(gate: Promise<void>): void {
    this.#clientCreationGate = gate;
  }

  waitForClientCreationAttempts(count: number): Promise<void> {
    if (this.#clientCreationAttempts >= count) {
      return Promise.resolve();
    }
    const { promise, resolve } = Promise.withResolvers<void>();
    this.#attemptWaiters.push({ count, resolve });
    return promise;
  }

  queueClient(mode: FakeLoginMode = "approval"): void {
    this.#queuedModes.push(mode);
  }

  async createUnauthenticatedClient(): Promise<TelegramLoginClient> {
    this.#clientCreationAttempts += 1;
    this.#attemptWaiters = this.#attemptWaiters.filter((waiter) => {
      if (this.#clientCreationAttempts >= waiter.count) {
        waiter.resolve();
        return false;
      }
      return true;
    });
    await this.#clientCreationGate;
    const mode = this.#queuedModes.shift() ?? "approval";
    const client = new FakeTelegramLoginClient(mode);
    this.clients.push(client);
    return client;
  }

  readApiCredentials() {
    return { apiId: 12345, apiHash: "test-api-hash" };
  }
}

class FakeTelegramLoginClient implements TelegramLoginClient {
  readonly approval = Promise.withResolvers<void>();
  readonly token = crypto.randomUUID().replaceAll("-", "");
  destroyCount = 0;
  disconnectCount = 0;
  sessionString = `session-${crypto.randomUUID()}`;

  constructor(readonly mode: FakeLoginMode) {}

  readonly session = {
    save: () => this.sessionString,
  };

  approve(): void {
    this.approval.resolve();
  }

  async signInUserWithQrCode(
    _credentials: { apiId: number; apiHash: string },
    callbacks: {
      qrCode(
        code: { token: { toString(encoding: "base64url"): string } },
      ): Promise<void>;
      password(): Promise<string>;
      onError(error: unknown): Promise<boolean>;
    },
  ): Promise<void> {
    await callbacks.qrCode({ token: { toString: () => this.token } });

    if (this.mode === "approval") {
      await this.approval.promise;
      return;
    }

    const password = await callbacks.password();
    if (password !== TWO_FACTOR_AUTHENTICATION_PASSWORD) {
      await callbacks.onError(
        new Error("invalid two-factor authentication password"),
      );
      throw new Error("invalid two-factor authentication password");
    }
  }

  destroy(): void {
    this.destroyCount += 1;
  }

  disconnect(): void {
    this.disconnectCount += 1;
  }
}

test("Telegram QR login stores encrypted source credentials after approval", async () => {
  await withTestDb(async (database) => {
    const { app, factory, credentialCipher } = buildHarness(database);
    const { user, cookie } = await registerAndLogin(app);

    factory.queueClient("approval");
    const start = await startTelegramLogin(app, cookie);
    const loginSessionId = String(start.loginSessionId);
    assert(start.qrUrl === `tg://login?token=${factory.clients[0].token}`);
    assert(!JSON.stringify(start).includes(factory.clients[0].sessionString));

    const pending = await pollTelegramLogin(app, cookie, loginSessionId);
    assertEquals(pending.status, "pending");

    factory.clients[0].approve();
    const complete = await waitForCompleteStatus(app, cookie, loginSessionId);
    assertEquals(complete.status, "complete");
    assert(
      !JSON.stringify(complete).includes(factory.clients[0].sessionString),
    );
    assertEquals(
      await encryptedTelegramSessionString(database, credentialCipher, user.id),
      factory.clients[0].sessionString,
    );
  });
});

test("completed Telegram login sessions release clients, plaintext sessions, and capacity", async () => {
  await withTestDb(async (database) => {
    const { app, manager, factory } = buildHarness(database);
    const { user, cookie } = await registerAndLogin(app);

    factory.queueClient("approval");
    const completedStart = await startTelegramLogin(app, cookie);
    const completedSessionId = String(completedStart.loginSessionId);
    factory.clients[0].approve();
    await waitForCompleteStatus(app, cookie, completedSessionId);

    const completedSnapshot = manager.debugSnapshotForTesting(
      completedSessionId,
      user.id,
    );
    assertExists(completedSnapshot);
    assertEquals(completedSnapshot.status, "complete");
    assertEquals(completedSnapshot.hasClient, false);
    assertEquals(completedSnapshot.hasSessionString, false);
    assertEquals(factory.clients[0].destroyCount, 1);
    assertEquals(factory.clients[0].disconnectCount, 0);

    factory.queueClient("approval");
    factory.queueClient("approval");
    factory.queueClient("approval");
    await startTelegramLogin(app, cookie);
    await startTelegramLogin(app, cookie);
    await startTelegramLogin(app, cookie);

    const fourthResponse = await app.request("/connectors/telegram/login", {
      method: "POST",
      headers: { cookie, Origin: "http://127.0.0.1:5173" },
    });
    assertEquals(fourthResponse.status, 429);
  });
});

test("Telegram QR login supports two-factor authentication and rejects a wrong password without writing a source", async () => {
  await withTestDb(async (database) => {
    const { app, factory, credentialCipher } = buildHarness(database);
    const { user, cookie } = await registerAndLogin(app);

    factory.queueClient("two-factor-authentication");
    const firstStart = await startTelegramLogin(app, cookie);
    const firstLoginSessionId = String(firstStart.loginSessionId);
    const needsTwoFactorAuthentication = await pollTelegramLogin(
      app,
      cookie,
      firstLoginSessionId,
    );
    assertEquals(needsTwoFactorAuthentication.status, "needs_2fa");

    const wrongPasswordResponse = await submitTwoFactorAuthentication(
      app,
      cookie,
      firstLoginSessionId,
      "wrong password",
    );
    assertEquals(wrongPasswordResponse.status, 200);
    const wrongPasswordBody = await wrongPasswordResponse.json();
    assertEquals(wrongPasswordBody.status, "error");
    assert(
      !JSON.stringify(wrongPasswordBody).includes(
        factory.clients[0].sessionString,
      ),
    );
    assertEquals(
      await findSourceByConnectorId(database, user.id, ConnectorId.Telegram),
      null,
    );
    assertEquals(factory.clients[0].destroyCount, 1);
    assertEquals(factory.clients[0].disconnectCount, 0);

    factory.queueClient("two-factor-authentication");
    const secondStart = await startTelegramLogin(app, cookie);
    const secondLoginSessionId = String(secondStart.loginSessionId);
    const secondStatus = await pollTelegramLogin(
      app,
      cookie,
      secondLoginSessionId,
    );
    assertEquals(secondStatus.status, "needs_2fa");

    const correctPasswordResponse = await submitTwoFactorAuthentication(
      app,
      cookie,
      secondLoginSessionId,
      TWO_FACTOR_AUTHENTICATION_PASSWORD,
    );
    assertEquals(correctPasswordResponse.status, 200);
    const correctPasswordBody = await correctPasswordResponse.json();
    assertEquals(correctPasswordBody.status, "complete");
    assertEquals(
      await encryptedTelegramSessionString(database, credentialCipher, user.id),
      factory.clients[1].sessionString,
    );
    assertEquals(factory.clients[1].destroyCount, 1);
    assertEquals(factory.clients[1].disconnectCount, 0);
  });
});

test("Telegram reconnect updates an existing source without duplicating it", async () => {
  await withTestDb(async (database) => {
    const { app, factory, credentialCipher } = buildHarness(database);
    const { user, cookie } = await registerAndLogin(app);
    const existingSource = await upsertSourceCredentials(database, {
      userId: user.id,
      connectorId: ConnectorId.Telegram,
      credentials: await encryptTelegramCredentials(
        credentialCipher,
        user.id,
        "old-session",
      ),
    });
    await database.update(sources).set({ enabled: false, position: 17 }).where(
      eqSource(existingSource.id),
    );

    factory.queueClient("approval");
    const start = await startTelegramLogin(app, cookie);
    factory.clients[0].approve();
    await waitForCompleteStatus(app, cookie, String(start.loginSessionId));

    const rows = await database.select().from(sources).where(
      eqUserConnector(user.id, ConnectorId.Telegram),
    );
    assertEquals(rows.length, 1);
    assertEquals(rows[0].id, existingSource.id);
    assertEquals(rows[0].enabled, true);
    assertEquals(rows[0].position, 17);
    assertEquals(
      await encryptedTelegramSessionString(database, credentialCipher, user.id),
      factory.clients[0].sessionString,
    );

    // API lookup should show connected === true
    const listResponse = await app.request("/sources", { headers: { cookie } });
    assertEquals(listResponse.status, 200);
    const listedSources = await listResponse.json();
    assertEquals(listedSources.length, 1);
    assertEquals(listedSources[0].connected, true);
  });
});

test("Telegram login approval after expiry does not persist Telegram credentials", async () => {
  await withTestDb(async (database) => {
    let now = 1_000;
    const { app, manager, factory, credentialCipher } = buildHarness(
      database,
      () => now,
    );
    const { user, cookie } = await registerAndLogin(app);
    const existingSource = await upsertSourceCredentials(database, {
      userId: user.id,
      connectorId: ConnectorId.Telegram,
      credentials: await encryptTelegramCredentials(
        credentialCipher,
        user.id,
        "old-session",
      ),
    });

    factory.queueClient("approval");
    const start = await startTelegramLogin(app, cookie);
    const loginSessionId = String(start.loginSessionId);
    now += 10 * 60_000 + 1;
    factory.clients[0].approve();

    for (let attempt = 0; attempt < 20; attempt += 1) {
      const snapshot = manager.debugSnapshotForTesting(loginSessionId, user.id);
      if (
        snapshot?.status === "expired" && !snapshot.hasClient &&
        !snapshot.hasSessionString
      ) {
        break;
      }
      await Promise.resolve();
    }

    const rows = await database.select().from(sources).where(
      eqUserConnector(user.id, ConnectorId.Telegram),
    );
    assertEquals(rows.length, 1);
    assertEquals(rows[0].id, existingSource.id);
    assertEquals(
      await encryptedTelegramSessionString(database, credentialCipher, user.id),
      "old-session",
    );
    assertEquals(factory.clients[0].destroyCount, 1);
    assertEquals(factory.clients[0].disconnectCount, 0);

    const expired = await pollTelegramLogin(app, cookie, loginSessionId);
    assertEquals(expired.status, "expired");
  });
});

test("Telegram login destroys a client created after the reservation expired", async () => {
  await withTestDb(async (database) => {
    let now = 1_000;
    const { app, factory } = buildHarness(database, () => now);
    const { cookie } = await registerAndLogin(app);
    const gate = Promise.withResolvers<void>();
    factory.blockClientCreationUntil(gate.promise);

    const startPromise = app.request("/connectors/telegram/login", {
      method: "POST",
      headers: { cookie, Origin: "http://127.0.0.1:5173" },
    });
    await factory.waitForClientCreationAttempts(1);
    now += 10 * 60_000 + 1;
    gate.resolve();

    const expiredStartResponse = await startPromise;
    assertEquals(expiredStartResponse.status, 409);
    assertEquals(factory.clients.length, 1);
    assertEquals(factory.clients[0].destroyCount, 1);
    assertEquals(factory.clients[0].disconnectCount, 0);

    factory.queueClient("approval");
    const freshStart = await startTelegramLogin(app, cookie);
    assertEquals(typeof freshStart.loginSessionId, "string");
  });
});

test("Telegram login expiry returns expired once, then unknown session is hidden", async () => {
  await withTestDb(async (database) => {
    let now = 1_000;
    const { app, factory } = buildHarness(database, () => now);
    const { cookie } = await registerAndLogin(app);

    factory.queueClient("approval");
    const start = await startTelegramLogin(app, cookie);
    now += 10 * 60_000 + 1;

    const expiredResponse = await app.request(
      `/connectors/telegram/login/${start.loginSessionId}`,
      {
        headers: { cookie },
      },
    );
    assertEquals(expiredResponse.status, 200);
    const expiredBody = await expiredResponse.json();
    assertEquals(expiredBody.status, "expired");
    assertEquals(factory.clients[0].destroyCount, 1);
    assertEquals(factory.clients[0].disconnectCount, 0);

    const hiddenResponse = await app.request(
      `/connectors/telegram/login/${start.loginSessionId}`,
      {
        headers: { cookie },
      },
    );
    assertEquals(hiddenResponse.status, 404);

    const unknownResponse = await app.request(
      `/connectors/telegram/login/${crypto.randomUUID()}`,
      {
        headers: { cookie },
      },
    );
    assertEquals(unknownResponse.status, 404);
  });
});

test("Telegram login enforces three concurrent sessions per user", async () => {
  await withTestDb(async (database) => {
    const { app, factory } = buildHarness(database);
    const { cookie } = await registerAndLogin(app);

    factory.queueClient("approval");
    factory.queueClient("approval");
    factory.queueClient("approval");
    await startTelegramLogin(app, cookie);
    await startTelegramLogin(app, cookie);
    await startTelegramLogin(app, cookie);

    const fourthResponse = await app.request("/connectors/telegram/login", {
      method: "POST",
      headers: { cookie, Origin: "http://127.0.0.1:5173" },
    });
    assertEquals(fourthResponse.status, 429);
  });
});

test("Telegram login reserves capacity before awaiting client creation", async () => {
  await withTestDb(async (database) => {
    const { app, factory } = buildHarness(database);
    const { cookie } = await registerAndLogin(app);
    const gate = Promise.withResolvers<void>();
    factory.blockClientCreationUntil(gate.promise);

    const requests = Array.from(
      { length: 4 },
      () =>
        app.request("/connectors/telegram/login", {
          method: "POST",
          headers: { cookie, Origin: "http://127.0.0.1:5173" },
        }),
    );

    await factory.waitForClientCreationAttempts(3);

    let timeoutId: ReturnType<typeof setTimeout> | undefined;
    const fourthResponse = await Promise.race([
      requests[3],
      new Promise<Response>((_, reject) => {
        timeoutId = setTimeout(
          () =>
            reject(
              new Error(
                "fourth login did not hit capacity before client creation unblocked",
              ),
            ),
          100,
        );
      }),
    ]).finally(() => {
      if (timeoutId !== undefined) {
        clearTimeout(timeoutId);
      }
    });
    assertEquals(fourthResponse.status, 429);
    const fourthJson = await fourthResponse.json();
    assertEquals(fourthJson.error.code, "RATE_LIMITED");
    assertEquals(
      fourthJson.error.message,
      "too many active telegram login sessions",
    );

    gate.resolve();
    const firstThreeResponses = await Promise.all(requests.slice(0, 3));
    assertEquals(firstThreeResponses.map((response) => response.status), [
      201,
      201,
      201,
    ]);
  });
});

test("Telegram login regeneration replaces an active session without consuming another slot", async () => {
  await withTestDb(async (database) => {
    const { app, manager, factory } = buildHarness(database);
    const { user, cookie } = await registerAndLogin(app);

    factory.queueClient("approval");
    factory.queueClient("approval");
    factory.queueClient("approval");
    const original = await startTelegramLogin(app, cookie);
    await startTelegramLogin(app, cookie);
    await startTelegramLogin(app, cookie);
    const originalSessionId = String(original.loginSessionId);
    const originalClient = factory.clients[0];

    factory.queueClient("approval");
    const response = await regenerateTelegramLogin(
      app,
      cookie,
      originalSessionId,
    );
    assertEquals(response.status, 201);
    const fresh = await response.json();
    assertEquals(typeof fresh.loginSessionId, "string");
    assert(fresh.loginSessionId !== originalSessionId);
    assertEquals(
      fresh.qrUrl,
      `tg://login?token=${factory.clients[3].token}`,
    );
    assertEquals(typeof fresh.expiresAt, "number");
    assertEquals(originalClient.destroyCount, 1);
    assertEquals(originalClient.disconnectCount, 0);
    assertEquals(
      manager.debugSnapshotForTesting(originalSessionId, user.id),
      null,
    );

    const removedResponse = await app.request(
      `/connectors/telegram/login/${originalSessionId}`,
      { headers: { cookie } },
    );
    assertEquals(removedResponse.status, 404);
    const freshStatus = await pollTelegramLogin(
      app,
      cookie,
      String(fresh.loginSessionId),
    );
    assertEquals(freshStatus.status, "pending");
  });
});

test("Telegram login regeneration cannot replace another user's session", async () => {
  await withTestDb(async (database) => {
    const { app, manager, factory } = buildHarness(database);
    const { user, cookie: ownerCookie } = await registerAndLogin(app);
    const otherCookie = await strangerSession(
      database,
      "telegram-regenerate-other@example.com",
    );

    factory.queueClient("approval");
    const original = await startTelegramLogin(app, ownerCookie);
    const originalSessionId = String(original.loginSessionId);
    const response = await regenerateTelegramLogin(
      app,
      otherCookie,
      originalSessionId,
    );

    assertEquals(response.status, 404);
    assertEquals(factory.clients.length, 1);
    assertEquals(factory.clients[0].destroyCount, 0);
    assertEquals(
      manager.debugSnapshotForTesting(originalSessionId, user.id)?.status,
      "pending",
    );
    assertEquals(
      (await pollTelegramLogin(app, ownerCookie, originalSessionId)).status,
      "pending",
    );
  });
});

test("Telegram login regeneration rejects and preserves completed sessions", async () => {
  await withTestDb(async (database) => {
    const { app, manager, factory } = buildHarness(database);
    const { user, cookie } = await registerAndLogin(app);

    factory.queueClient("approval");
    const original = await startTelegramLogin(app, cookie);
    const originalSessionId = String(original.loginSessionId);
    factory.clients[0].approve();
    await waitForCompleteStatus(app, cookie, originalSessionId);

    const response = await regenerateTelegramLogin(
      app,
      cookie,
      originalSessionId,
    );
    assertEquals(response.status, 409);
    const body = await response.json();
    assertEquals(body.error.code, "CONFLICT");
    assertEquals(
      body.error.message,
      "telegram login session is complete",
    );
    assertEquals(factory.clients.length, 1);
    assertEquals(factory.clients[0].destroyCount, 1);
    assertEquals(
      manager.debugSnapshotForTesting(originalSessionId, user.id)?.status,
      "complete",
    );
    assertEquals(
      (await pollTelegramLogin(app, cookie, originalSessionId)).status,
      "complete",
    );
  });
});

test("Telegram login session ownership is hidden from other users", async () => {
  await withTestDb(async (database) => {
    const { app, factory } = buildHarness(database);
        const { cookie: ownerCookie } = await registerAndLogin(app);
    const otherCookie = await strangerSession(database, "telegram-other@example.com");

    factory.queueClient("two-factor-authentication");
    const start = await startTelegramLogin(app, ownerCookie);
    const loginSessionId = String(start.loginSessionId);

    const pollResponse = await app.request(
      `/connectors/telegram/login/${loginSessionId}`,
      {
        headers: { cookie: otherCookie, Origin: "http://127.0.0.1:5173" },
      },
    );
    assertEquals(pollResponse.status, 404);

    const submitResponse = await submitTwoFactorAuthentication(
      app,
      otherCookie,
      loginSessionId,
      TWO_FACTOR_AUTHENTICATION_PASSWORD,
    );
    assertEquals(submitResponse.status, 404);
  });
});

function eqSource(sourceId: string) {
  return eq(sources.id, sourceId);
}

function eqUserConnector(userId: string, connectorId: ConnectorId) {
  return and(eq(sources.userId, userId), eq(sources.connectorId, connectorId));
}
