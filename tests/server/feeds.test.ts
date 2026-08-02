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
import {
  listDiscoveredFeedsForSource,
  replaceDiscoveredFeedsForRevision,
} from "../../src/repositories/x-discovered-feed-repository.ts";
import { buildApp } from "../../src/server/app.ts";
import type { ServerEnvironment } from "../../src/server/app.ts";
import type { FeedDiscoveryFactory, FeedDiscoveryHandle } from "../../src/services/feed-service.ts";
import {
  DefaultFeedDiscoveryFactory,
} from "../../src/services/feed-service.ts";
import {
  type XApiClientFactory,
  type XContentCacheFactory,
} from "../../src/connectors/connector-factory.ts";
import type { XApiClient } from "../../src/connectors/x/twex-api-client.ts";
import type { XContentCache } from "../../src/repositories/x-content-cache-repository.ts";
import { upsertSourceCredentials } from "../../src/repositories/source-repository.ts";
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

  constructor(
    readonly feeds: AvailableFeed[],
    private readonly onCreate: () => void = () => {},
  ) {}

  create(source: { id: string }, userId: string): Promise<FeedDiscoveryHandle> {
    this.onCreate();
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

async function encryptXCredentials(
  credentialCipher: CredentialCipher,
  userId: string,
): Promise<EncryptedBlob> {
  return await credentialCipher.encrypt(
    JSON.stringify({
      apiKey: "twex-api-key",
      authToken: "auth-token-123",
      cookie: "auth_token=auth-token-123; ct0=csrf-token-456",
      pin: "1234",
      listQuery: "my-lists",
      xUserId: "x-user-1",
      xUsername: "alice",
    }),
    { userId, connectorId: ConnectorId.X },
  );
}

async function createConnectedXSource(
  database: Database,
  userId: string,
): Promise<{ id: string }> {
  return await createSource(database, {
    userId,
    connectorId: ConnectorId.X,
    credentials: await encryptXCredentials(buildCredentialCipher(), userId),
    enabled: true,
  });
}

const X_CATALOG_FEEDS: AvailableFeed[] = [
  { externalId: "x:list:44196397", name: "Curated List", kind: "news" },
  {
    externalId: "x:chat:group-42",
    name: "Group (5 participants) - group-42",
    kind: "discussion",
  },
];

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

test("GET X available feeds extends the bound request timeout before discovery", async () => {
  await withTestDb(async (database) => {
    const events: string[] = [];
    const discoveryFactory = new FakeFeedDiscoveryFactory(
      [
        { externalId: "x:list:44196397", name: "Curated List", kind: "news" },
        { externalId: "x:chat:group-42", name: "Group (5 participants) - group-42", kind: "discussion" },
      ],
      () => events.push("discover"),
    );
    const app = buildApp(database, { feeds: { discoveryFactory } });
    const { user, cookie } = await registerAndLogin(app);
    const source = await createOwnedSource(database, user.id, ConnectorId.X);
    const request = new Request(
      `http://localhost/sources/${source.id}/available-feeds`,
      { headers: { cookie } },
    );

    const response = await app.fetch(request, {
      server: {
        timeout(boundRequest: Request, seconds: number) {
          events.push(`timeout:${boundRequest.url}:${seconds}`);
        },
      } as unknown as Bun.Server<undefined>,
    });

    assertEquals(response.status, 200);
    assertEquals(await response.json(), discoveryFactory.feeds);
    assertEquals(events, [`timeout:${request.url}:255`, "discover"]);
    assertEquals(discoveryFactory.createdFor, [{
      sourceId: source.id,
      userId: user.id,
    }]);
    assertEquals(discoveryFactory.disposeCount, 1);
  });
});

test("generic feed routes reject connector-owned Substack creation and require a current catalog for X subscription", async () => {
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

    // X subscription is authorized only by a catalog entry for the source's
    // current revision, and server-canonical name/kind win over the client.
    const xSource = await createConnectedXSource(database, user.id);
    replaceDiscoveredFeedsForRevision(database, xSource.id, 1, X_CATALOG_FEEDS);

    const xListSubscribe = await app.request(`/sources/${xSource.id}/feeds`, {
      ...jsonRequest("POST", {
        externalId: "x:list:44196397",
        name: "Spoofed List Name",
        kind: "discussion",
      }),
      headers: {
        "content-type": "application/json",
        cookie,
        Origin: "http://127.0.0.1:5173",
      },
    });
    assertEquals(xListSubscribe.status, 201);
    const xListFeed = await xListSubscribe.json() as PublicFeed;
    assertEquals(xListFeed.externalId, "x:list:44196397");
    assertEquals(xListFeed.name, "Curated List");
    assertEquals(xListFeed.kind, "news");

    const xChatSubscribe = await app.request(`/sources/${xSource.id}/feeds`, {
      ...jsonRequest("POST", {
        externalId: "x:chat:group-42",
        name: "Spoofed Chat Name",
        kind: "news",
      }),
      headers: {
        "content-type": "application/json",
        cookie,
        Origin: "http://127.0.0.1:5173",
      },
    });
    assertEquals(xChatSubscribe.status, 201);
    const xChatFeed = await xChatSubscribe.json() as PublicFeed;
    assertEquals(xChatFeed.externalId, "x:chat:group-42");
    assertEquals(xChatFeed.name, "Group (5 participants) - group-42");
    assertEquals(xChatFeed.kind, "discussion");

    // Uncataloged well-formed targets (e.g. a direct DM) fail closed.
    const directDm = await app.request(`/sources/${xSource.id}/feeds`, {
      ...jsonRequest("POST", {
        externalId: "x:chat:direct-dm-1",
        name: "Direct DM",
        kind: "discussion",
      }),
      headers: {
        "content-type": "application/json",
        cookie,
        Origin: "http://127.0.0.1:5173",
      },
    });
    assertEquals(directDm.status, 409);

    // Non-list/non-chat and malformed external IDs are validation errors.
    for (const externalId of ["x:following", "bogus", "x:list:not-a-number"]) {
      const malformed = await app.request(`/sources/${xSource.id}/feeds`, {
        ...jsonRequest("POST", {
          externalId,
          name: "Spoofed",
          kind: "news",
        }),
        headers: {
          "content-type": "application/json",
          cookie,
          Origin: "http://127.0.0.1:5173",
        },
      });
      assertEquals(malformed.status, 422, `expected 422 for ${externalId}`);
      await malformed.body?.cancel();
    }

    const listed = await app.request(`/sources/${xSource.id}/feeds`, {
      headers: { cookie },
    });
    const feeds = await listed.json() as PublicFeed[];
    assertEquals(feeds.map((feed) => feed.externalId), [
      "x:list:44196397",
      "x:chat:group-42",
    ]);
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

interface XCallCounters {
  searchLists: number;
  getConversations: number;
}

function fakeXDiscoveryClient(counters: XCallCounters, state: {
  lists: Array<{ id: string; name: string }>;
  conversations: Array<{ conversation_id: string; type: string; participants: string[] }>;
}): XApiClientFactory {
  return {
    createClient: () => ({
      getUserInfo: () => Promise.reject(new Error("unused")),
      searchLists: (_query: string, _targetCount: number) => {
        counters.searchLists += 1;
        return Promise.resolve(state.lists);
      },
      getConversations: () => {
        counters.getConversations += 1;
        return Promise.resolve(state.conversations);
      },
      getListPosts: () => Promise.resolve([]),
      getChatMessages: () => Promise.resolve([]),
    } as unknown as XApiClient),
  };
}

function fakeXDiscoveryCache(): XContentCacheFactory {
  return {
    createCache: () => ({
      missingRanges: () => [],
      read: () => [],
      record: () => {},
      clear: () => {},
    } as unknown as XContentCache),
  };
}

interface MutableXDiscovery {
  factory: FeedDiscoveryFactory;
  state: {
    lists: Array<{ id: string; name: string }>;
    conversations: Array<{ conversation_id: string; type: string; participants: string[] }>;
  };
  counters: XCallCounters;
}

function xDiscoveryFactory(database: Database, options: {
  lists?: Array<{ id: string; name: string }>;
  conversations?: Array<{ conversation_id: string; type: string; participants: string[] }>;
} = {}): MutableXDiscovery {
  const counters: XCallCounters = { searchLists: 0, getConversations: 0 };
  const state = {
    lists: options.lists ?? [{ id: "44196397", name: "Curated List" }],
    conversations: options.conversations ?? [
      {
        conversation_id: "group-42",
        type: "group",
        participants: ["a", "b", "c", "d", "e"],
      },
      { conversation_id: "direct-dm-1", type: "direct", participants: ["a", "b"] },
    ],
  };
  const factory = new DefaultFeedDiscoveryFactory(
    database,
    buildCredentialCipher(),
    undefined,
    {
      xApiClientFactory: fakeXDiscoveryClient(counters, state),
      xContentCacheFactory: fakeXDiscoveryCache(),
    },
  );
  return { factory, state, counters };
}

test("X discovery populates the catalog and subscription enforces it end to end", async () => {
  await withTestDb(async (database) => {
    const discovery = xDiscoveryFactory(database);
    const app = buildApp(database, {
      feeds: { discoveryFactory: discovery.factory },
    });
    const { user, cookie } = await registerAndLogin(app);
    const xSource = await createConnectedXSource(database, user.id);

    // Fresh discovery catalogs exactly the returned lists and group chats,
    // excluding direct-DM conversations.
    const discoveryResponse = await app.request(
      `/sources/${xSource.id}/available-feeds`,
      { headers: { cookie } },
    );
    assertEquals(discoveryResponse.status, 200);
    const discovered = await discoveryResponse.json() as AvailableFeed[];
    assertEquals(discovered.map((feed) => feed.externalId), [
      "x:list:44196397",
      "x:chat:group-42",
    ]);
    assertEquals(listDiscoveredFeedsForSource(database, xSource.id).length, 2);
    assertEquals(discovery.counters, { searchLists: 1, getConversations: 1 });

    // Subscription of a cataloged target with spoofed metadata persists the
    // server-canonical name/kind.
    const subscribeResponse = await app.request(`/sources/${xSource.id}/feeds`, {
      ...jsonRequest("POST", {
        externalId: "x:list:44196397",
        name: "Spoofed List Name",
        kind: "discussion",
      }),
      headers: { "content-type": "application/json", cookie, Origin: "http://127.0.0.1:5173" },
    });
    assertEquals(subscribeResponse.status, 201);
    const feed = await subscribeResponse.json() as PublicFeed;
    assertEquals(feed.name, "Curated List");
    assertEquals(feed.kind, "news");

    // Uncataloged direct DMs and malformed IDs stay rejected, and no upstream
    // discovery call happens for any subscription.
    const directDm = await app.request(`/sources/${xSource.id}/feeds`, {
      ...jsonRequest("POST", {
        externalId: "x:chat:direct-dm-1",
        name: "Direct DM",
        kind: "discussion",
      }),
      headers: { "content-type": "application/json", cookie, Origin: "http://127.0.0.1:5173" },
    });
    assertEquals(directDm.status, 409);
    const malformed = await app.request(`/sources/${xSource.id}/feeds`, {
      ...jsonRequest("POST", {
        externalId: "x:following",
        name: "Spoofed",
        kind: "news",
      }),
      headers: { "content-type": "application/json", cookie, Origin: "http://127.0.0.1:5173" },
    });
    assertEquals(malformed.status, 422);
    await malformed.body?.cancel();
    assertEquals(discovery.counters, { searchLists: 1, getConversations: 1 });

    // A same-account reconnect bumps the revision: the old catalog no longer
    // authorizes anything until a fresh discovery replaces it.
    await upsertSourceCredentials(database, {
      userId: user.id,
      connectorId: ConnectorId.X,
      credentials: await encryptXCredentials(buildCredentialCipher(), user.id),
    });
    const staleSubscribe = await app.request(`/sources/${xSource.id}/feeds`, {
      ...jsonRequest("POST", {
        externalId: "x:list:44196397",
        name: "Curated List",
        kind: "news",
      }),
      headers: { "content-type": "application/json", cookie, Origin: "http://127.0.0.1:5173" },
    });
    assertEquals(staleSubscribe.status, 409);

    // A fresh discovery at the new revision authorizes the returned targets
    // again, and a changed result set replaces the catalog.
    const refreshed = await app.request(`/sources/${xSource.id}/available-feeds`, {
      headers: { cookie },
    });
    assertEquals(refreshed.status, 200);
    const refreshedSubscribe = await app.request(`/sources/${xSource.id}/feeds`, {
      ...jsonRequest("POST", {
        externalId: "x:list:44196397",
        name: "Spoofed Again",
        kind: "discussion",
      }),
      headers: { "content-type": "application/json", cookie, Origin: "http://127.0.0.1:5173" },
    });
    assertEquals(refreshedSubscribe.status, 201);
    assertEquals((await refreshedSubscribe.json() as PublicFeed).name, "Curated List");
  });
});

test("X discovery catalog is replaced by a changed result set and supports connected-but-disabled sources", async () => {
  await withTestDb(async (database) => {
    const discovery = xDiscoveryFactory(database, {
      lists: [{ id: "44196397", name: "Curated List" }],
    });
    const app = buildApp(database, {
      feeds: { discoveryFactory: discovery.factory },
    });
    const { user, cookie } = await registerAndLogin(app);
    const xSource = await createConnectedXSource(database, user.id);

    const firstDiscovery = await app.request(`/sources/${xSource.id}/available-feeds`, {
      headers: { cookie },
    });
    assertEquals(firstDiscovery.status, 200);
    assertEquals(listDiscoveredFeedsForSource(database, xSource.id).length, 2);

    // A second discovery with a different result set replaces the catalog
    // wholesale: the dropped target is no longer subscribable.
    discovery.state.lists = [{ id: "777", name: "New List" }];
    discovery.state.conversations = [];
    const secondDiscovery = await app.request(`/sources/${xSource.id}/available-feeds`, {
      headers: { cookie },
    });
    assertEquals(secondDiscovery.status, 200);
    assertEquals((await secondDiscovery.json() as AvailableFeed[]).map((feed) => feed.externalId), [
      "x:list:777",
    ]);
    assertEquals(listDiscoveredFeedsForSource(database, xSource.id), [
      {
        credentialRevision: 1,
        externalId: "x:list:777",
        name: "New List",
        kind: "news",
      },
    ]);
    const dropped = await app.request(`/sources/${xSource.id}/feeds`, {
      ...jsonRequest("POST", {
        externalId: "x:chat:group-42",
        name: "Dropped",
        kind: "discussion",
      }),
      headers: { "content-type": "application/json", cookie, Origin: "http://127.0.0.1:5173" },
    });
    assertEquals(dropped.status, 409);

    // Disabled-but-connected sources still discover and subscribe.
    const disableResponse = await app.request(`/sources/${xSource.id}`, {
      ...jsonRequest("PATCH", { enabled: false }),
      headers: { "content-type": "application/json", cookie, Origin: "http://127.0.0.1:5173" },
    });
    assertEquals(disableResponse.status, 200);
    assertEquals((await disableResponse.json()).enabled, false);
    const disabledSubscribe = await app.request(`/sources/${xSource.id}/feeds`, {
      ...jsonRequest("POST", {
        externalId: "x:list:777",
        name: "Spoofed",
        kind: "discussion",
      }),
      headers: { "content-type": "application/json", cookie, Origin: "http://127.0.0.1:5173" },
    });
    assertEquals(disabledSubscribe.status, 201);
    const disabledFeed = await disabledSubscribe.json() as PublicFeed;
    assertEquals(disabledFeed.name, "New List");
    assertEquals(disabledFeed.kind, "news");
  });
});
