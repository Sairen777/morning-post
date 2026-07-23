import { test } from "bun:test";
import { assert, assertEquals, assertExists } from "../assertions.ts";
import type { Hono } from "hono";
import { eq } from "drizzle-orm";
import { ConnectorId } from "../../src/constants.ts";
import {
  CredentialCipher,
  type EncryptedBlob,
} from "../../src/crypto/credential-cipher.ts";
import { EnvMasterKeyProvider } from "../../src/crypto/key-provider.ts";
import type { Database } from "../../src/db/client.ts";
import { sources } from "../../src/db/schema/source.ts";
import { withTestDb } from "../../src/db/testing.ts";
import {
  createOrReviveFeed,
  listFeedsForUser,
} from "../../src/repositories/feed-repository.ts";
import {
  createSource,
  findSourceById,
} from "../../src/repositories/source-repository.ts";
import { buildApp } from "../../src/server/app.ts";
import type { ServerEnvironment } from "../../src/server/app.ts";

const PASSWORD = "analytical-engine-1843";
const TELEGRAM_REVOKE_MESSAGE =
  "Source disconnected. Revoke the Telegram session in Telegram -> Devices.";
const MASTER_KEY_BYTES = new Uint8Array(32).fill(11);

interface RegisteredUser {
  id: string;
  email: string;
}

function buildCredentialCipher(): CredentialCipher {
  return new CredentialCipher(new EnvMasterKeyProvider(MASTER_KEY_BYTES));
}

