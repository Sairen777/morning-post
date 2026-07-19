import { assert, assertEquals, assertRejects } from "@std/assert";
import type {
  ConnectorFactoryLike,
  ConnectorHandle,
} from "../../src/connectors/connector-factory.ts";
import { ConflictError } from "../../src/server/errors.ts";
import { ConnectorId } from "../../src/constants.ts";
import {
  CredentialCipher,
  type EncryptedBlob,
} from "../../src/crypto/credential-cipher.ts";
import { EnvMasterKeyProvider } from "../../src/crypto/key-provider.ts";
import type { Database } from "../../src/db/client.ts";
import { withTestDb } from "../../src/db/testing.ts";
import type {
  Connector,
  NormalizedData,
  NormalizedItem,
} from "../../src/connectors/connector.types.ts";
import { createOrReviveFeed } from "../../src/repositories/feed-repository.ts";
import { listItemsForFeedInWindow } from "../../src/repositories/item-repository.ts";
import {
  createSource,
  type PublicSource,
} from "../../src/repositories/source-repository.ts";
import { runForUser } from "../../src/services/orchestrator.ts";
import {
  createUser,
  type CreateUserInput,
} from "../../src/repositories/user-repository.ts";
import type {
  SummarizeOptions,
  SummarizerService,
  SummaryPoint,
  SummaryRuleset,
} from "../../src/summarizers/summarizer.types.ts";
import { findDigestForUserPeriod } from "../../src/repositories/digest-repository.ts";
import { findSummaryForFeedPeriod } from "../../src/repositories/summary-repository.ts";
import { sql } from "drizzle-orm";
import { listDigestRunsForUser } from "../../src/repositories/digest-run-repository.ts";

class FakeConnector implements Connector<unknown> {
  readonly calls: Array<
    { from: number; to: number; feedExternalIds?: string[] }
  > = [];

  constructor(
    readonly responses: Record<string, NormalizedItem[]>,
    readonly failingFeedExternalIds: Set<string> = new Set(),
  ) {}

  getRawData(): Promise<unknown> {
    return Promise.resolve({});
  }

  getNormalizedData(
    from: number,
    to: number,
    feedExternalIds?: string[],
  ): Promise<NormalizedData> {
    this.calls.push({ from, to, feedExternalIds });
    const selectedFeedExternalId = feedExternalIds?.[0];
    if (
      selectedFeedExternalId &&
      this.failingFeedExternalIds.has(selectedFeedExternalId)
    ) {
      return Promise.reject(new Error(`failed feed ${selectedFeedExternalId}`));
    }
    if (!selectedFeedExternalId) {
      return Promise.resolve(this.responses);
    }
    return Promise.resolve(
      selectedFeedExternalId in this.responses
        ? { [selectedFeedExternalId]: this.responses[selectedFeedExternalId] }
        : {},
    );
  }
}

class FakeSummarizer implements SummarizerService {
  readonly calls: Array<
    {
      items: NormalizedItem[];
      rules: SummaryRuleset;
      options?: SummarizeOptions;
    }
  > = [];
  #results: Array<SummaryPoint[] | Error>;

  constructor(results: Array<SummaryPoint[] | Error>) {
    this.#results = [...results];
  }

  summarize(
    items: NormalizedItem[],
    rules: SummaryRuleset,
    options?: SummarizeOptions,
  ): Promise<SummaryPoint[]> {
    this.calls.push({ items, rules, options });
    const result = this.#results.shift() ?? [];
    if (result instanceof Error) {
      return Promise.reject(result);
    }
    return Promise.resolve(result);
  }
}

class FakeConnectorFactory implements ConnectorFactoryLike {
  readonly disposeCalls: string[] = [];
  readonly forSourceCalls: string[] = [];

  constructor(
    readonly connectorsBySourceId: Record<string, FakeConnector>,
    readonly failingSourceIds: Set<string> = new Set(),
    readonly ingestionModesBySourceId: Record<string, "batch" | "individual"> =
      {},
  ) {}

  forSource(
    source: PublicSource,
    _userId: string,
  ): Promise<ConnectorHandle<unknown>> {
    this.forSourceCalls.push(source.id);
    if (this.failingSourceIds.has(source.id)) {
      throw new ConflictError("source is disconnected");
    }
    const connector = this.connectorsBySourceId[source.id];
    if (!connector) {
      throw new Error(`missing connector for source ${source.id}`);
    }
    return Promise.resolve({
      connector,
      ingestionMode: this.ingestionModesBySourceId[source.id] ?? "batch",
      dispose: () => {
        this.disposeCalls.push(source.id);
      },
    });
  }
}

