import { assertEquals, assertExists } from "@std/assert"
import type { Hono } from "@hono/hono";
import { ConnectorId } from "../../src/constants.ts";
import { CredentialCipher, type EncryptedBlob } from "../../src/crypto/credential-cipher.ts";
import { EnvMasterKeyProvider } from "../../src/crypto/key-provider.ts";
import type { Database } from "../../src/db/client.ts";
import { withTestDb } from "../../src/db/testing.ts";
import type { AvailableFeed } from "../../src/connectors/connector.types.ts";
import { createOrReviveFeed } from "../../src/repositories/feed-repository.ts";
import { createSource } from "../../src/repositories/source-repository.ts";
import { buildApp } from "../../src/server/app.ts";
import type { FeedDiscoveryFactory, FeedDiscoveryHandle } from "../../src/services/feed-service.ts";

const PASSWORD = "analytical-engine-1843";
const MASTER_KEY_BYTES = new Uint8Array(32).fill(19);

interface RegisteredUser {
  id: string;
  email: string;
}

class FakeFeedDiscoveryFactory implements FeedDiscoveryFactory {
  readonly createdFor: Array<{ sourceId: string; userId: string }> = [];
  disposeCount = 0;

  constructor(readonly feeds: AvailableFeed[]) {}

  create(source: { id: string }, userId: string): Promise<FeedDiscoveryHandle> {
    this.createdFor.push({ sourceId: source.id, userId });
    return Promise.resolve({
      connector: {
        listAvailableFeeds: () => Promise.resolve(this.feeds),
      },
      dispose: () => {
        this.disposeCount += 1;
      },
    });
  }
}

function buildCredentialCipher(): CredentialCipher {
  return new CredentialCipher(new EnvMasterKeyProvider(MASTER_KEY_BYTES));
}

function jsonRequest(method: "POST" | "PATCH" | "DELETE", body?: unknown): RequestInit {
  return {
    method,
    headers: { "content-type": "application/json", Origin: "http://127.0.0.1:5173" },
    body: body === undefined ? undefined : JSON.stringify(body),
  };
}

function extractCookie(response: Response): string {
  const header = response.headers.get("set-cookie");
  assertExists(header, "login did not set a session cookie");
  return header.split(";")[0];
}

async function register(app: Hono, email: string): Promise<RegisteredUser> {
  const response = await app.request(
    "/auth/register",
    jsonRequest("POST", { name: "Ada Lovelace", email, password: PASSWORD }),
  );
  assertEquals(response.status, 201);
  const json = await response.json();
  return { id: json.id, email: json.email };
}

async function login(app: Hono, email: string): Promise<string> {
  const response = await app.request(
    "/auth/login",
    jsonRequest("POST", { email, password: PASSWORD }),
  );
  assertEquals(response.status, 200);
  return extractCookie(response);
}

async function registerAndLogin(
  app: Hono,
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
): Promise<EncryptedBlob> {
  return await credentialCipher.encrypt(JSON.stringify({ sessionString: `${connectorId}-session` }), {
    userId,
    connectorId,
  });
}

async function createOwnedSource(
  database: Database,
  userId: string,
  connectorId: ConnectorId,
  position?: number | null,
) {
  return await createSource(database, {
    userId,
    connectorId,
    credentials: await encryptCredentials(buildCredentialCipher(), userId, connectorId),
    position,
  });
}

Deno.test("GET /sources/:id/available-feeds returns discovery results and disposes connector", async () => {
  await withTestDb(async (database) => {
    const discoveryFactory = new FakeFeedDiscoveryFactory([
      { externalId: "channel", name: "Channel", kind: "news" },
      { externalId: "group", name: "Group", kind: "discussion" },
    ]);
    const app = buildApp(database, { feeds: { discoveryFactory } });
    const { user, cookie } = await registerAndLogin(app, "feeds-discovery@example.com");
    const source = await createOwnedSource(database, user.id, ConnectorId.Telegram);

    const response = await app.request(`/sources/${source.id}/available-feeds`, { headers: { cookie } });
    assertEquals(response.status, 200);
    assertEquals(await response.json(), discoveryFactory.feeds);
    assertEquals(discoveryFactory.createdFor, [{ sourceId: source.id, userId: user.id }]);
    assertEquals(discoveryFactory.disposeCount, 1);
  });
});