function jsonRequest(
  method: "POST" | "PATCH" | "DELETE",
  body?: unknown,
): RequestInit {
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

async function register(app: Hono<ServerEnvironment>, email: string): Promise<RegisteredUser> {
  const response = await app.request(
    "/auth/register",
    jsonRequest("POST", { name: "Ada Lovelace", email, password: PASSWORD }),
  );
  assertEquals(response.status, 201);
  const json = await response.json();
  return { id: json.id, email: json.email };
}

async function login(app: Hono<ServerEnvironment>, email: string): Promise<string> {
  const response = await app.request(
    "/auth/login",
    jsonRequest("POST", { email, password: PASSWORD }),
  );
  assertEquals(response.status, 200);
  return extractCookie(response);
}

async function registerAndLogin(
  app: Hono<ServerEnvironment>,
  email: string,
): Promise<{ user: RegisteredUser; cookie: string }> {
  const user = await register(app, email);
  const cookie = await login(app, email);
  return { user, cookie };
}

async function encryptCredentials(
  credentialCipher: CredentialCipher,
  userId: string,
  connectorId: ConnectorId,
  plaintext: Record<string, unknown>,
): Promise<EncryptedBlob> {
  return await credentialCipher.encrypt(JSON.stringify(plaintext), {
    userId,
    connectorId,
  });
}

async function createEncryptedSource(
  database: Database,
  credentialCipher: CredentialCipher,
  userId: string,
  connectorId: ConnectorId,
  options: {
    position?: number | null;
    enabled?: boolean;
  } = {},
) {
  return await createSource(database, {
    userId,
    connectorId,
    credentials: await encryptCredentials(
      credentialCipher,
      userId,
      connectorId,
      {
        sessionString: `${connectorId}-session`,
      },
    ),
    position: options.position,
    enabled: options.enabled,
  });
}

test("GET /sources returns only the caller sources ordered by position then createdAt without credentials", async () => {
  await withTestDb(async (database: Database) => {
    const credentialCipher = buildCredentialCipher();
    const app = buildApp(database);
    const { user, cookie } = await registerAndLogin(
      app,
      "sources-list@example.com",
    );
    const { user: otherUser } = await registerAndLogin(
      app,
      "sources-other@example.com",
    );

    const firstTiedSource = await createEncryptedSource(
      database,
      credentialCipher,
      user.id,
      ConnectorId.Telegram,
      { position: 1 },
    );
    const secondTiedSource = await createEncryptedSource(
      database,
      credentialCipher,
      user.id,
      ConnectorId.RSS,
      { position: 1 },
    );
    const trailingSource = await createEncryptedSource(
      database,
      credentialCipher,
      user.id,
      ConnectorId.Substack,
      { position: 3 },
    );
    await createEncryptedSource(
      database,
      credentialCipher,
      otherUser.id,
      ConnectorId.YouTube,
      {
        position: 0,
      },
    );

    await database.update(sources).set({ createdAt: 10, updatedAt: 10 }).where(
      eq(sources.id, firstTiedSource.id),
    );
    await database.update(sources).set({ createdAt: 20, updatedAt: 20 }).where(
      eq(sources.id, secondTiedSource.id),
    );
    await database.update(sources).set({ createdAt: 30, updatedAt: 30 }).where(
      eq(sources.id, trailingSource.id),
    );

    const response = await app.request("/sources", { headers: { cookie } });
    assertEquals(response.status, 200);
    const json = await response.json();

    assertEquals(json.map((source: { id: string }) => source.id), [
      firstTiedSource.id,
      secondTiedSource.id,
      trailingSource.id,
    ]);
    assertEquals(
      json.every((source: Record<string, unknown>) =>
        !("credentials" in source)
      ),
      true,
    );
    assertEquals(
      json.every((source: { connected: boolean }) => source.connected === true),
      true,
    );
    assertEquals(
      json.every((source: { userId: string }) => source.userId === user.id),
      true,
    );
  });
});

test("PATCH /sources/:id updates position and enabled", async () => {
  await withTestDb(async (database: Database) => {
    const credentialCipher = buildCredentialCipher();
    const app = buildApp(database);
    const { user, cookie } = await registerAndLogin(
      app,
      "sources-patch@example.com",
    );
    const source = await createEncryptedSource(
      database,
      credentialCipher,
      user.id,
      ConnectorId.Telegram,
      {
        position: 4,
        enabled: true,
      },
    );

    const response = await app.request(`/sources/${source.id}`, {
      ...jsonRequest("PATCH", { position: 1, enabled: false, relevanceFilterMode: "include_all" }),
      headers: {
        "content-type": "application/json",
        cookie,
        Origin: "http://127.0.0.1:5173",
      },
    });
    assertEquals(response.status, 200);
    const json = await response.json();

    assertEquals(json.position, 1);
    assertEquals(json.enabled, false);
    assertEquals(json.relevanceFilterMode, "include_all");
    assertEquals("credentials" in json, false);

    const stored = await findSourceById(database, source.id, user.id);
    assertExists(stored);
    assertEquals(stored.position, 1);
    assertEquals(stored.enabled, false);
    assertEquals(stored.showPaidPostTitles, false);
    assertEquals(stored.relevanceFilterMode, "include_all");

    const invalidModeResponse = await app.request(`/sources/${source.id}`, {
      ...jsonRequest("PATCH", { relevanceFilterMode: "invalid" }),
      headers: {
        "content-type": "application/json",
        cookie,
        Origin: "http://127.0.0.1:5173",
      },
    });
    assertEquals(invalidModeResponse.status, 422);
    await invalidModeResponse.body?.cancel();
  });
});

test("PATCH /sources/:id validates and persists Substack paid-post title preferences", async () => {
  await withTestDb(async (database: Database) => {
    const credentialCipher = buildCredentialCipher();
    const app = buildApp(database);
    const { user, cookie } = await registerAndLogin(
      app,
      "sources-paid-titles@example.com",
    );
    const substack = await createEncryptedSource(
      database,
      credentialCipher,
      user.id,
      ConnectorId.Substack,
    );
    const telegram = await createEncryptedSource(
      database,
      credentialCipher,
      user.id,
      ConnectorId.Telegram,
    );

    const enabledResponse = await app.request(`/sources/${substack.id}`, {
      ...jsonRequest("PATCH", { showPaidPostTitles: true }),
      headers: {
        "content-type": "application/json",
        cookie,
        Origin: "http://127.0.0.1:5173",
      },
    });
    assertEquals(enabledResponse.status, 200);
    assertEquals((await enabledResponse.json()).showPaidPostTitles, true);
    assertEquals(
      (await findSourceById(database, substack.id, user.id))
        ?.showPaidPostTitles,
      true,
    );

    const disabledResponse = await app.request(`/sources/${substack.id}`, {
      ...jsonRequest("PATCH", { showPaidPostTitles: false }),
      headers: {
        "content-type": "application/json",
        cookie,
        Origin: "http://127.0.0.1:5173",
      },
    });
    assertEquals(disabledResponse.status, 200);
    assertEquals((await disabledResponse.json()).showPaidPostTitles, false);

    const wrongConnectorResponse = await app.request(
      `/sources/${telegram.id}`,
      {
        ...jsonRequest("PATCH", { showPaidPostTitles: true }),
        headers: {
          "content-type": "application/json",
          cookie,
          Origin: "http://127.0.0.1:5173",
        },
      },
    );
    assertEquals(wrongConnectorResponse.status, 422);

    const invalidResponse = await app.request(`/sources/${substack.id}`, {
      ...jsonRequest("PATCH", { showPaidPostTitles: "yes" }),
      headers: {
        "content-type": "application/json",
        cookie,
        Origin: "http://127.0.0.1:5173",
      },
    });
    assertEquals(invalidResponse.status, 422);
    assertEquals(
      (await findSourceById(database, substack.id, user.id))
        ?.showPaidPostTitles,
      false,
    );
  });
});

test("sources routes keep users scoped to their own rows", async () => {
  await withTestDb(async (database: Database) => {
    const credentialCipher = buildCredentialCipher();
    const app = buildApp(database);
    const { user: userA, cookie } = await registerAndLogin(
      app,
      "sources-owner-a@example.com",
    );
    const { user: userB } = await registerAndLogin(
      app,
      "sources-owner-b@example.com",
    );

    await createEncryptedSource(
      database,
      credentialCipher,
      userA.id,
      ConnectorId.Telegram,
      {
        position: 1,
      },
    );
    const userBSource = await createEncryptedSource(
      database,
      credentialCipher,
      userB.id,
      ConnectorId.RSS,
      {
        position: 2,
      },
    );

    const listResponse = await app.request("/sources", { headers: { cookie } });
    assertEquals(listResponse.status, 200);
    const listedSources = await listResponse.json();
    assertEquals(listedSources.length, 1);
    assertEquals(listedSources[0].userId, userA.id);
    assertEquals(listedSources[0].id === userBSource.id, false);

    const patchResponse = await app.request(`/sources/${userBSource.id}`, {
      ...jsonRequest("PATCH", { enabled: false }),
      headers: {
        "content-type": "application/json",
        cookie,
        Origin: "http://127.0.0.1:5173",
      },
    });
    assertEquals(patchResponse.status, 404);

    const deleteResponse = await app.request(`/sources/${userBSource.id}`, {
      method: "DELETE",
      headers: { cookie, Origin: "http://127.0.0.1:5173" },
    });
    assertEquals(deleteResponse.status, 404);
  });
});

test("sources routes reject invalid UUID parameters with 422", async () => {
  await withTestDb(async (database: Database) => {
    const app = buildApp(database);
    const { cookie } = await registerAndLogin(
      app,
      "sources-invalid-uuid@example.com",
    );

    const patchResponse = await app.request("/sources/not-a-uuid", {
      ...jsonRequest("PATCH", { enabled: false }),
      headers: {
        "content-type": "application/json",
        cookie,
        Origin: "http://127.0.0.1:5173",
      },
    });
    assertEquals(patchResponse.status, 422);

    const deleteResponse = await app.request("/sources/not-a-uuid", {
      method: "DELETE",
      headers: { cookie, Origin: "http://127.0.0.1:5173" },
    });
    assertEquals(deleteResponse.status, 422);
  });
});

test("PATCH /sources/:id rejects unsupported fields", async () => {
  await withTestDb(async (database: Database) => {
    const credentialCipher = buildCredentialCipher();
    const app = buildApp(database);
    const { user, cookie } = await registerAndLogin(
      app,
      "sources-extra-field@example.com",
    );
    const source = await createEncryptedSource(
      database,
      credentialCipher,
      user.id,
      ConnectorId.Telegram,
    );

    const response = await app.request(`/sources/${source.id}`, {
      ...jsonRequest("PATCH", { connectorId: "rss" }),
      headers: {
        "content-type": "application/json",
        cookie,
        Origin: "http://127.0.0.1:5173",
      },
    });
    assertEquals(response.status, 422);
  });
});

test("PATCH /sources/:id rejects positions outside the PostgreSQL integer range", async () => {
  await withTestDb(async (database: Database) => {
    const credentialCipher = buildCredentialCipher();
    const app = buildApp(database);
    const { user, cookie } = await registerAndLogin(
      app,
      "sources-position-range@example.com",
    );
    const source = await createEncryptedSource(
      database,
      credentialCipher,
      user.id,
      ConnectorId.Telegram,
    );

    const tooLargeResponse = await app.request(`/sources/${source.id}`, {
      ...jsonRequest("PATCH", { position: 2_147_483_648 }),
      headers: {
        "content-type": "application/json",
        cookie,
        Origin: "http://127.0.0.1:5173",
      },
    });
    assertEquals(tooLargeResponse.status, 422);

    const tooSmallResponse = await app.request(`/sources/${source.id}`, {
      ...jsonRequest("PATCH", { position: -2_147_483_649 }),
      headers: {
        "content-type": "application/json",
        cookie,
        Origin: "http://127.0.0.1:5173",
      },
    });
    assertEquals(tooSmallResponse.status, 422);
  });
});

test("DELETE /sources/:id disconnects telegram sources and preserves the row for history", async () => {
  await withTestDb(async (database: Database) => {
    const credentialCipher = buildCredentialCipher();
    const app = buildApp(database);
    const { user, cookie } = await registerAndLogin(
      app,
      "sources-disconnect-telegram@example.com",
    );
    const source = await createEncryptedSource(
      database,
      credentialCipher,
      user.id,
      ConnectorId.Telegram,
      {
        position: 2,
        enabled: true,
      },
    );
    const feed = await createOrReviveFeed(database, {
      userId: user.id,
      sourceId: source.id,
      externalId: "telegram-feed",
      name: "Telegram Feed",
      kind: "news",
    });

    const deleteResponse = await app.request(`/sources/${source.id}`, {
      method: "DELETE",
      headers: { cookie, Origin: "http://127.0.0.1:5173" },
    });
    assertEquals(deleteResponse.status, 200);
    const deleteJson = await deleteResponse.json();

    assertEquals(deleteJson.revokeTelegramSession, true);
    assertEquals(deleteJson.message, TELEGRAM_REVOKE_MESSAGE);
    assertEquals(deleteJson.source.id, source.id);
    assertEquals(deleteJson.source.connected, false);
    assertEquals(deleteJson.source.enabled, false);
    assertEquals("credentials" in deleteJson.source, false);

    const storedRows = await database
      .select({ credentials: sources.credentials, enabled: sources.enabled })
      .from(sources)
      .where(eq(sources.id, source.id))
      .limit(1);
    assertExists(storedRows[0]);
    assertEquals(storedRows[0].credentials, null);
    assertEquals(storedRows[0].enabled, false);

    const activeFeeds = await listFeedsForUser(database, user.id);
    assertEquals(activeFeeds.length, 0);
    const historicalFeeds = await listFeedsForUser(database, user.id, {
      includeDeleted: true,
    });
    assertEquals(historicalFeeds.length, 1);
    assertEquals(historicalFeeds[0].id, feed.id);
    assertExists(historicalFeeds[0].deletedAt);

    const listResponse = await app.request("/sources", { headers: { cookie } });
    assertEquals(listResponse.status, 200);
    const listedSources = await listResponse.json();
    assertEquals(listedSources.length, 1);
    assertEquals(listedSources[0].id, source.id);
    assertEquals(listedSources[0].connected, false);
    assertEquals(listedSources[0].enabled, false);
    assertEquals("credentials" in listedSources[0], false);
  });
});

test("PATCH /sources/:id rejects re-enabling a disconnected source", async () => {
  await withTestDb(async (database: Database) => {
    const credentialCipher = buildCredentialCipher();
    const app = buildApp(database);
    const { user, cookie } = await registerAndLogin(
      app,
      "sources-reenable-disconnected@example.com",
    );
    const source = await createEncryptedSource(
      database,
      credentialCipher,
      user.id,
      ConnectorId.Telegram,
      {
        enabled: true,
      },
    );

    const deleteResponse = await app.request(`/sources/${source.id}`, {
      method: "DELETE",
      headers: { cookie, Origin: "http://127.0.0.1:5173" },
    });
    assertEquals(deleteResponse.status, 200);

    const patchResponse = await app.request(`/sources/${source.id}`, {
      ...jsonRequest("PATCH", { enabled: true }),
      headers: {
        "content-type": "application/json",
        cookie,
        Origin: "http://127.0.0.1:5173",
      },
    });
    assertEquals(patchResponse.status, 409);
    const patchJson = await patchResponse.json();
    assertEquals(
      patchJson.error.message,
      "source must be reconnected before it can be enabled",
    );

    const stored = await findSourceById(database, source.id, user.id);
    assertExists(stored);
    assertEquals(stored.enabled, false);
  });
});

test("DELETE /sources/:id returns revokeTelegramSession false for non-telegram sources", async () => {
  await withTestDb(async (database: Database) => {
    const credentialCipher = buildCredentialCipher();
    const app = buildApp(database);
    const { user, cookie } = await registerAndLogin(
      app,
      "sources-disconnect-rss@example.com",
    );
    const source = await createEncryptedSource(
      database,
      credentialCipher,
      user.id,
      ConnectorId.RSS,
    );

    const response = await app.request(`/sources/${source.id}`, {
      method: "DELETE",
      headers: { cookie, Origin: "http://127.0.0.1:5173" },
    });
    assertEquals(response.status, 200);
    const json = await response.json();

    assertEquals(json.revokeTelegramSession, false);
    assertEquals(json.message, "Source disconnected.");
    assertEquals(json.source.enabled, false);
    assertEquals("credentials" in json.source, false);
  });
});

test("sources routes require authentication", async () => {
  await withTestDb(async (database: Database) => {
    const credentialCipher = buildCredentialCipher();
    const app = buildApp(database);
    const { user } = await registerAndLogin(app, "sources-no-auth@example.com");
    const source = await createEncryptedSource(
      database,
      credentialCipher,
      user.id,
      ConnectorId.Telegram,
    );

    const getResponse = await app.request("/sources");
    assertEquals(getResponse.status, 401);

    const patchResponse = await app.request(
      `/sources/${source.id}`,
      jsonRequest("PATCH", { enabled: false }),
    );
    assertEquals(patchResponse.status, 401);

    const deleteResponse = await app.request(`/sources/${source.id}`, {
      method: "DELETE",
    });
    assertEquals(deleteResponse.status, 401);
  });
});
