import { test } from "bun:test";
import { assertEquals, assertExists } from "../assertions.ts";
import type { Hono } from "hono";
import { ConnectorId } from "../../src/constants.ts";
import { CredentialCipher, type EncryptedBlob } from "../../src/crypto/credential-cipher.ts";
import { EnvMasterKeyProvider } from "../../src/crypto/key-provider.ts";
import type { Database } from "../../src/db/client.ts";
import { withTestDb } from "../../src/db/testing.ts";
import type { AvailableFeed } from "../../src/connectors/connector.types.ts";
import {
  createOrReviveFeed,
  type PublicFeed,
} from "../../src/repositories/feed-repository.ts";
import { createSource } from "../../src/repositories/source-repository.ts";
import { buildApp } from "../../src/server/app.ts";
import type { ServerEnvironment } from "../../src/server/app.ts";
import type { FeedDiscoveryFactory, FeedDiscoveryHandle } from "../../src/services/feed-service.ts";
import { createUser } from "../../src/repositories/user-repository.ts";
import { createSession } from "../../src/auth/session-service.ts";

const PASSWORD = "analytical-engine-1843";
const MASTER_KEY_BYTES = new Uint8Array(32).fill(19);

interface RegisteredUser {
  id: string;
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

test("GET /sources/:id/available-feeds returns discovery results and disposes connector", async () => {
  await withTestDb(async (database) => {
    const discoveryFactory = new FakeFeedDiscoveryFactory([
      { externalId: "channel", name: "Channel", kind: "news" },
      { externalId: "group", name: "Group", kind: "discussion" },
    ]);
    const app = buildApp(database, { feeds: { discoveryFactory } });
    const { user, cookie } = await registerAndLogin(app);
    const source = await createOwnedSource(database, user.id, ConnectorId.Telegram);

    const response = await app.request(`/sources/${source.id}/available-feeds`, { headers: { cookie } });
    assertEquals(response.status, 200);
    assertEquals(await response.json(), discoveryFactory.feeds);
    assertEquals(discoveryFactory.createdFor, [{ sourceId: source.id, userId: user.id }]);
    assertEquals(discoveryFactory.disposeCount, 1);
  });
});

test("generic feed routes reject connector-owned Substack and X creation paths", async () => {
  await withTestDb(async (database) => {
    const discoveryFactory = new FakeFeedDiscoveryFactory([]);
    const app = buildApp(database, { feeds: { discoveryFactory } });
    const { user, cookie } = await registerAndLogin(app);
    const source = await createOwnedSource(database, user.id, ConnectorId.Substack);

    const discovery = await app.request(`/sources/${source.id}/available-feeds`, {
      headers: { cookie },
    });
    assertEquals(discovery.status, 409);
    assertEquals(discoveryFactory.createdFor, []);

    const subscribe = await app.request(`/sources/${source.id}/feeds`, {
      ...jsonRequest("POST", {
        externalId: "client-controlled",
        name: "Bypass",
        kind: "news",
      }),
      headers: {
        "content-type": "application/json",
        cookie,
        Origin: "http://127.0.0.1:5173",
      },
    });
    assertEquals(subscribe.status, 409);

    const xSource = await createOwnedSource(database, user.id, ConnectorId.X);
    const xSubscribe = await app.request(`/sources/${xSource.id}/feeds`, {
      ...jsonRequest("POST", {
        externalId: "x:chat:compose",
        name: "Unverified X target",
        kind: "discussion",
      }),
      headers: {
        "content-type": "application/json",
        cookie,
        Origin: "http://127.0.0.1:5173",
      },
    });
    assertEquals(xSubscribe.status, 409);
  });
});

test("feed routes subscribe, list, patch, and unsubscribe feeds", async () => {
  await withTestDb(async (database) => {
    const app = buildApp(database);
    const { user, cookie } = await registerAndLogin(app);
    const telegram = await createOwnedSource(database, user.id, ConnectorId.Telegram, 2);
    const rss = await createOwnedSource(database, user.id, ConnectorId.RSS, 1);

    const subscribeRssResponse = await app.request(`/sources/${rss.id}/feeds`, {
      ...jsonRequest("POST", {
        externalId: "rss-a",
        name: "RSS A",
        kind: "news",
        position: 1,
        summarizationMode: "thorough",
      }),
      headers: { "content-type": "application/json", cookie, Origin: "http://127.0.0.1:5173" },
    });
    assertEquals(subscribeRssResponse.status, 201);
    const rssFeed = await subscribeRssResponse.json() as PublicFeed;

    const subscribeTelegramResponse = await app.request(`/sources/${telegram.id}/feeds`, {
      ...jsonRequest("POST", { externalId: "tg-a", name: "Telegram A", kind: "discussion", position: 1 }),
      headers: { "content-type": "application/json", cookie, Origin: "http://127.0.0.1:5173" },
    });
    assertEquals(subscribeTelegramResponse.status, 201);
    const telegramFeed = await subscribeTelegramResponse.json() as PublicFeed;
    assertEquals(rssFeed.summarizationMode, "thorough");
    assertEquals(telegramFeed.summarizationMode, "basic");

    const allFeedsResponse = await app.request("/feeds", { headers: { cookie } });
    assertEquals(allFeedsResponse.status, 200);
    const allFeeds = await allFeedsResponse.json() as PublicFeed[];
    assertEquals(
      allFeeds.map((feed) => ({
        id: feed.id,
        summarizationMode: feed.summarizationMode,
      })),
      [
        { id: rssFeed.id, summarizationMode: "thorough" },
        { id: telegramFeed.id, summarizationMode: "basic" },
      ],
    );

    const sourceFeedsResponse = await app.request(`/sources/${telegram.id}/feeds`, { headers: { cookie } });
    assertEquals(sourceFeedsResponse.status, 200);
    const sourceFeeds = await sourceFeedsResponse.json() as PublicFeed[];
    assertEquals(
      sourceFeeds.map((feed) => ({
        id: feed.id,
        summarizationMode: feed.summarizationMode,
      })),
      [{ id: telegramFeed.id, summarizationMode: "basic" }],
    );

    const findResponse = await app.request(`/feeds/${telegramFeed.id}`, {
      headers: { cookie },
    });
    assertEquals(findResponse.status, 200);
    const found = await findResponse.json() as PublicFeed;
    assertEquals(found.summarizationMode, "basic");

    const patchResponse = await app.request(`/feeds/${telegramFeed.id}`, {
      ...jsonRequest("PATCH", {
        customPrompt: "   ",
        enabled: false,
        kind: "news",
        position: 4,
        summarizationMode: "thorough",
        relevanceFilterMode: "include_all",
      }),
      headers: { "content-type": "application/json", cookie, Origin: "http://127.0.0.1:5173" },
    });
    assertEquals(patchResponse.status, 200);
    const patched = await patchResponse.json() as PublicFeed;
    assertEquals(patched.customPrompt, null);
    assertEquals(patched.enabled, false);
    assertEquals(patched.kind, "news");
    assertEquals(patched.position, 4);
    assertEquals(patched.relevanceFilterMode, "include_all");
    assertEquals(patched.summarizationMode, "thorough");

    const basicPatchResponse = await app.request(`/feeds/${telegramFeed.id}`, {
      ...jsonRequest("PATCH", { summarizationMode: "basic" }),
      headers: { "content-type": "application/json", cookie, Origin: "http://127.0.0.1:5173" },
    });
    assertEquals(basicPatchResponse.status, 200);
    const basicPatched = await basicPatchResponse.json() as PublicFeed;
    assertEquals(basicPatched.summarizationMode, "basic");

    const invalidModeResponse = await app.request(`/feeds/${telegramFeed.id}`, {
      ...jsonRequest("PATCH", { relevanceFilterMode: "invalid" }),
      headers: { "content-type": "application/json", cookie, Origin: "http://127.0.0.1:5173" },
    });
    assertEquals(invalidModeResponse.status, 422);
    await invalidModeResponse.body?.cancel();

    const deleteResponse = await app.request(`/feeds/${telegramFeed.id}`, {
      method: "DELETE",
      headers: { cookie, Origin: "http://127.0.0.1:5173" },
    });
    assertEquals(deleteResponse.status, 200);
    const deleted = await deleteResponse.json() as PublicFeed;
    assertEquals(deleted.deletedAt !== null, true);
    assertEquals(deleted.summarizationMode, "basic");

    const remainingResponse = await app.request("/feeds", { headers: { cookie } });
    const remaining = await remainingResponse.json() as PublicFeed[];
    assertEquals(
      remaining.map((feed) => ({
        id: feed.id,
        summarizationMode: feed.summarizationMode,
      })),
      [{ id: rssFeed.id, summarizationMode: "thorough" }],
    );
  });
});

test("subscribing a soft-deleted feed revives the same row", async () => {
  await withTestDb(async (database) => {
    const app = buildApp(database);
    const { user, cookie } = await registerAndLogin(app);
    const source = await createOwnedSource(database, user.id, ConnectorId.Telegram);

    const firstResponse = await app.request(`/sources/${source.id}/feeds`, {
      ...jsonRequest("POST", {
        externalId: "same",
        name: "Old",
        kind: "news",
        summarizationMode: "thorough",
      }),
      headers: { "content-type": "application/json", cookie, Origin: "http://127.0.0.1:5173" },
    });
    const first = await firstResponse.json() as PublicFeed;
    assertEquals(first.summarizationMode, "thorough");
    await app.request(`/feeds/${first.id}`, { method: "DELETE", headers: { cookie, Origin: "http://127.0.0.1:5173" } });

    const revivedResponse = await app.request(`/sources/${source.id}/feeds`, {
      ...jsonRequest("POST", { externalId: "same", name: "New", kind: "discussion" }),
      headers: { "content-type": "application/json", cookie, Origin: "http://127.0.0.1:5173" },
    });
    assertEquals(revivedResponse.status, 201);
    const revived = await revivedResponse.json() as PublicFeed;
    assertEquals(revived.id, first.id);
    assertEquals(revived.name, "New");
    assertEquals(revived.kind, "discussion");
    assertEquals(revived.deletedAt, null);
    assertEquals(revived.summarizationMode, "basic");

    await app.request(`/feeds/${revived.id}`, { method: "DELETE", headers: { cookie, Origin: "http://127.0.0.1:5173" } });
    const explicitRevivalResponse = await app.request(`/sources/${source.id}/feeds`, {
      ...jsonRequest("POST", {
        externalId: "same",
        name: "Explicit",
        kind: "news",
        summarizationMode: "thorough",
      }),
      headers: { "content-type": "application/json", cookie, Origin: "http://127.0.0.1:5173" },
    });
    assertEquals(explicitRevivalResponse.status, 201);
    const explicitlyRevived = await explicitRevivalResponse.json() as PublicFeed;
    assertEquals(explicitlyRevived.id, first.id);
    assertEquals(explicitlyRevived.summarizationMode, "thorough");
  });
});

test("subscribing a disconnected source is rejected", async () => {
  await withTestDb(async (database) => {
    const app = buildApp(database);
    const { user, cookie } = await registerAndLogin(app);
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

test("feed routes keep users scoped to their own sources and feeds", async () => {
  await withTestDb(async (database) => {
    const app = buildApp(database);
    const { user: owner, cookie: ownerCookie } = await registerAndLogin(app);
    const otherCookie = await strangerSession(database, "feeds-other@example.com");
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
      ...jsonRequest("PATCH", {
        enabled: false,
        summarizationMode: "thorough",
      }),
      headers: { "content-type": "application/json", cookie: otherCookie, Origin: "http://127.0.0.1:5173" },
    });
    assertEquals(otherPatchResponse.status, 404);

    const ownerFindResponse = await app.request(`/feeds/${feed.id}`, {
      headers: { cookie: ownerCookie, Origin: "http://127.0.0.1:5173" },
    });
    assertEquals(ownerFindResponse.status, 200);
    const unchanged = await ownerFindResponse.json() as PublicFeed;
    assertEquals(unchanged.enabled, true);
    assertEquals(unchanged.summarizationMode, "basic");

    const ownerListResponse = await app.request("/feeds", { headers: { cookie: ownerCookie, Origin: "http://127.0.0.1:5173" } });
    assertEquals(ownerListResponse.status, 200);
    assertEquals((await ownerListResponse.json()).length, 1);
  });
});

test("feed routes validate bodies and parameters", async () => {
  await withTestDb(async (database) => {
    const app = buildApp(database);
    const { user, cookie } = await registerAndLogin(app);
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

    const invalidSummarizationModeResponse = await app.request(`/feeds/${feed.id}`, {
      ...jsonRequest("PATCH", {
        enabled: false,
        summarizationMode: "verbose",
      }),
      headers: { "content-type": "application/json", cookie, Origin: "http://127.0.0.1:5173" },
    });
    assertEquals(invalidSummarizationModeResponse.status, 422);
    await invalidSummarizationModeResponse.body?.cancel();

    const unchangedResponse = await app.request(`/feeds/${feed.id}`, {
      headers: { cookie },
    });
    assertEquals(unchangedResponse.status, 200);
    const unchanged = await unchangedResponse.json() as PublicFeed;
    assertEquals(unchanged.enabled, true);
    assertEquals(unchanged.summarizationMode, "basic");

    const invalidKindResponse = await app.request(`/sources/${source.id}/feeds`, {
      ...jsonRequest("POST", { externalId: "bad", name: "Bad", kind: "chat" }),
      headers: { "content-type": "application/json", cookie, Origin: "http://127.0.0.1:5173" },
    });
    assertEquals(invalidKindResponse.status, 422);

    const invalidCreateModeResponse = await app.request(
      `/sources/${source.id}/feeds`,
      {
        ...jsonRequest("POST", {
          externalId: "bad-mode",
          name: "Bad Mode",
          kind: "news",
          summarizationMode: "verbose",
        }),
        headers: {
          "content-type": "application/json",
          cookie,
          Origin: "http://127.0.0.1:5173",
        },
      },
    );
    assertEquals(invalidCreateModeResponse.status, 422);
    await invalidCreateModeResponse.body?.cancel();

    const invalidParameterResponse = await app.request("/feeds/not-a-uuid", {
      ...jsonRequest("PATCH", { enabled: false }),
      headers: { "content-type": "application/json", cookie, Origin: "http://127.0.0.1:5173" },
    });
    assertEquals(invalidParameterResponse.status, 422);
  });
});