Deno.test("feed routes subscribe, list, patch, and unsubscribe feeds", async () => {
  await withTestDb(async (database) => {
    const app = buildApp(database);
    const { user, cookie } = await registerAndLogin(app, "feeds-lifecycle@example.com");
    const telegram = await createOwnedSource(database, user.id, ConnectorId.Telegram, 2);
    const rss = await createOwnedSource(database, user.id, ConnectorId.RSS, 1);

    const subscribeRssResponse = await app.request(`/sources/${rss.id}/feeds`, {
      ...jsonRequest("POST", { externalId: "rss-a", name: "RSS A", kind: "news", position: 1 }),
      headers: { "content-type": "application/json", cookie, Origin: "http://127.0.0.1:5173" },
    });
    assertEquals(subscribeRssResponse.status, 201);
    const rssFeed = await subscribeRssResponse.json();

    const subscribeTelegramResponse = await app.request(`/sources/${telegram.id}/feeds`, {
      ...jsonRequest("POST", { externalId: "tg-a", name: "Telegram A", kind: "discussion", position: 1 }),
      headers: { "content-type": "application/json", cookie, Origin: "http://127.0.0.1:5173" },
    });
    assertEquals(subscribeTelegramResponse.status, 201);
    const telegramFeed = await subscribeTelegramResponse.json();

    const allFeedsResponse = await app.request("/feeds", { headers: { cookie } });
    assertEquals(allFeedsResponse.status, 200);
    assertEquals((await allFeedsResponse.json()).map((feed: { id: string }) => feed.id), [rssFeed.id, telegramFeed.id]);

    const sourceFeedsResponse = await app.request(`/sources/${telegram.id}/feeds`, { headers: { cookie } });
    assertEquals(sourceFeedsResponse.status, 200);
    assertEquals((await sourceFeedsResponse.json()).map((feed: { id: string }) => feed.id), [telegramFeed.id]);

    const patchResponse = await app.request(`/feeds/${telegramFeed.id}`, {
      ...jsonRequest("PATCH", { customPrompt: "   ", enabled: false, kind: "news", position: 4 }),
      headers: { "content-type": "application/json", cookie, Origin: "http://127.0.0.1:5173" },
    });
    assertEquals(patchResponse.status, 200);
    const patched = await patchResponse.json();
    assertEquals(patched.customPrompt, null);
    assertEquals(patched.enabled, false);
    assertEquals(patched.kind, "news");
    assertEquals(patched.position, 4);

    const deleteResponse = await app.request(`/feeds/${telegramFeed.id}`, {
      method: "DELETE",
      headers: { cookie, Origin: "http://127.0.0.1:5173" },
    });
    assertEquals(deleteResponse.status, 200);
    assertEquals((await deleteResponse.json()).deletedAt !== null, true);

    const remainingResponse = await app.request("/feeds", { headers: { cookie } });
    assertEquals((await remainingResponse.json()).map((feed: { id: string }) => feed.id), [rssFeed.id]);
  });
});

Deno.test("subscribing a soft-deleted feed revives the same row", async () => {
  await withTestDb(async (database) => {
    const app = buildApp(database);
    const { user, cookie } = await registerAndLogin(app, "feeds-revive@example.com");
    const source = await createOwnedSource(database, user.id, ConnectorId.Telegram);

    const firstResponse = await app.request(`/sources/${source.id}/feeds`, {
      ...jsonRequest("POST", { externalId: "same", name: "Old", kind: "news" }),
      headers: { "content-type": "application/json", cookie, Origin: "http://127.0.0.1:5173" },
    });
    const first = await firstResponse.json();
    await app.request(`/feeds/${first.id}`, { method: "DELETE", headers: { cookie, Origin: "http://127.0.0.1:5173" } });

    const revivedResponse = await app.request(`/sources/${source.id}/feeds`, {
      ...jsonRequest("POST", { externalId: "same", name: "New", kind: "discussion" }),
      headers: { "content-type": "application/json", cookie, Origin: "http://127.0.0.1:5173" },
    });
    assertEquals(revivedResponse.status, 201);
    const revived = await revivedResponse.json();
    assertEquals(revived.id, first.id);
    assertEquals(revived.name, "New");
    assertEquals(revived.kind, "discussion");
    assertEquals(revived.deletedAt, null);
  });
});

