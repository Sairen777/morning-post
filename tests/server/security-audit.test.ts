import { assertEquals } from "@std/assert";
import type { Hono } from "@hono/hono";
import { ConnectorId } from "../../src/constants.ts";
import { CredentialCipher, type EncryptedBlob } from "../../src/crypto/credential-cipher.ts";
import { EnvMasterKeyProvider } from "../../src/crypto/key-provider.ts";
import type { Database } from "../../src/db/client.ts";
import { withTestDb } from "../../src/db/testing.ts";
import type { NormalizedItem } from "../../src/connectors/connector.types.ts";
import { createOrReviveFeed } from "../../src/repositories/feed-repository.ts";
import { upsertItems } from "../../src/repositories/item-repository.ts";
import { createSource } from "../../src/repositories/source-repository.ts";
import { createUser, type CreateUserInput } from "../../src/repositories/user-repository.ts";
import { buildApp } from "../../src/server/app.ts";
import { assembleDigestForPeriod } from "../../src/services/digest-service.ts";
import { getOrSummarizeFeedPeriod } from "../../src/services/summarization-service.ts";
import type { SummarizeOptions, SummarizerService, SummaryPoint, SummaryRuleset } from "../../src/summarizers/summarizer.types.ts";

const PASSWORD = "analytical-engine-1843";
const MASTER_KEY_BYTES = new Uint8Array(32).fill(67);
const periodStartMs = 1_700_000_000_000;
const periodEndMs = 1_700_086_400_000;
const SESSION_STRING = "audit-session-secret";

class FakeSummarizer implements SummarizerService {
  summarize(_items: NormalizedItem[], _rules: SummaryRuleset, _options?: SummarizeOptions): Promise<SummaryPoint[]> {
    return Promise.resolve([{ text: "secure point", sourceUrl: null }]);
  }
}

function userInput(email: string): CreateUserInput {
  return {
    name: "Security Owner",
    email,
    passwordHash: "$argon2id$fakehash",
    systemPrompt: "Summarize tersely.",
    defaultLanguage: "en",
    defaultModel: "gpt-4o-mini",
  };
}

function credentialCipher(): CredentialCipher {
  return new CredentialCipher(new EnvMasterKeyProvider(MASTER_KEY_BYTES));
}

async function encryptedCredentials(userId: string, connectorId: ConnectorId): Promise<EncryptedBlob> {
  return await credentialCipher().encrypt(JSON.stringify({ sessionString: SESSION_STRING }), {
    userId,
    connectorId,
  });
}

function jsonRequest(method: "POST" | "PATCH", body: unknown): RequestInit {
  return {
    method,
    headers: { "content-type": "application/json", Origin: "http://127.0.0.1:5173" },
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
  const response = await app.request(
    "/auth/register",
    jsonRequest("POST", { name: "Ada Lovelace", email, password: PASSWORD }),
  );
  assertEquals(response.status, 201);
  const json = await response.json();
  return json.id;
}

async function login(app: Hono, email: string): Promise<string> {
  const response = await app.request(
    "/auth/login",
    jsonRequest("POST", { email, password: PASSWORD }),
  );
  assertEquals(response.status, 200);
  return extractCookie(response);
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

Deno.test("security audit enforces authz and does not leak secrets in GET responses or logs", async () => {
  await withTestDb(async (database: Database) => {
    const app = buildApp(database);
    const ownerId = await register(app, "security-owner@example.com");
    const ownerCookie = await login(app, "security-owner@example.com");
    const otherId = await register(app, "security-other@example.com");
    const otherCookie = await login(app, "security-other@example.com");

    const source = await createSource(database, {
      userId: ownerId,
      connectorId: ConnectorId.Telegram,
      credentials: await encryptedCredentials(ownerId, ConnectorId.Telegram),
      position: 1,
    });
    const feed = await createOrReviveFeed(database, {
      userId: ownerId,
      sourceId: source.id,
      externalId: "channel:1",
      name: "Secure Feed",
      kind: "news",
    });
    await upsertItems(database, feed.id, [normalizedItem(feed.externalId, "1", "secure")], 1);
    const digest = await assembleDigestForPeriod(database, ownerId, periodStartMs, periodEndMs, {
      summarizer: new FakeSummarizer(),
      now: () => 300,
    });

    const originalConsoleError = console.error;
    const capturedLogs: string[] = [];
    console.error = (...args: unknown[]) => {
      capturedLogs.push(args.map(String).join(" "));
    };
    try {
      const unauthorizedFeedResponse = await app.request(`/feeds/${feed.id}`, { headers: { cookie: otherCookie, Origin: "http://127.0.0.1:5173" } });
      assertEquals(unauthorizedFeedResponse.status, 404);

      const unauthorizedDigestResponse = await app.request(`/digests/${digest.digest.id}`, { headers: { cookie: otherCookie, Origin: "http://127.0.0.1:5173" } });
      assertEquals(unauthorizedDigestResponse.status, 404);

      const unauthorizedMarkdownResponse = await app.request(`/digests/${digest.digest.id}.md`, { headers: { cookie: otherCookie, Origin: "http://127.0.0.1:5173" } });
      assertEquals(unauthorizedMarkdownResponse.status, 404);

      await createUser(database, userInput("security-third@example.com"));
      const summaryAccessError = await getOrSummarizeFeedPeriod(database, otherId, feed.id, periodStartMs, periodEndMs)
        .then(() => null)
        .catch((error) => error as Error);
      assertEquals(summaryAccessError?.message, "feed not found");

      const responses = await Promise.all([
        app.request("/auth/me", { headers: { cookie: ownerCookie, Origin: "http://127.0.0.1:5173" } }),
        app.request("/sources", { headers: { cookie: ownerCookie, Origin: "http://127.0.0.1:5173" } }),
        app.request("/feeds", { headers: { cookie: ownerCookie, Origin: "http://127.0.0.1:5173" } }),
        app.request("/digests", { headers: { cookie: ownerCookie, Origin: "http://127.0.0.1:5173" } }),
        app.request(`/digests/${digest.digest.id}`, { headers: { cookie: ownerCookie, Origin: "http://127.0.0.1:5173" } }),
      ]);
      const texts = await Promise.all(responses.map((response) => response.text()));
      const secretNeedles = [SESSION_STRING, "passwordHash", "wrappedDataKey", "ciphertext", ownerCookie.split("=")[1]];
      for (const text of texts) {
        for (const secretNeedle of secretNeedles) {
          assertEquals(text.includes(secretNeedle), false);
        }
      }
      for (const logLine of capturedLogs) {
        for (const secretNeedle of secretNeedles) {
          assertEquals(logLine.includes(secretNeedle), false);
        }
      }
    } finally {
      console.error = originalConsoleError;
    }
  });
});