function userInput(email: string): CreateUserInput {
  return {
    name: "Orchestrator Owner",
    email,
    passwordHash: "$argon2id$fakehash",
    systemPrompt: "Summarize tersely.",
    defaultLanguage: "en",
  };
}

function credentialCipher(): CredentialCipher {
  return new CredentialCipher(
    new EnvMasterKeyProvider(new Uint8Array(32).fill(59)),
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

async function createSourceAndFeed(
  database: Database,
  userId: string,
  connectorId: ConnectorId,
  sourcePosition: number,
  feedExternalId: string,
  feedName: string,
  feedPosition = 1,
) {
  const source = await createSource(database, {
    userId,
    connectorId,
    credentials: await encryptedCredentials(userId, connectorId),
    position: sourcePosition,
  });
  const feed = await createOrReviveFeed(database, {
    userId,
    sourceId: source.id,
    externalId: feedExternalId,
    name: feedName,
    kind: "news",
    position: feedPosition,
  });
  return { source, feed };
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

const period = { startMs: 1_700_000_000_000, endMs: 1_700_086_400_000 };

Deno.test("runForUser ingests feeds, summarizes them, and returns a complete digest", async () => {
  await withTestDb(async (database) => {
    const user = await createUser(
      database,
      userInput("orchestrator-happy@example.com"),
    );
    const first = await createSourceAndFeed(
      database,
      user.id,
      ConnectorId.Telegram,
      1,
      "channel:1",
      "First Feed",
    );
    const second = await createSourceAndFeed(
      database,
      user.id,
      ConnectorId.RSS,
      2,
      "rss:1",
      "Second Feed",
    );
    const connectorFactory = new FakeConnectorFactory({
      [first.source.id]: new FakeConnector({
        [first.feed.externalId]: [
          normalizedItem(first.feed.externalId, "1", "first item"),
        ],
      }),
      [second.source.id]: new FakeConnector({
        [second.feed.externalId]: [
          normalizedItem(second.feed.externalId, "1", "second item"),
        ],
      }),
    });
    const summarizer = new FakeSummarizer([
      [{ text: "first summary", sourceUrl: null }],
      [{ text: "second summary", sourceUrl: null }],
    ]);

    const view = await runForUser(database, user.id, period, {
      connectorFactory,
      summarizer,
      now: () => 200,
    });

    assertEquals(view.digest.status, "complete");
    assertEquals(view.sections.map((section) => section.feedName), [
      "First Feed",
      "Second Feed",
    ]);
    assertEquals(
      (await listItemsForFeedInWindow(
        database,
        first.feed.id,
        period.startMs,
        period.endMs,
      )).length,
      1,
    );
    assertEquals(connectorFactory.disposeCalls.length, 2);

    const runs = await listDigestRunsForUser(database, user.id, { limit: 1 });
    assertEquals(runs.length >= 1, true);
    assertEquals(runs[0].trigger, "manual");
  });
});

Deno.test("runForUser fails its run when connector disposal throws unexpectedly", async () => {
  await withTestDb(async (database) => {
    const user = await createUser(
      database,
      userInput("orchestrator-dispose-failure@example.com"),
    );
    const setup = await createSourceAndFeed(
      database,
      user.id,
      ConnectorId.Telegram,
      1,
      "channel:dispose",
      "Dispose Feed",
    );
    const connector = new FakeConnector({
      [setup.feed.externalId]: [
        normalizedItem(
          setup.feed.externalId,
          "1",
          "successfully ingested item",
        ),
      ],
    });
    const disposeError = new Error("dispose exploded with Bearer secret-token");
    const connectorFactory: ConnectorFactoryLike = {
      forSource: () =>
        Promise.resolve({
          connector,
          ingestionMode: "batch",
          dispose: () => {
            throw disposeError;
          },
        }),
    };

    const rejected = await assertRejects(() =>
      runForUser(database, user.id, period, {
        connectorFactory,
        summarizer: new FakeSummarizer([[{
          text: "summary",
          sourceUrl: null,
        }]]),
        now: () => 206,
      })
    );

    assert(rejected === disposeError);
    assertEquals(connector.calls.length, 1);
    const runs = await listDigestRunsForUser(database, user.id, { limit: 10 });
    assert(runs.length >= 1);
    assertEquals(runs[0].status, "failed");
    assert(runs[0].finishedAt !== null);
    assertEquals(
      runs[0].errorMessage,
      "dispose exploded with Bearer [REDACTED]",
    );
    assertEquals(runs.filter((run) => run.status === "running").length, 0);
  });
});

Deno.test("runForUser is idempotent for the same period", async () => {
  await withTestDb(async (database) => {
    const user = await createUser(
      database,
      userInput("orchestrator-idempotent@example.com"),
    );
    const setup = await createSourceAndFeed(
      database,
      user.id,
      ConnectorId.Telegram,
      1,
      "channel:1",
      "Only Feed",
    );
    const connector = new FakeConnector({
      [setup.feed.externalId]: [
        normalizedItem(setup.feed.externalId, "1", "only item"),
      ],
    });
    const connectorFactory = new FakeConnectorFactory({
      [setup.source.id]: connector,
    });
    const summarizer = new FakeSummarizer([[{
      text: "only summary",
      sourceUrl: null,
    }]]);

    const first = await runForUser(database, user.id, period, {
      connectorFactory,
      summarizer,
      now: () => 201,
    });
    const second = await runForUser(database, user.id, period, {
      connectorFactory,
      summarizer,
      now: () => 202,
    });

    assertEquals(first.digest.id, second.digest.id);
    assertEquals(connector.calls.length, 1);
    assertEquals(summarizer.calls.length, 1);
  });
});

Deno.test("runForUser creates an empty digest for a user with no sources", async () => {
  await withTestDb(async (database) => {
    const user = await createUser(
      database,
      userInput("orchestrator-empty@example.com"),
    );
    const view = await runForUser(database, user.id, period, {
      now: () => 203,
    });
    assertEquals(view.digest.status, "complete");
    assertEquals(view.sections, []);
  });
});

Deno.test("runForUser isolates source failures and marks the digest failed", async () => {
  await withTestDb(async (database) => {
    const user = await createUser(
      database,
      userInput("orchestrator-failure@example.com"),
    );
    const first = await createSourceAndFeed(
      database,
      user.id,
      ConnectorId.Telegram,
      1,
      "channel:1",
      "First Feed",
    );
    const second = await createSourceAndFeed(
      database,
      user.id,
      ConnectorId.RSS,
      2,
      "rss:1",
      "Second Feed",
    );
    const connectorFactory = new FakeConnectorFactory(
      {
        [second.source.id]: new FakeConnector({
          [second.feed.externalId]: [
            normalizedItem(second.feed.externalId, "1", "second item"),
          ],
        }),
      },
      new Set([first.source.id]),
    );
    const summarizer = new FakeSummarizer([[{
      text: "second summary",
      sourceUrl: null,
    }]]);

    const view = await runForUser(database, user.id, period, {
      connectorFactory,
      summarizer,
      now: () => 204,
    });

    assertEquals(view.digest.status, "failed");
    assertEquals(view.sections.map((section) => section.feedName), [
      "Second Feed",
    ]);
    assertEquals(
      (await findDigestForUserPeriod(
        database,
        user.id,
        period.startMs,
        period.endMs,
      ))?.status,
      "failed",
    );
    assertEquals(
      await findSummaryForFeedPeriod(
        database,
        first.feed.id,
        period.startMs,
        period.endMs,
      ),
      null,
    );

    const runs = await listDigestRunsForUser(database, user.id, { limit: 1 });
    assertEquals(runs.length >= 1, true);

    const feedRows: Array<Record<string, unknown>> = await database.execute(
      sql`select * from digest_run_feeds where run_id = ${runs[0].id}`,
    );
    const failedRows = feedRows.filter(
      (r) => r.status === "failed" && r.error_message !== null,
    );
    assertEquals(failedRows.length >= 1, true);
  });
});

Deno.test("runForUser marks run partial when summarization fails but ingestion succeeds", async () => {
  await withTestDb(async (database) => {
    const user = await createUser(
      database,
      userInput("orchestrator-summarizer-fail@example.com"),
    );
    const setup = await createSourceAndFeed(
      database,
      user.id,
      ConnectorId.Telegram,
      1,
      "channel:1",
      "Only Feed",
    );
    const connectorFactory = new FakeConnectorFactory({
      [setup.source.id]: new FakeConnector({
        [setup.feed.externalId]: [
          normalizedItem(setup.feed.externalId, "1", "some item"),
        ],
      }),
    });
    const summarizer = new FakeSummarizer([new Error("summarizer crash")]);

    const view = await runForUser(database, user.id, period, {
      connectorFactory,
      summarizer,
      now: () => 205,
    });

    assertEquals(view.digest.status, "failed");

    const runs = await listDigestRunsForUser(database, user.id, { limit: 1 });
    assertEquals(runs.length >= 1, true);
    assertEquals(runs[0].status, "partial");

    const feedRows: Array<Record<string, unknown>> = await database.execute(
      sql`select * from digest_run_feeds where run_id = ${runs[0].id}`,
    );
    const failedRows = feedRows.filter(
      (r) =>
        r.stage === "summarization" && r.status === "failed" &&
        r.error_message !== null,
    );
    assertEquals(failedRows.length >= 1, true);
  });
});

Deno.test("runForUser batches multiple feeds from the same source", async () => {
  await withTestDb(async (database) => {
    const user = await createUser(
      database,
      userInput("batch-same-source@example.com"),
    );
    const setup1 = await createSourceAndFeed(
      database,
      user.id,
      ConnectorId.Telegram,
      1,
      "channel:1",
      "Feed One",
    );
    await createOrReviveFeed(database, {
      userId: user.id,
      sourceId: setup1.source.id,
      externalId: "channel:2",
      name: "Feed Two",
      kind: "news",
    });

    const connector = new FakeConnector({
      "channel:1": [normalizedItem("channel:1", "1", "item from feed 1")],
      "channel:2": [normalizedItem("channel:2", "2", "item from feed 2")],
    });
    const connectorFactory = new FakeConnectorFactory({
      [setup1.source.id]: connector,
    });
    const summarizer = new FakeSummarizer([[{ text: "sum", sourceUrl: null }]]);

    const view = await runForUser(database, user.id, period, {
      connectorFactory,
      summarizer,
      now: () => 205,
    });

    // Exactly one connector call for both feeds
    assertEquals(connector.calls.length, 1);
    assert(connector.calls[0].feedExternalIds?.includes("channel:1"));
    assert(connector.calls[0].feedExternalIds?.includes("channel:2"));

    assertEquals(view.digest.status, "complete");
  });
});

Deno.test("runForUser connector failure marks all pending feeds failed when batching", async () => {
  await withTestDb(async (database) => {
    const user = await createUser(
      database,
      userInput("batch-connector-fail@example.com"),
    );
    const setup1 = await createSourceAndFeed(
      database,
      user.id,
      ConnectorId.Telegram,
      1,
      "channel:1",
      "Feed One",
    );
    await createOrReviveFeed(database, {
      userId: user.id,
      sourceId: setup1.source.id,
      externalId: "channel:2",
      name: "Feed Two",
      kind: "news",
    });

    // Both feeds are set to fail at the connector level
    const connector = new FakeConnector(
      { "channel:1": [], "channel:2": [] },
      new Set(["channel:1", "channel:2"]),
    );
    const connectorFactory = new FakeConnectorFactory({
      [setup1.source.id]: connector,
    });

    const view = await runForUser(database, user.id, period, {
      connectorFactory,
      now: () => 205,
    });

    assertEquals(view.digest.status, "failed");

    const runs = await listDigestRunsForUser(database, user.id, { limit: 1 });
    assertEquals(runs[0].status, "partial");

    const feedRows: Array<Record<string, unknown>> = await database.execute(
      sql`select * from digest_run_feeds where run_id = ${runs[0].id}`,
    );
    // Both feeds should have failed ingestion-stage rows
    const failedRows = feedRows.filter((r) =>
      r.stage === "ingestion" && r.status === "failed"
    );
    assertEquals(failedRows.length, 2);
  });
});

Deno.test("runForUser uses one individual handle and requests each feed separately", async () => {
  await withTestDb(async (database) => {
    const user = await createUser(
      database,
      userInput("individual-orchestrator@example.com"),
    );
    const setup1 = await createSourceAndFeed(
      database,
      user.id,
      ConnectorId.Telegram,
      1,
      "channel:1",
      "Feed One",
    );
    await createOrReviveFeed(database, {
      userId: user.id,
      sourceId: setup1.source.id,
      externalId: "channel:2",
      name: "Feed Two",
      kind: "news",
    });
    const connector = new FakeConnector({
      "channel:1": [normalizedItem("channel:1", "1", "item one")],
      "channel:2": [normalizedItem("channel:2", "2", "item two")],
    });
    const connectorFactory = new FakeConnectorFactory(
      { [setup1.source.id]: connector },
      new Set(),
      { [setup1.source.id]: "individual" },
    );
    const summarizer = new FakeSummarizer([[{ text: "sum", sourceUrl: null }]]);

    const view = await runForUser(database, user.id, period, {
      connectorFactory,
      summarizer,
      now: () => 205,
    });

    assertEquals(view.digest.status, "complete");
    assertEquals(connectorFactory.forSourceCalls, [setup1.source.id]);
    assertEquals(connector.calls.length, 2);
    assertEquals(connector.calls.map((call) => call.feedExternalIds), [[
      "channel:1",
    ], ["channel:2"]]);
  });
});