Deno.test("subscribing a disconnected source is rejected", async () => {
  await withTestDb(async (database) => {
    const app = buildApp(database);
    const { user, cookie } = await registerAndLogin(app, "feeds-disconnected-source@example.com");
    const source = await createOwnedSource(database, user.id, ConnectorId.Telegram);
    const firstResponse = await app.request(`/sources/${source.id}/feeds`, {
      ...jsonRequest("POST", { externalId: "same", name: "Old", kind: "news" }),
      headers: { "content-type": "application/json", cookie, Origin: "http://127.0.0.1:5173" },
    });
    assertEquals(firstResponse.status, 201);
    const first = await firstResponse.json();

    const disconnectResponse = await app.request(`/sources/${source.id}`, {
      method: "DELETE",
      headers: { cookie, Origin: "http://127.0.0.1:5173" },
    });
    assertEquals(disconnectResponse.status, 200);

    const revivedResponse = await app.request(`/sources/${source.id}/feeds`, {
      ...jsonRequest("POST", { externalId: "same", name: "Revived", kind: "discussion" }),
      headers: { "content-type": "application/json", cookie, Origin: "http://127.0.0.1:5173" },
    });
    assertEquals(revivedResponse.status, 409);

    const newFeedResponse = await app.request(`/sources/${source.id}/feeds`, {
      ...jsonRequest("POST", { externalId: "new", name: "New", kind: "news" }),
      headers: { "content-type": "application/json", cookie, Origin: "http://127.0.0.1:5173" },
    });
    assertEquals(newFeedResponse.status, 409);

    const visibleFeedsResponse = await app.request("/feeds", { headers: { cookie } });
    assertEquals(await visibleFeedsResponse.json(), []);
    const hiddenFeedResponse = await app.request(`/feeds/${first.id}`, { headers: { cookie } });
    assertEquals(hiddenFeedResponse.status, 200);
    assertEquals((await hiddenFeedResponse.json()).deletedAt !== null, true);
  });
});

Deno.test("feed routes keep users scoped to their own sources and feeds", async () => {
  await withTestDb(async (database) => {
    const app = buildApp(database);
    const { user: owner, cookie: ownerCookie } = await registerAndLogin(app, "feeds-owner@example.com");
    const { cookie: otherCookie } = await registerAndLogin(app, "feeds-other@example.com");
    const source = await createOwnedSource(database, owner.id, ConnectorId.Telegram);
    const feed = await createOrReviveFeed(database, {
      userId: owner.id,
      sourceId: source.id,
      externalId: "owned-feed",
      name: "Owned Feed",
      kind: "news",
    });

    const otherListResponse = await app.request(`/sources/${source.id}/feeds`, { headers: { cookie: otherCookie, Origin: "http://127.0.0.1:5173" } });
    assertEquals(otherListResponse.status, 404);

    const otherSubscribeResponse = await app.request(`/sources/${source.id}/feeds`, {
      ...jsonRequest("POST", { externalId: "cross", name: "Cross", kind: "news" }),
      headers: { "content-type": "application/json", cookie: otherCookie, Origin: "http://127.0.0.1:5173" },
    });
    assertEquals(otherSubscribeResponse.status, 404);

    const otherPatchResponse = await app.request(`/feeds/${feed.id}`, {
      ...jsonRequest("PATCH", { enabled: false }),
      headers: { "content-type": "application/json", cookie: otherCookie, Origin: "http://127.0.0.1:5173" },
    });
    assertEquals(otherPatchResponse.status, 404);

    const ownerListResponse = await app.request("/feeds", { headers: { cookie: ownerCookie, Origin: "http://127.0.0.1:5173" } });
    assertEquals(ownerListResponse.status, 200);
    assertEquals((await ownerListResponse.json()).length, 1);
  });
});

Deno.test("feed routes validate bodies and parameters", async () => {
  await withTestDb(async (database) => {
    const app = buildApp(database);
    const { user, cookie } = await registerAndLogin(app, "feeds-validation@example.com");
    const source = await createOwnedSource(database, user.id, ConnectorId.Telegram);
    const feed = await createOrReviveFeed(database, {
      userId: user.id,
      sourceId: source.id,
      externalId: "valid-feed",
      name: "Valid Feed",
      kind: "news",
    });

    const invalidPositionResponse = await app.request(`/feeds/${feed.id}`, {
      ...jsonRequest("PATCH", { position: 2_147_483_648 }),
      headers: { "content-type": "application/json", cookie, Origin: "http://127.0.0.1:5173" },
    });
    assertEquals(invalidPositionResponse.status, 422);

    const invalidKindResponse = await app.request(`/sources/${source.id}/feeds`, {
      ...jsonRequest("POST", { externalId: "bad", name: "Bad", kind: "chat" }),
      headers: { "content-type": "application/json", cookie, Origin: "http://127.0.0.1:5173" },
    });
    assertEquals(invalidKindResponse.status, 422);

    const invalidParameterResponse = await app.request("/feeds/not-a-uuid", {
      ...jsonRequest("PATCH", { enabled: false }),
      headers: { "content-type": "application/json", cookie, Origin: "http://127.0.0.1:5173" },
    });
    assertEquals(invalidParameterResponse.status, 422);
  });
});
