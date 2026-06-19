import { assertEquals } from "@std/assert";
import type { Hono } from "@hono/hono";
import { ConnectorId } from "../../src/constants.ts";
import { CredentialCipher, type EncryptedBlob } from "../../src/crypto/credential-cipher.ts";
import { EnvMasterKeyProvider } from "../../src/crypto/key-provider.ts";
import type { Database } from "../../src/db/client.ts";
import { withTestDb } from "../../src/db/testing.ts";
import type { NormalizedItem } from "../../src/connectors/connector.types.ts";
import { createOrReviveFeed, softDeleteFeed } from "../../src/repositories/feed-repository.ts";
import { upsertItems } from "../../src/repositories/item-repository.ts";
import { createSource } from "../../src/repositories/source-repository.ts";
import { buildApp } from "../../src/server/app.ts";
import { assembleDigestForPeriod } from "../../src/services/digest-service.ts";
import type { SummarizeOptions, SummarizerService, SummaryPoint, SummaryRuleset } from "../../src/summarizers/summarizer.types.ts";

const PASSWORD = "analytical-engine-1843";
const periodStartMs = 1_700_000_000_000;
const periodEndMs = 1_700_086_400_000;

class FakeSummarizer implements SummarizerService {
  #results: Array<SummaryPoint[] | Error>;

  constructor(results: Array<SummaryPoint[] | Error>) {
    this.#results = [...results];
  }

  summarize(_items: NormalizedItem[], _rules: SummaryRuleset, _options?: SummarizeOptions): Promise<SummaryPoint[]> {
    const result = this.#results.shift() ?? [];
    if (result instanceof Error) {
      return Promise.reject(result);
    }
    return Promise.resolve(result);
  }
}

function credentialCipher(): CredentialCipher {
  return new CredentialCipher(new EnvMasterKeyProvider(new Uint8Array(32).fill(53)));
}

async function encryptedCredentials(userId: string, connectorId: ConnectorId): Promise<EncryptedBlob> {
  return await credentialCipher().encrypt(JSON.stringify({ sessionString: `${connectorId}-session` }), {
    userId,
    connectorId,
  });
}

function jsonRequest(method: "POST", body: unknown): RequestInit {
  return {
    method,
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  };
}

function extractCookie(response: Response): string {
  const header = response.headers.get("set-cookie");
  if (header === null) {
    throw new Error("login did not set a session cookie");
  }
  return header.split(";")[0];
}

async function register(app: Hono, email: string): Promise<string> {
  const response = await app.request("/auth/register", jsonRequest("POST", {
    name: "Ada Lovelace",
    email,
    password: PASSWORD,
  }));
  assertEquals(response.status, 201);
  const json = await response.json();
  return json.id;
}

async function login(app: Hono, email: string): Promise<string> {
  const response = await app.request("/auth/login", jsonRequest("POST", { email, password: PASSWORD }));
  assertEquals(response.status, 200);
  return extractCookie(response);
}

async function createFeed(
  database: Database,
  userId: string,
  connectorId: ConnectorId,
  sourcePosition: number,
  feedPosition: number,
  externalId: string,
  name: string,
) {
  const source = await createSource(database, {
    userId,
    connectorId,
    credentials: await encryptedCredentials(userId, connectorId),
    position: sourcePosition,
  });
  return await createOrReviveFeed(database, {
    userId,
    sourceId: source.id,
    externalId,
    name,
    kind: "news",
    position: feedPosition,
  });
}

function normalizedItem(feedExternalId: string, externalId: string, text: string): NormalizedItem {
  return {
    connectorId: ConnectorId.Telegram,
    feedExternalId,
    externalId,
    date: 1_700_000_000_000,
    title: null,
    text,
    author: "Channel",
    url: null,
  };
}

Deno.test("digest routes list and read user digests with grouped sections", async () => {
  await withTestDb(async (database) => {
    const app = buildApp(database);
    const ownerId = await register(app, "digests-owner@example.com");
    const ownerCookie = await login(app, "digests-owner@example.com");
    await register(app, "digests-other@example.com");
    const otherCookie = await login(app, "digests-other@example.com");

    const rssFeed = await createFeed(database, ownerId, ConnectorId.RSS, 1, 1, "rss:1", "RSS Feed");
    const telegramFeed = await createFeed(database, ownerId, ConnectorId.Telegram, 2, 1, "channel:1", "Telegram Feed");
    await upsertItems(database, rssFeed.id, [normalizedItem(rssFeed.externalId, "1", "rss")], 1);
    await upsertItems(database, telegramFeed.id, [normalizedItem(telegramFeed.externalId, "1", "telegram")], 1);

    const digest = await assembleDigestForPeriod(database, ownerId, periodStartMs, periodEndMs, {
      summarizer: new FakeSummarizer([
        [{ text: "rss bullet", sourceUrl: null }],
        [{ text: "telegram bullet", sourceUrl: null }],
      ]),
      now: () => 100,
    });

    const listResponse = await app.request("/digests", { headers: { cookie: ownerCookie } });
    assertEquals(listResponse.status, 200);
    assertEquals((await listResponse.json()).map((entry: { id: string }) => entry.id), [digest.digest.id]);

    const getResponse = await app.request(`/digests/${digest.digest.id}`, { headers: { cookie: ownerCookie } });
    assertEquals(getResponse.status, 200);
    const getJson = await getResponse.json();
    assertEquals(getJson.sections.map((section: { feedName: string }) => section.feedName), ["RSS Feed", "Telegram Feed"]);
    assertEquals(getJson.groups.map((group: { connectorId: string }) => group.connectorId), [ConnectorId.RSS, ConnectorId.Telegram]);

    const otherResponse = await app.request(`/digests/${digest.digest.id}`, { headers: { cookie: otherCookie } });
    assertEquals(otherResponse.status, 404);
  });
});

Deno.test("GET /digests/:id.md renders markdown for deleted historical feeds", async () => {
  await withTestDb(async (database) => {
    const app = buildApp(database);
    const ownerId = await register(app, "digests-markdown@example.com");
    const ownerCookie = await login(app, "digests-markdown@example.com");
    const feed = await createFeed(database, ownerId, ConnectorId.Telegram, 1, 1, "channel:1", "Markdown Feed");
    await upsertItems(database, feed.id, [normalizedItem(feed.externalId, "1", "markdown")], 1);

    const digest = await assembleDigestForPeriod(database, ownerId, periodStartMs, periodEndMs, {
      summarizer: new FakeSummarizer([[{ text: "markdown bullet", sourceUrl: null }]]),
      now: () => 110,
    });
    await softDeleteFeed(database, feed.id, ownerId);

    const markdownResponse = await app.request(`/digests/${digest.digest.id}.md`, { headers: { cookie: ownerCookie } });
    assertEquals(markdownResponse.status, 200);
    const markdown = await markdownResponse.text();
    assertEquals(markdown.includes("## Telegram"), true);
    assertEquals(markdown.includes("### Markdown Feed (removed)"), true);
    assertEquals(markdown.includes("- markdown bullet"), true);
  });
});
