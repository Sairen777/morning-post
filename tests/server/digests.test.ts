import { test } from "bun:test";
import { assertEquals } from "../assertions.ts";
import { sql } from "drizzle-orm";
import type { Hono } from "hono";
import { ConnectorId } from "../../src/constants.ts";
import {
  CredentialCipher,
  type EncryptedBlob,
} from "../../src/crypto/credential-cipher.ts";
import { EnvMasterKeyProvider } from "../../src/crypto/key-provider.ts";
import type { Database } from "../../src/db/client.ts";
import { withTestDb } from "../../src/db/testing.ts";
import type { NormalizedItem } from "../../src/connectors/connector.types.ts";
import {
  createOrReviveFeed,
  softDeleteFeed,
} from "../../src/repositories/feed-repository.ts";
import { upsertItems } from "../../src/repositories/item-repository.ts";
import { createSource } from "../../src/repositories/source-repository.ts";
import { buildApp } from "../../src/server/app.ts";
import type { ServerEnvironment } from "../../src/server/app.ts";
import { assembleDigestForPeriod } from "../../src/services/digest-service.ts";
import {
  findDigestForUserPeriod,
  setDigestStatus,
} from "../../src/repositories/digest-repository.ts";
import type {
  SummarizeOptions,
  SummarizerService,
  SummaryPoint,
  SummaryRuleset,
} from "../../src/summarizers/summarizer.types.ts";
import {
  createDigestRun,
  finishDigestRun,
  finishDigestRunFeed,
  startDigestRunFeed,
} from "../../src/repositories/digest-run-repository.ts";
import type { runForUser as runForUserType } from "../../src/services/orchestrator.ts";
import type { DigestProgressReporter } from "../../src/services/digest-progress.ts";
import { fixtureStoryIntelligence } from "../services/fixture-story-intelligence.ts";

const PASSWORD = "analytical-engine-1843";
const periodStartMs = 1_700_000_000_000;
const periodEndMs = 1_700_086_400_000;

class FakeSummarizer implements SummarizerService {
  #results: Array<SummaryPoint[] | Error>;

  constructor(results: Array<SummaryPoint[] | Error>) {
    this.#results = [...results];
  }

  summarize(
    _items: NormalizedItem[],
    _rules: SummaryRuleset,
    _options?: SummarizeOptions,
  ): Promise<SummaryPoint[]> {
    const result = this.#results.shift() ?? [];
    if (result instanceof Error) {
      return Promise.reject(result);
    }
    return Promise.resolve(result);
  }
}

function credentialCipher(): CredentialCipher {
  return new CredentialCipher(
    new EnvMasterKeyProvider(new Uint8Array(32).fill(53)),
  );
}

async function encryptedCredentials(
  userId: string,
  connectorId: ConnectorId,
): Promise<EncryptedBlob> {
  return await credentialCipher().encrypt(
    JSON.stringify({ sessionString: `${connectorId}-session` }),
    {
      userId,
      connectorId,
    },
  );
}

