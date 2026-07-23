import { test } from "bun:test";
import { assert, assertEquals, assertRejects } from "../assertions.ts"
import type {
  ConnectorFactoryLike,
  ConnectorHandle,
} from "../../src/connectors/connector-factory.ts";
import {
  type PublicationPageReader,
  SubstackConnector,
  type SubstackPostReader,
} from "../../src/connectors/substack/substack-connector.ts";
import type { ArchiveItem } from "../../src/connectors/substack/publication-reader.ts";
import type { SubstackPrivatePost } from "../../src/connectors/substack/session-client.ts";
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
import {
  createOrReviveFeed,
  setLastFetched,
} from "../../src/repositories/feed-repository.ts";
import {
  listItemsForFeedInWindow,
  upsertItems,
} from "../../src/repositories/item-repository.ts";
import {
  createSource,
  type PublicSource,
  updateSource,
} from "../../src/repositories/source-repository.ts";
import { runForUser } from "../../src/services/orchestrator.ts";
import { renderDigestMarkdown } from "../../src/services/digest-service.ts";
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
import {
  findSummaryForFeedPeriod,
  upsertSummaryForPeriod,
} from "../../src/repositories/summary-repository.ts";
import { sql } from "drizzle-orm";
import { listDigestRunsForUser } from "../../src/repositories/digest-run-repository.ts";
import { discardOperationalEvent } from "../operational-log-recorder.ts";
import { fixtureStoryIntelligence } from "./fixture-story-intelligence.ts";

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
    readonly connectorsBySourceId: Record<string, Connector<unknown>>,
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