function jsonRequest(method: "POST", body: unknown): RequestInit {
  return {
    method,
    headers: {
      "content-type": "application/json",
      Origin: "http://127.0.0.1:5173",
    },
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

async function register(
  app: Hono<ServerEnvironment>,
  email: string,
): Promise<string> {
  const response = await app.request(
    "/auth/register",
    jsonRequest("POST", {
      name: "Ada Lovelace",
      email,
      password: PASSWORD,
    }),
  );
  assertEquals(response.status, 201);
  const json = await response.json();
  return json.id;
}

async function login(
  app: Hono<ServerEnvironment>,
  email: string,
): Promise<string> {
  const response = await app.request(
    "/auth/login",
    jsonRequest("POST", { email, password: PASSWORD }),
  );
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

function normalizedItem(
  feedExternalId: string,
  externalId: string,
  text: string,
): NormalizedItem {
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

test("digest routes list and read user digests with grouped sections", async () => {
  await withTestDb(async (database) => {
    const app = buildApp(database);
    const ownerId = await register(app, "digests-owner@example.com");
    const ownerCookie = await login(app, "digests-owner@example.com");
    await register(app, "digests-other@example.com");
    const otherCookie = await login(app, "digests-other@example.com");

    const rssFeed = await createFeed(
      database,
      ownerId,
      ConnectorId.RSS,
      1,
      1,
      "rss:1",
      "RSS Feed",
    );
    const telegramFeed = await createFeed(
      database,
      ownerId,
      ConnectorId.Telegram,
      2,
      1,
      "channel:1",
      "Telegram Feed",
    );
    await upsertItems(database, rssFeed.id, [
      normalizedItem(rssFeed.externalId, "1", "rss"),
    ], 1);
    await upsertItems(database, telegramFeed.id, [
      normalizedItem(telegramFeed.externalId, "1", "telegram"),
    ], 1);

    const digest = await assembleDigestForPeriod(
      database,
      ownerId,
      periodStartMs,
      periodEndMs,
      {
        summarizer: new FakeSummarizer([
          [{ text: "rss bullet", sourceUrl: null }],
          [{ text: "telegram bullet", sourceUrl: null }],
        ]),
        intelligence: fixtureStoryIntelligence,
        now: () => 100,
      },
    );

    const listResponse = await app.request("/digests", {
      headers: { cookie: ownerCookie, Origin: "http://127.0.0.1:5173" },
    });
    assertEquals(listResponse.status, 200);
    assertEquals(
      (await listResponse.json()).data.map((entry: { id: string }) => entry.id),
      [digest.digest.id],
    );

    const getResponse = await app.request(`/digests/${digest.digest.id}`, {
      headers: { cookie: ownerCookie, Origin: "http://127.0.0.1:5173" },
    });
    assertEquals(getResponse.status, 200);
    const getJson = await getResponse.json();
    assertEquals(getJson.digest.contentMode, "stories");
    assertEquals(getJson.sections, []);
    assertEquals(getJson.groups, []);
    assertEquals(getJson.stories.length, 1);
    assertEquals(
      getJson.stories[0].sources.map((source: { feedName: string }) =>
        source.feedName
      ),
      ["RSS Feed", "Telegram Feed"],
    );

    const otherResponse = await app.request(`/digests/${digest.digest.id}`, {
      headers: { cookie: otherCookie, Origin: "http://127.0.0.1:5173" },
    });
    assertEquals(otherResponse.status, 404);
  });
});

test("DELETE /digests/:id deletes an owned digest", async () => {
  await withTestDb(async (database) => {
    const app = buildApp(database);
    const ownerId = await register(app, "digests-delete-owner@example.com");
    const ownerCookie = await login(app, "digests-delete-owner@example.com");
    const feed = await createFeed(
      database,
      ownerId,
      ConnectorId.Telegram,
      1,
      1,
      "channel:delete",
      "Delete Feed",
    );
    await upsertItems(database, feed.id, [
      normalizedItem(feed.externalId, "1", "delete me"),
    ], 1);

    const digest = await assembleDigestForPeriod(
      database,
      ownerId,
      periodStartMs,
      periodEndMs,
      {
        summarizer: new FakeSummarizer([[{
          text: "delete bullet",
          sourceUrl: null,
        }]]),
        intelligence: fixtureStoryIntelligence,
        now: () => 105,
      },
    );

    const deleteResponse = await app.request(`/digests/${digest.digest.id}`, {
      method: "DELETE",
      headers: { cookie: ownerCookie, Origin: "http://127.0.0.1:5173" },
    });
    assertEquals(deleteResponse.status, 200);
    const deleted = await deleteResponse.json();
    assertEquals(deleted.id, digest.digest.id);

    const readResponse = await app.request(`/digests/${digest.digest.id}`, {
      headers: { cookie: ownerCookie, Origin: "http://127.0.0.1:5173" },
    });
    assertEquals(readResponse.status, 404);

    const listResponse = await app.request("/digests", {
      headers: { cookie: ownerCookie, Origin: "http://127.0.0.1:5173" },
    });
    assertEquals(listResponse.status, 200);
    const listed = (await listResponse.json()).data;
    assertEquals(
      listed.map((entry: { id: string }) => entry.id).includes(
        digest.digest.id,
      ),
      false,
    );
    assertEquals(
      await findDigestForUserPeriod(
        database,
        ownerId,
        periodStartMs,
        periodEndMs,
      ),
      null,
    );
  });
});

test("DELETE /digests/:id hides another user's digest", async () => {
  await withTestDb(async (database) => {
    const app = buildApp(database);
    const ownerId = await register(
      app,
      "digests-delete-hidden-owner@example.com",
    );
    const ownerCookie = await login(
      app,
      "digests-delete-hidden-owner@example.com",
    );
    await register(app, "digests-delete-hidden-other@example.com");
    const otherCookie = await login(
      app,
      "digests-delete-hidden-other@example.com",
    );
    const feed = await createFeed(
      database,
      ownerId,
      ConnectorId.Telegram,
      1,
      1,
      "channel:hidden-delete",
      "Hidden Delete Feed",
    );
    await upsertItems(database, feed.id, [
      normalizedItem(feed.externalId, "1", "keep me"),
    ], 1);

    const digest = await assembleDigestForPeriod(
      database,
      ownerId,
      periodStartMs,
      periodEndMs,
      {
        summarizer: new FakeSummarizer([[{
          text: "kept bullet",
          sourceUrl: null,
        }]]),
        intelligence: fixtureStoryIntelligence,
        now: () => 106,
      },
    );

    const deleteResponse = await app.request(`/digests/${digest.digest.id}`, {
      method: "DELETE",
      headers: { cookie: otherCookie, Origin: "http://127.0.0.1:5173" },
    });
    assertEquals(deleteResponse.status, 404);
    const json = await deleteResponse.json();
    assertEquals(json.error.code, "NOT_FOUND");
    assertEquals(json.error.message, "digest not found");

    const ownerReadResponse = await app.request(
      `/digests/${digest.digest.id}`,
      {
        headers: { cookie: ownerCookie, Origin: "http://127.0.0.1:5173" },
      },
    );
    assertEquals(ownerReadResponse.status, 200);
  });
});

test("GET /digests/:id.md renders story Markdown after a source feed is deleted", async () => {
  await withTestDb(async (database) => {
    const app = buildApp(database);
    const ownerId = await register(app, "digests-markdown@example.com");
    const ownerCookie = await login(app, "digests-markdown@example.com");
    const feed = await createFeed(
      database,
      ownerId,
      ConnectorId.Telegram,
      1,
      1,
      "channel:1",
      "Markdown Feed",
    );
    await upsertItems(database, feed.id, [
      normalizedItem(feed.externalId, "1", "markdown"),
    ], 1);

    const digest = await assembleDigestForPeriod(
      database,
      ownerId,
      periodStartMs,
      periodEndMs,
      {
        summarizer: new FakeSummarizer([[{
          text: "markdown bullet",
          sourceUrl: null,
        }]]),
        intelligence: fixtureStoryIntelligence,
        now: () => 110,
      },
    );
    await softDeleteFeed(database, feed.id, ownerId);

    const markdownResponse = await app.request(
      `/digests/${digest.digest.id}.md`,
      { headers: { cookie: ownerCookie, Origin: "http://127.0.0.1:5173" } },
    );
    assertEquals(markdownResponse.status, 200);
    const markdown = await markdownResponse.text();
    assertEquals(markdown.includes("## Fixture Story"), true);
    assertEquals(markdown.includes("- markdown bullet"), true);
    assertEquals(markdown.includes("### Markdown Feed (removed)"), false);
  });
});
test("GET /digests/:id returns a redacted failure reason in JSON and escaped Markdown", async () => {
  await withTestDb(async (database) => {
    const app = buildApp(database);
    const ownerId = await register(app, "digest-failure-reason@example.com");
    const ownerCookie = await login(app, "digest-failure-reason@example.com");
    const digest = await assembleDigestForPeriod(
      database,
      ownerId,
      periodStartMs,
      periodEndMs,
      {
        summarizer: new FakeSummarizer([]),
        intelligence: fixtureStoryIntelligence,
        now: () => 110,
      },
    );
    await setDigestStatus(
      database,
      digest.digest.id,
      ownerId,
      "failed",
    );
    const run = await createDigestRun(database, {
      userId: ownerId,
      trigger: "manual",
      periodStartMs,
      periodEndMs,
      status: "running",
    }, 120);
    await finishDigestRun(database, run.id, {
      digestId: digest.digest.id,
      status: "failed",
      errorMessage: "Bearer server-secret\n# injected <script>",
    }, 121);

    const jsonResponse = await app.request(`/digests/${digest.digest.id}`, {
      headers: { cookie: ownerCookie, Origin: "http://127.0.0.1:5173" },
    });
    assertEquals(jsonResponse.status, 200);
    const json = await jsonResponse.json() as { failureReason: string | null };
    assertEquals(
      json.failureReason,
      "Bearer [REDACTED]\n# injected <script>",
    );
    assertEquals(JSON.stringify(json).includes("server-secret"), false);

    const markdownResponse = await app.request(
      `/digests/${digest.digest.id}.md`,
      {
        headers: {
          cookie: ownerCookie,
          Origin: "http://127.0.0.1:5173",
        },
      },
    );
    assertEquals(markdownResponse.status, 200);
    const markdown = await markdownResponse.text();
    assertEquals(
      markdown.includes(
        "Failure reason: Bearer \\[REDACTED\\] \\# injected &lt;script&gt;",
      ),
      true,
    );
    assertEquals(markdown.includes("server-secret"), false);
    assertEquals(markdown.includes("\n# injected"), false);
    assertEquals(markdown.includes("<script>"), false);
  });
});

test("POST /digests/run creates an empty digest for an authenticated user with no sources", async () => {
  await withTestDb(async (database) => {
    const app = buildApp(database);
    const userId = await register(app, "digests-run-empty@example.com");
    const cookie = await login(app, "digests-run-empty@example.com");

    const response = await app.request("/digests/run", {
      ...jsonRequest("POST", {
        periodStartMs: 1700000000000,
        periodEndMs: 1700086400000,
      }),
      headers: { cookie, Origin: "http://127.0.0.1:5173" },
    });
    assertEquals(response.status, 200);
    const json = await response.json();
    assertEquals(json.digest.status, "complete");
    assertEquals(json.digest.contentMode, "stories");
    assertEquals(json.stories, []);
    assertEquals(json.sections, []);
    assertEquals(json.groups, []);

    const dbDigest = await findDigestForUserPeriod(
      database,
      userId,
      1700000000000,
      1700086400000,
    );
    assertEquals(dbDigest !== null, true);
    assertEquals(dbDigest!.id, json.digest.id);
  });
});

test("POST /digests/run requires authentication", async () => {
  await withTestDb(async (database) => {
    const app = buildApp(database);

    const response = await app.request(
      "/digests/run",
      jsonRequest("POST", {
        periodStartMs: 1700000000000,
        periodEndMs: 1700086400000,
      }),
    );
    assertEquals(response.status, 401);
    const json = await response.json();
    assertEquals(json.error.code, "UNAUTHORIZED");
  });
});

test("POST /digests/run rejects incomplete period input", async () => {
  await withTestDb(async (database) => {
    const app = buildApp(database);
    await register(app, "digests-run-incomplete@example.com");
    const cookie = await login(app, "digests-run-incomplete@example.com");

    const response = await app.request("/digests/run", {
      ...jsonRequest("POST", { periodStartMs: 1700000000000 }),
      headers: { cookie, Origin: "http://127.0.0.1:5173" },
    });
    assertEquals(response.status, 422);
  });
});

test("POST /digests/run rejects inverted periods", async () => {
  await withTestDb(async (database) => {
    const app = buildApp(database);
    await register(app, "digests-run-inverted@example.com");
    const cookie = await login(app, "digests-run-inverted@example.com");

    const response = await app.request("/digests/run", {
      ...jsonRequest("POST", {
        periodStartMs: 1700086400000,
        periodEndMs: 1700000000000,
      }),
      headers: { cookie, Origin: "http://127.0.0.1:5173" },
    });
    assertEquals(response.status, 422);
  });
});

test("POST /digests/run rate-limits repeated runs", async () => {
  await withTestDb(async (database) => {
    const app = buildApp(database);
    await register(app, "digests-run-ratelimit@example.com");
    const cookie = await login(app, "digests-run-ratelimit@example.com");
    const body = { periodStartMs: 1700000000000, periodEndMs: 1700086400000 };

    const responses: number[] = [];
    for (let i = 0; i < 4; i++) {
      const response = await app.request("/digests/run", {
        ...jsonRequest("POST", body),
        headers: { cookie, Origin: "http://127.0.0.1:5173" },
      });
      responses.push(response.status);
    }
    assertEquals(responses[0], 200);
    assertEquals(responses[1], 200);
    assertEquals(responses[2], 200);
    assertEquals(responses[3], 429);
    const rateLimitResponse = await app.request("/digests/run", {
      ...jsonRequest("POST", body),
      headers: { cookie, Origin: "http://127.0.0.1:5173" },
    });
    const json = await rateLimitResponse.json();
    assertEquals(json.error.code, "RATE_LIMITED");
  });
});

test("POST /digests/run creates a manual digest run record", async () => {
  await withTestDb(async (database) => {
    const app = buildApp(database);
    const userId = await register(app, "digests-run-record@example.com");
    const cookie = await login(app, "digests-run-record@example.com");

    const response = await app.request("/digests/run", {
      ...jsonRequest("POST", {
        periodStartMs: 1700000000000,
        periodEndMs: 1700086400000,
      }),
      headers: { cookie, Origin: "http://127.0.0.1:5173" },
    });
    assertEquals(response.status, 200);
    const json = await response.json();
    assertEquals(json.digest.status, "complete");

    const rows = await database.execute(
      sql`select trigger from digest_runs where user_id = ${userId} order by started_at desc limit 1`,
    );
    assertEquals(rows.length, 1);
    assertEquals(rows[0].trigger, "manual");
  });
});

test("POST /digests/run conflict preserves the active run for recovery", async () => {
  await withTestDb(async (database) => {
    const app = buildApp(database);
    const userId = await register(
      app,
      "digests-run-active-conflict@example.com",
    );
    const cookie = await login(app, "digests-run-active-conflict@example.com");
    const activeRun = await createDigestRun(database, {
      userId,
      trigger: "manual",
      periodStartMs,
      periodEndMs,
      status: "running",
    });

    const rollbackConflictAttempt = new Error("rollback conflict attempt");
    try {
      await database.transaction(async (transaction) => {
        const conflictApp = buildApp(transaction as Database);
        const runResponse = await conflictApp.request("/digests/run", {
          ...jsonRequest("POST", { periodStartMs, periodEndMs }),
          headers: { cookie, Origin: "http://127.0.0.1:5173" },
        });
        assertEquals(runResponse.status, 409);
        throw rollbackConflictAttempt;
      });
    } catch (error) {
      if (error !== rollbackConflictAttempt) {
        throw error;
      }
    }

    const runsResponse = await app.request("/digests/runs", {
      headers: { cookie, Origin: "http://127.0.0.1:5173" },
    });
    assertEquals(runsResponse.status, 200);
    const runsJson = await runsResponse.json();
    assertEquals(runsJson.data.length, 1);
    assertEquals(runsJson.data[0].id, activeRun.id);
    assertEquals(runsJson.data[0].status, "running");

    const rows = await database.execute(
      sql`select id from digest_runs where user_id = ${userId}`,
    );
    assertEquals(rows.length, 1);
    assertEquals(rows[0].id, activeRun.id);
  });
});

test("GET /digests/runs requires authentication", async () => {
  await withTestDb(async (database) => {
    const app = buildApp(database);

    const response = await app.request("/digests/runs");
    assertEquals(response.status, 401);
    const json = await response.json();
    assertEquals(json.error.code, "UNAUTHORIZED");
  });
});

test("GET /digests/runs returns only caller run records latest first", async () => {
  await withTestDb(async (database) => {
    const app = buildApp(database);

    const user1 = await register(app, "digests-runs-owner@example.com");
    const user1Cookie = await login(app, "digests-runs-owner@example.com");
    await register(app, "digests-runs-other@example.com");

    const now = Date.now();

    const run1 = await createDigestRun(database, {
      userId: user1,
      trigger: "manual",
      periodStartMs: 1000,
      periodEndMs: 2000,
      status: "complete",
    }, now - 2000);
    await finishDigestRun(
      database,
      run1.id,
      { status: "complete" },
      now - 1000,
    );

    const run2 = await createDigestRun(database, {
      userId: user1,
      trigger: "scheduled",
      periodStartMs: 3000,
      periodEndMs: 4000,
      status: "complete",
    }, now);
    await finishDigestRun(
      database,
      run2.id,
      { status: "complete" },
      now + 1000,
    );

    const user2 = await register(app, "digests-runs-other2@example.com");
    const run3 = await createDigestRun(database, {
      userId: user2,
      trigger: "manual",
      periodStartMs: 5000,
      periodEndMs: 6000,
      status: "complete",
    }, now - 500);
    await finishDigestRun(database, run3.id, { status: "complete" }, now);

    const response = await app.request("/digests/runs", {
      headers: { cookie: user1Cookie, Origin: "http://127.0.0.1:5173" },
    });
    assertEquals(response.status, 200);
    const json = await response.json();
    assertEquals(json.data.length, 2);
    assertEquals(json.data[0].id, run2.id);
    assertEquals(json.data[0].userId, user1);
    assertEquals(json.data[1].id, run1.id);
    assertEquals(json.data[1].userId, user1);
  });
});

test("GET /digests/runs/:id returns owned run with feed stages", async () => {
  await withTestDb(async (database) => {
    const app = buildApp(database);
    const userId = await register(app, "digests-run-detail@example.com");
    const cookie = await login(app, "digests-run-detail@example.com");

    const now = Date.now();
    const run = await createDigestRun(database, {
      userId,
      trigger: "manual",
      periodStartMs: 1000,
      periodEndMs: 2000,
      status: "running",
    }, now);

    const connectorFeed = await startDigestRunFeed(database, {
      runId: run.id,
      connectorId: "Telegram",
      stage: "connector",
      status: "running",
    }, now);
    await finishDigestRunFeed(database, connectorFeed.id, {
      status: "complete",
      itemCount: 5,
    }, now + 100);

    const ingestionFeed = await startDigestRunFeed(database, {
      runId: run.id,
      connectorId: "Telegram",
      feedExternalId: "channel:1",
      feedName: "Test Channel",
      stage: "ingestion",
      status: "running",
    }, now + 200);
    await finishDigestRunFeed(database, ingestionFeed.id, {
      status: "complete",
      itemCount: 3,
    }, now + 300);

    const summarizationFeed = await startDigestRunFeed(database, {
      runId: run.id,
      connectorId: "Telegram",
      stage: "summarization",
      status: "running",
    }, now + 400);
    await finishDigestRunFeed(database, summarizationFeed.id, {
      status: "complete",
      itemCount: 0,
    }, now + 500);

    const response = await app.request(`/digests/runs/${run.id}`, {
      headers: { cookie, Origin: "http://127.0.0.1:5173" },
    });
    assertEquals(response.status, 200);
    const json = await response.json();

    assertEquals(json.run.id, run.id);
    assertEquals(json.run.userId, userId);
    assertEquals(json.run.trigger, "manual");
    assertEquals(json.run.status, "running");
    assertEquals(json.feeds.length, 3);

    assertEquals(json.feeds[0].stage, "connector");
    assertEquals(json.feeds[0].itemCount, 5);
    assertEquals(json.feeds[1].stage, "ingestion");
    assertEquals(json.feeds[1].feedName, "Test Channel");
    assertEquals(json.feeds[1].itemCount, 3);
    assertEquals(json.feeds[2].stage, "summarization");
    assertEquals(json.feeds[2].itemCount, 0);
  });
});

test("GET /digests/runs/:id hides another user's run", async () => {
  await withTestDb(async (database) => {
    const app = buildApp(database);

    const user1 = await register(app, "digests-run-hidden-owner@example.com");
    const user1Cookie = await login(
      app,
      "digests-run-hidden-owner@example.com",
    );
    const _user2 = await register(app, "digests-run-hidden-other@example.com");
    const user2Cookie = await login(
      app,
      "digests-run-hidden-other@example.com",
    );

    const now = Date.now();
    const run = await createDigestRun(database, {
      userId: user1,
      trigger: "manual",
      periodStartMs: 1000,
      periodEndMs: 2000,
      status: "complete",
    }, now);
    await finishDigestRun(database, run.id, { status: "complete" }, now);

    const response = await app.request(`/digests/runs/${run.id}`, {
      headers: { cookie: user2Cookie, Origin: "http://127.0.0.1:5173" },
    });
    assertEquals(response.status, 404);
    const json = await response.json();
    assertEquals(json.error.code, "NOT_FOUND");
    assertEquals(json.error.message, "digest run not found");

    const ownResponse = await app.request(`/digests/runs/${run.id}`, {
      headers: { cookie: user1Cookie, Origin: "http://127.0.0.1:5173" },
    });
    assertEquals(ownResponse.status, 200);
  });
});

test("POST /digests/run forwards entrypoint digest dependencies", async () => {
  await withTestDb(async (database) => {
    const sharedSummarizer = new FakeSummarizer([]);
    const progressReporter = { report: () => {} } satisfies DigestProgressReporter;
    let receivedSummarizer: SummarizerService | undefined;
    let receivedTimeoutMs: number | undefined;
    let receivedProgressReporter: DigestProgressReporter | undefined;
    const runForUser: typeof runForUserType = (
      _database,
      userId,
      period,
      dependencies = {},
    ) => {
      receivedSummarizer = dependencies.summarizer;
      receivedTimeoutMs = dependencies.timeoutMs;
      receivedProgressReporter = dependencies.progressReporter;
      return Promise.resolve({
        digest: {
          id: crypto.randomUUID(),
          userId,
          periodStartMs: period.startMs,
          periodEndMs: period.endMs,
          status: "complete" as const,
          contentMode: "stories" as const,
          createdAt: 1,
          updatedAt: 1,
        },
        stories: [],
        sections: [],
        groups: [],
        paidPosts: [],
        failureReason: null,
      });
    };
    const app = buildApp(database, {
      digests: {
        summarizer: sharedSummarizer,
        timeoutMs: 42_000,
        progressReporter,
        runForUser,
      },
    });
    const cookie = await login(app, "digests-run-injection@example.com").catch(
      async () => {
        await register(app, "digests-run-injection@example.com");
        return await login(app, "digests-run-injection@example.com");
      },
    );

    const response = await app.request("/digests/run", {
      ...jsonRequest("POST", { periodStartMs, periodEndMs }),
      headers: { cookie, Origin: "http://127.0.0.1:5173" },
    });
    assertEquals(response.status, 200);
    assertEquals(receivedSummarizer, sharedSummarizer);
    assertEquals(receivedTimeoutMs, 42_000);
    assertEquals(receivedProgressReporter, progressReporter);
  });
});