test("runForUser ingests feeds, summarizes them, and returns a complete digest", async () => {
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

    const view = await runForUser(database, user.id, period, { connectorFactory, summarizer, intelligence: fixtureStoryIntelligence, now: () => 200,
    recordOperationalEvent: discardOperationalEvent, });

    assertEquals(view.digest.status, "complete");
    assertEquals(view.digest.contentMode, "stories");
    assertEquals(view.sections, []);
    assertEquals(view.stories.length, 1);
    assertEquals(view.stories[0].sources.map((source) => source.feedName), [
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

test("runForUser fails its run when connector disposal throws unexpectedly", async () => {
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
      runForUser(database, user.id, period, { connectorFactory, summarizer: new FakeSummarizer([[{
        text: "summary",
        sourceUrl: null,
      }]]), intelligence: fixtureStoryIntelligence, now: () => 206,
      recordOperationalEvent: discardOperationalEvent, })
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

test("runForUser is idempotent for the same period", async () => {
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

    const first = await runForUser(database, user.id, period, { connectorFactory, summarizer, intelligence: fixtureStoryIntelligence, now: () => 201,
    recordOperationalEvent: discardOperationalEvent, });
    const second = await runForUser(database, user.id, period, { connectorFactory, summarizer, intelligence: fixtureStoryIntelligence, now: () => 202,
    recordOperationalEvent: discardOperationalEvent, });

    assertEquals(first.digest.id, second.digest.id);
    assertEquals(connector.calls.length, 1);
    assertEquals(summarizer.calls.length, 1);
  });
});

test("runForUser creates an empty digest for a user with no sources", async () => {
  await withTestDb(async (database) => {
    const user = await createUser(
      database,
      userInput("orchestrator-empty@example.com"),
    );
    const view = await runForUser(database, user.id, period, {
      now: () => 203,
      recordOperationalEvent: discardOperationalEvent,
    });
    assertEquals(view.digest.status, "complete");
    assertEquals(view.digest.contentMode, "stories");
    assertEquals(view.stories, []);
    assertEquals(view.sections, []);
  });
});

test("runForUser isolates source failures and marks the digest failed", async () => {
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

    const view = await runForUser(database, user.id, period, { connectorFactory, summarizer, intelligence: fixtureStoryIntelligence, now: () => 204,
    recordOperationalEvent: discardOperationalEvent, });

    assertEquals(view.digest.status, "failed");
    assertEquals(view.digest.contentMode, "stories");
    assertEquals(view.sections, []);
    assertEquals(view.stories[0].sources.map((source) => source.feedName), [
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

test("runForUser marks run partial when summarization fails but ingestion succeeds", async () => {
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

    const view = await runForUser(database, user.id, period, { connectorFactory, summarizer, intelligence: fixtureStoryIntelligence, now: () => 205,
    recordOperationalEvent: discardOperationalEvent, });

    assertEquals(view.digest.status, "failed");

    const runs = await listDigestRunsForUser(database, user.id, { limit: 1 });
    assertEquals(runs.length >= 1, true);
    assertEquals(runs[0].status, "partial");

    const feedRows: Array<Record<string, unknown>> = await database.execute(
      sql`select * from digest_run_feeds where run_id = ${runs[0].id}`,
    );
    assertEquals(
      feedRows.filter((row) => row.stage === "summarization").length,
      0,
    );
  });
});

test("runForUser batches multiple feeds from the same source", async () => {
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

    const view = await runForUser(database, user.id, period, { connectorFactory, summarizer, intelligence: fixtureStoryIntelligence, now: () => 205,
    recordOperationalEvent: discardOperationalEvent, });

    // Exactly one connector call for both feeds
    assertEquals(connector.calls.length, 1);
    assert(connector.calls[0].feedExternalIds?.includes("channel:1"));
    assert(connector.calls[0].feedExternalIds?.includes("channel:2"));

    assertEquals(view.digest.status, "complete");
  });
});

test("runForUser connector failure marks all pending feeds failed when batching", async () => {
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
      recordOperationalEvent: discardOperationalEvent,
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

test("runForUser uses one individual handle and requests each feed separately", async () => {
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

    const view = await runForUser(database, user.id, period, { connectorFactory, summarizer, intelligence: fixtureStoryIntelligence, now: () => 205,
    recordOperationalEvent: discardOperationalEvent, });

    assertEquals(view.digest.status, "complete");
    assertEquals(connectorFactory.forSourceCalls, [setup1.source.id]);
    assertEquals(connector.calls.length, 2);
    assertEquals(connector.calls.map((call) => call.feedExternalIds), [[
      "channel:1",
    ], ["channel:2"]]);
  });
});

test("runForUser refreshes covered Substack feeds with paid items for the full period", async () => {
  await withTestDb(async (database) => {
    const user = await createUser(
      database,
      userInput("orchestrator-legacy-paid@example.com"),
    );
    const { source, feed: legacyFeed } = await createSourceAndFeed(
      database,
      user.id,
      ConnectorId.Substack,
      1,
      "legacy-publication",
      "Legacy publication",
    );
    const unaffectedFeed = await createOrReviveFeed(database, {
      userId: user.id,
      sourceId: source.id,
      externalId: "current-publication",
      name: "Current publication",
      kind: "news",
      position: 2,
    });
    await setLastFetched(database, legacyFeed.id, user.id, period.endMs);
    await setLastFetched(database, unaffectedFeed.id, user.id, period.endMs);

    const legacyItem: NormalizedItem = {
      connectorId: ConnectorId.Substack,
      feedExternalId: legacyFeed.externalId,
      externalId: "post-1",
      date: period.startMs + 1,
      title: "Paid post",
      text: "Paid post body",
      author: "Writer",
      url: "https://example.substack.com/p/post-1",
      meta: { audience: "only_paid" },
    };
    await upsertItems(database, legacyFeed.id, [legacyItem], period.startMs);

    const refreshedItem: NormalizedItem = {
      ...legacyItem,
      text: "Refreshed paid post body",
      meta: { audience: "only_paid", hasPaidSubscription: true },
    };
    const connector = new FakeConnector({
      [legacyFeed.externalId]: [refreshedItem],
      [unaffectedFeed.externalId]: [],
    });
    const connectorFactory = new FakeConnectorFactory({
      [source.id]: connector,
    });
    const summarizer = new FakeSummarizer([[
      { text: "refreshed summary", sourceUrl: null },
    ]]);

    await runForUser(database, user.id, period, { connectorFactory, summarizer, intelligence: fixtureStoryIntelligence, now: () => period.endMs + 1,
    recordOperationalEvent: discardOperationalEvent, });

    assertEquals(connector.calls, [{
      from: period.startMs,
      to: period.endMs,
      feedExternalIds: [legacyFeed.externalId],
    }]);
    const stored = await listItemsForFeedInWindow(
      database,
      legacyFeed.id,
      period.startMs,
      period.endMs,
    );
    assertEquals(stored.length, 1);
    assertEquals(stored[0].payload.text, "Refreshed paid post body");
    assertEquals(stored[0].payload.meta?.hasPaidSubscription, true);
    assertEquals(summarizer.calls.length, 1);

    await runForUser(database, user.id, period, { connectorFactory, summarizer, intelligence: fixtureStoryIntelligence, now: () => period.endMs + 2,
    recordOperationalEvent: discardOperationalEvent, });
    assertEquals(connector.calls.length, 2);
    assertEquals(summarizer.calls.length, 1);
  });
});

test("runForUser resummarizes a paid post after a free subscriber upgrades", async () => {
  await withTestDb(async (database) => {
    const user = await createUser(
      database,
      userInput("orchestrator-paid-upgrade@example.com"),
    );
    const { source, feed } = await createSourceAndFeed(
      database,
      user.id,
      ConnectorId.Substack,
      1,
      "upgrade-publication",
      "Upgrade publication",
    );
    await updateSource(database, source.id, user.id, {
      showPaidPostTitles: true,
    });
    await setLastFetched(database, feed.id, user.id, period.endMs);

    const title = "Paid post available after upgrade";
    const inaccessibleItem: NormalizedItem = {
      connectorId: ConnectorId.Substack,
      feedExternalId: feed.externalId,
      externalId: "upgrade-post-1",
      date: period.startMs + 1,
      title,
      text: "Public preview",
      author: "Writer",
      url: "https://example.substack.com/p/upgrade-post-1",
      meta: {
        audience: "only_paid",
        contentAccess: "preview",
        hasPaidSubscription: false,
      },
    };
    await upsertItems(database, feed.id, [inaccessibleItem], period.startMs);
    await upsertSummaryForPeriod(database, {
      feedId: feed.id,
      periodStartMs: period.startMs,
      periodEndMs: period.endMs,
      feedNameSnapshot: feed.name,
      content: {
        kind: "articles",
        articles: [{
          sourceExternalId: inaccessibleItem.externalId,
          title,
          sourceUrl: inaccessibleItem.url,
          publishedAt: inaccessibleItem.date,
          contentAccess: "full",
          points: [{
            text: "stale pre-fix teaser summary",
            sourceUrl: inaccessibleItem.url,
          }],
        }],
      },
    }, period.startMs + 2);

    const accessibleItem: NormalizedItem = {
      ...inaccessibleItem,
      text: "Complete paid article body",
      meta: {
        audience: "only_paid",
        contentAccess: "full",
        hasPaidSubscription: true,
      },
    };
    const connector = new FakeConnector({
      [feed.externalId]: [accessibleItem],
    });
    const connectorFactory = new FakeConnectorFactory(
      { [source.id]: connector },
      new Set(),
      { [source.id]: "individual" },
    );
    const summarizer = new FakeSummarizer([
      new Error("temporary model failure"),
      [{ text: "new full-body summary", sourceUrl: accessibleItem.url }],
    ]);

    const failedView = await runForUser(database, user.id, period, { connectorFactory, summarizer, intelligence: fixtureStoryIntelligence, now: () => period.endMs + 1,
    recordOperationalEvent: discardOperationalEvent, });
    assertEquals(failedView.digest.status, "failed");
    assertEquals(summarizer.calls.length, 1);
    assertEquals(
      renderDigestMarkdown(failedView).includes(
        "stale pre-fix teaser summary",
      ),
      false,
    );

    const view = await runForUser(database, user.id, period, { connectorFactory, summarizer, intelligence: fixtureStoryIntelligence, now: () => period.endMs + 2,
    recordOperationalEvent: discardOperationalEvent, });

    assertEquals(connector.calls, [{
      from: period.startMs,
      to: period.endMs,
      feedExternalIds: [feed.externalId],
    }, {
      from: period.startMs,
      to: period.endMs,
      feedExternalIds: [feed.externalId],
    }]);
    assertEquals(summarizer.calls.length, 2);
    assertEquals(summarizer.calls[0].items[0].text, accessibleItem.text);
    assertEquals(view.paidPosts, []);
    assertEquals(view.digest.contentMode, "stories");
    assertEquals(
      view.stories.flatMap((story) => story.points.map((point) => point.text)),
      ["new full-body summary"],
    );

    await runForUser(database, user.id, period, { connectorFactory, summarizer, intelligence: fixtureStoryIntelligence, now: () => period.endMs + 3,
    recordOperationalEvent: discardOperationalEvent, });
    assertEquals(connector.calls.length, 3);
    assertEquals(summarizer.calls.length, 2);

    connector.responses[feed.externalId] = [{
      ...accessibleItem,
      text: "Public preview after subscription ended",
      meta: {
        audience: "only_paid",
        contentAccess: "preview",
        hasPaidSubscription: false,
      },
    }];
    const downgradedView = await runForUser(database, user.id, period, { connectorFactory, summarizer, intelligence: fixtureStoryIntelligence, now: () => period.endMs + 4,
    recordOperationalEvent: discardOperationalEvent, });
    assertEquals(connector.calls.length, 4);
    assertEquals(summarizer.calls.length, 2);
    assertEquals(downgradedView.paidPosts.map((post) => post.title), [title]);
    assertEquals(
      downgradedView.sections.flatMap((section) =>
        section.content.kind === "articles"
          ? section.content.articles.flatMap((article) =>
            article.points.map((point) => point.text)
          )
          : []
      ),
      [],
    );
  });
});

test("runForUser repairs a cached free-subscriber paid teaser without another model call", async () => {
  await withTestDb(async (database) => {
    const user = await createUser(
      database,
      userInput("orchestrator-cached-paid-teaser@example.com"),
    );
    const { source, feed } = await createSourceAndFeed(
      database,
      user.id,
      ConnectorId.Substack,
      1,
      "paid-publication",
      "Paid publication",
    );
    await updateSource(database, source.id, user.id, {
      showPaidPostTitles: true,
    });
    await setLastFetched(database, feed.id, user.id, period.endMs);

    const title = "Paid post with a teaser";
    const legacyItem: NormalizedItem = {
      connectorId: ConnectorId.Substack,
      feedExternalId: feed.externalId,
      externalId: "paid-post-1",
      date: period.startMs + 1,
      title,
      text: "One available teaser sentence.",
      author: "Writer",
      url: "https://example.substack.com/p/paid-post-1",
      meta: { audience: "only_paid", contentAccess: "full" },
    };
    await upsertItems(database, feed.id, [legacyItem], period.startMs);
    await upsertSummaryForPeriod(database, {
      feedId: feed.id,
      periodStartMs: period.startMs,
      periodEndMs: period.endMs,
      feedNameSnapshot: feed.name,
      content: {
        kind: "articles",
        articles: [{
          sourceExternalId: legacyItem.externalId,
          title,
          sourceUrl: legacyItem.url,
          publishedAt: legacyItem.date,
          contentAccess: "full",
          points: [{
            text: "stale teaser point",
            sourceUrl: legacyItem.url,
          }],
        }],
      },
    }, period.startMs + 2);

    const refreshedItem: NormalizedItem = {
      ...legacyItem,
      text: "Public preview",
      meta: {
        audience: "only_paid",
        contentAccess: "preview",
        hasPaidSubscription: false,
      },
    };
    const connector = new FakeConnector({
      [feed.externalId]: [refreshedItem],
    });
    const connectorFactory = new FakeConnectorFactory(
      { [source.id]: connector },
      new Set(),
      { [source.id]: "individual" },
    );
    const summarizer = new FakeSummarizer([]);

    const view = await runForUser(database, user.id, period, { connectorFactory, summarizer, intelligence: fixtureStoryIntelligence, now: () => period.endMs + 1,
    recordOperationalEvent: discardOperationalEvent, });

    assertEquals(connector.calls, [{
      from: period.startMs,
      to: period.endMs,
      feedExternalIds: [feed.externalId],
    }]);
    assertEquals(summarizer.calls.length, 0);
    assertEquals(view.digest.contentMode, "stories");
    assertEquals(view.stories, []);
    assertEquals(view.paidPosts.map((post) => post.title), [title]);
    const markdown = renderDigestMarkdown(view);
    assertEquals(markdown.includes("stale teaser point"), false);
    assertEquals(markdown.includes(title), true);

    const [storedItem] = await listItemsForFeedInWindow(
      database,
      feed.id,
      period.startMs,
      period.endMs,
    );
    assertEquals(storedItem.payload.meta?.hasPaidSubscription, false);
  });
});

test("runForUser summarizes a public Substack podcast beside an inaccessible paid post", async () => {
  await withTestDb(async (database) => {
    const user = await createUser(
      database,
      userInput("orchestrator-substack-podcast@example.com"),
    );
    const publication = "https://podcast-letter.example.com";
    const { source, feed } = await createSourceAndFeed(
      database,
      user.id,
      ConnectorId.Substack,
      1,
      publication,
      "Podcast Letter",
    );
    await updateSource(database, source.id, user.id, {
      showPaidPostTitles: true,
    });

    const podcastTitle = "A public podcast episode";
    const podcastBody = "The complete public podcast transcript.";
    const podcastUrl = `${publication}/p/public-podcast`;
    const paidTitle = "The private newsletter";
    const paidPreview = "This paid preview must never reach the digest.";
    const paidUrl = `${publication}/p/private-newsletter`;
    const podcastId = 201;
    const paidId = 202;
    const publicationId = 91;

    const storedPaidItem: NormalizedItem = {
      connectorId: ConnectorId.Substack,
      feedExternalId: feed.externalId,
      externalId: String(paidId),
      date: period.startMs + 2_000,
      title: paidTitle,
      text: paidPreview,
      author: "Newsletter Writer",
      url: paidUrl,
      meta: {
        audience: "only_paid",
        contentAccess: "preview",
        hasPaidSubscription: false,
      },
    };
    await upsertItems(database, feed.id, [storedPaidItem], period.startMs);
    await setLastFetched(database, feed.id, user.id, period.endMs);

    await upsertSummaryForPeriod(database, {
      feedId: feed.id,
      periodStartMs: period.startMs,
      periodEndMs: period.endMs,
      feedNameSnapshot: feed.name,
      content: {
        kind: "articles",
        articles: [{
          sourceExternalId: String(paidId),
          title: paidTitle,
          sourceUrl: paidUrl,
          publishedAt: period.startMs + 2_000,
          contentAccess: "paid",
          points: [],
        }],
      },
    }, period.startMs + 3_000);

    const archiveItems: ArchiveItem[] = [{
      id: podcastId,
      type: "podcast",
      title: podcastTitle,
      postDate: period.startMs + 1_000,
      audience: "everyone",
      truncatedBodyText: "Public podcast preview",
      description: undefined,
      subtitle: undefined,
      canonicalUrl: podcastUrl,
      publishedBylines: [{ name: "Podcast Host" }],
      publicationName: feed.name,
      publicationId,
      raw: {},
    }, {
      id: paidId,
      type: "newsletter",
      title: paidTitle,
      postDate: period.startMs + 2_000,
      audience: "only_paid",
      truncatedBodyText: paidPreview,
      description: undefined,
      subtitle: undefined,
      canonicalUrl: paidUrl,
      publishedBylines: [{ name: "Newsletter Writer" }],
      publicationName: feed.name,
      publicationId,
      raw: {},
    }];
    const pages: PublicationPageReader = (_publicationUrl, offset) =>
      Promise.resolve({
        origin: publication,
        items: offset === 0 ? archiveItems : [],
      });
    const privatePosts = new Map<number, SubstackPrivatePost>([
      [podcastId, {
        id: podcastId,
        publicationId,
        bodyHtml: `<p>${podcastBody}</p>`,
        hasPaidSubscription: false,
      }],
      [paidId, {
        id: paidId,
        publicationId,
        bodyHtml: "<p>Subscriber-only teaser</p>",
        hasPaidSubscription: false,
      }],
    ]);
    const posts: SubstackPostReader = {
      getPostById: (postId) =>
        Promise.resolve(privatePosts.get(postId) ?? null),
    };
    const realConnector = new SubstackConnector(posts, pages);
    const connectorCalls: Array<{
      from: number;
      to: number;
      feedExternalIds?: string[];
    }> = [];
    const connector: Connector<unknown> = {
      getRawData: (from, to, feedExternalIds, signal) =>
        realConnector.getRawData(from, to, feedExternalIds, signal),
      getNormalizedData: (from, to, feedExternalIds, signal) => {
        connectorCalls.push({ from, to, feedExternalIds });
        return realConnector.getNormalizedData(
          from,
          to,
          feedExternalIds,
          signal,
        );
      },
    };
    const connectorFactory = new FakeConnectorFactory(
      { [source.id]: connector },
      new Set(),
      { [source.id]: "individual" },
    );
    const podcastSummary = "A concise summary of the public podcast.";
    const summarizer = new FakeSummarizer([[
      { text: podcastSummary, sourceUrl: podcastUrl },
    ]]);

    const view = await runForUser(database, user.id, period, { connectorFactory, summarizer, intelligence: fixtureStoryIntelligence, now: () => period.endMs + 1,
    recordOperationalEvent: discardOperationalEvent, });

    assertEquals(connectorCalls, [{
      from: period.startMs,
      to: period.endMs,
      feedExternalIds: [feed.externalId],
    }]);
    assertEquals(summarizer.calls.length, 1);
    assertEquals(
      summarizer.calls[0].items.map((item) => ({
        title: item.title,
        text: item.text,
      })),
      [{ title: podcastTitle, text: podcastBody }],
    );
    assertEquals(view.digest.contentMode, "stories");
    assertEquals(
      view.stories.map((story) => ({
        title: story.title,
        points: story.points.map((point) => point.text),
      })),
      [{ title: "Fixture Story", points: [podcastSummary] }],
    );
    assertEquals(view.paidPosts.map((post) => post.title), [paidTitle]);

    const markdown = renderDigestMarkdown(view);
    assert(markdown.includes(podcastTitle));
    assert(markdown.includes(podcastSummary));
    assert(markdown.includes(paidTitle));
    assertEquals(markdown.includes(paidPreview), false);
  });
});
