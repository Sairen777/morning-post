import { test } from "bun:test";
import {
  assertEquals,
  assertRejects,
  assertStringIncludes,
} from "../assertions.ts";
import {
  buildDigestViewById,
  type DigestView,
  renderDigestMarkdown,
} from "../../src/services/digest-service.ts";
import { ConnectorId } from "../../src/constants.ts";
import { CredentialCipher } from "../../src/crypto/credential-cipher.ts";
import { EnvMasterKeyProvider } from "../../src/crypto/key-provider.ts";
import { withTestDb } from "../../src/db/testing.ts";
import { createUser } from "../../src/repositories/user-repository.ts";
import {
  createSource,
  updateSource,
} from "../../src/repositories/source-repository.ts";
import { createOrReviveFeed } from "../../src/repositories/feed-repository.ts";
import { upsertItems } from "../../src/repositories/item-repository.ts";
import { upsertDigestForPeriod } from "../../src/repositories/digest-repository.ts";
import {
  listDigestStories,
  listItemAnalyses,
} from "../../src/repositories/story-repository.ts";
import { assembleStoryDigest } from "../../src/services/story-digest-service.ts";
import { fingerprintStoryItem } from "../../src/services/story-intelligence-service.ts";
import type {
  AnalyzedStoryItem,
  PersistedStoryCandidate,
  StoryIntelligenceService,
  StoryItemInput,
  StoryPreferenceRule,
  StoryReference,
} from "../../src/personalization/story.types.ts";
import type {
  SummarizerService,
  SummaryRuleset,
} from "../../src/summarizers/summarizer.types.ts";

function digest(contentMode: "legacy" | "stories"): DigestView["digest"] {
  return {
    id: "00000000-0000-4000-8000-000000000001",
    userId: "00000000-0000-4000-8000-000000000002",
    periodStartMs: 0,
    periodEndMs: 1,
    status: "complete",
    contentMode,
    createdAt: 1,
    updatedAt: 1,
  };
}

test("story digest markdown renders every source link and no legacy groups", () => {
  const view: DigestView = {
    digest: digest("stories"),
    stories: [{
      id: "00000000-0000-4000-8000-000000000003",
      digestId: "00000000-0000-4000-8000-000000000001",
      storyId: "00000000-0000-4000-8000-000000000004",
      storyVersion: 2,
      profileVersion: 3,
      generatedAt: 1,
      title: "Shared story",
      topics: ["technology"],
      entities: ["Example"],
      points: [{ text: "A development", sourceUrl: null }],
      relevanceScore: 88,
      matchedInterestRuleIds: [],
      sources: [
        {
          itemId: "00000000-0000-4000-8000-000000000005",
          connectorId: ConnectorId.RSS,
          sourceId: "00000000-0000-4000-8000-000000000006",
          feedId: "00000000-0000-4000-8000-000000000007",
          feedName: "Wire",
          title: "Report A",
          url: "https://a.example/report",
          publishedAt: 1,
        },
        {
          itemId: "00000000-0000-4000-8000-000000000008",
          connectorId: ConnectorId.Telegram,
          sourceId: "00000000-0000-4000-8000-000000000009",
          feedId: "00000000-0000-4000-8000-000000000010",
          feedName: "Channel",
          title: "Report B",
          url: "https://b.example/report",
          publishedAt: 1,
        },
      ],
    }],
    sections: [],
    groups: [],
    paidPosts: [],
    failureReason: null,
  };
  const markdown = renderDigestMarkdown(view);
  assertStringIncludes(markdown, "## Shared story");
  assertStringIncludes(markdown, "https://a.example/report");
  assertStringIncludes(markdown, "https://b.example/report");
});

test("empty story mode is distinguishable from historical legacy mode", () => {
  const stories: DigestView = {
    digest: digest("stories"),
    stories: [],
    sections: [],
    groups: [],
    paidPosts: [],
    failureReason: null,
  };
  const legacy: DigestView = {
    digest: digest("legacy"),
    stories: [],
    sections: [],
    groups: [],
    paidPosts: [],
    failureReason: null,
  };
  assertEquals(stories.digest.contentMode, "stories");
  assertEquals(legacy.digest.contentMode, "legacy");
});

class FixtureIntelligence implements StoryIntelligenceService {
  analyzeCalls = 0;
  recentReferenceCounts: number[] = [];
  splitStories = false;
  async analyze(items: StoryItemInput[]): Promise<AnalyzedStoryItem[]> {
    this.analyzeCalls++;
    return await Promise.all(items.map(async (item) => ({
      ...item,
      fingerprint: await fingerprintStoryItem(item),
      analysis: {
        language: "en",
        canonicalUrls: item.payload.url ? [item.payload.url] : [],
        topics: ["technology"],
        entities: ["Example"],
        storyKey: "shared-story",
        storyTitle: "Shared Story",
        developmentKey: item.payload.externalId,
        developmentType: "report",
        developmentTitle: item.payload.title ?? "Report",
        mediaDescription: null,
      },
    })));
  }
  async resolve(
    items: AnalyzedStoryItem[],
    recentStories: StoryReference[] = [],
  ) {
    this.recentReferenceCounts.push(recentStories.length);
    if (this.splitStories) {
      return items.map((item) => ({
        canonicalKey: `story-${item.payload.externalId}`,
        title: `Story ${item.payload.externalId}`,
        topics: ["technology"],
        entities: ["Example"],
        developments: [{
          canonicalKey: item.payload.externalId,
          type: "report",
          title: item.payload.title ?? "Report",
          occurredAt: item.payload.date,
          items: [item],
        }],
      }));
    }
    const canonicalKey =
      recentStories.find((story) => story.title === "Shared Story")
        ?.canonicalKey ?? "shared-story";
    return [{
      canonicalKey,
      title: "Shared Story",
      topics: ["technology"],
      entities: ["Example"],
      developments: items.map((item) => ({
        canonicalKey: item.payload.externalId,
        type: "report",
        title: item.payload.title ?? "Report",
        occurredAt: item.payload.date,
        items: [item],
      })),
    }];
  }
  async classify(
    stories: PersistedStoryCandidate[],
    _rules: StoryPreferenceRule[],
    threshold: number,
  ) {
    return stories.map((story) => ({
      storyId: story.id,
      relevant: threshold <= 80,
      score: 80,
      matchedInterestRuleIds: [],
      blockedByInterestRuleIds: [],
      reason: "fixture",
    }));
  }
}

test("service clusters connectors, caches analysis, preserves reruns, provenance, and ignores legacy exclusion prompt", async () => {
  await withTestDb(async (database) => {
    const user = await createUser(database, {
      name: "Owner",
      email: "story-service@example.com",
      passwordHash: "$argon2id$fake",
      systemPrompt: "Exclude every story.",
      summaryPrompt: "Emphasize concrete changes.",
      defaultLanguage: "en",
      relevanceThreshold: 0,
    });
    const cipher = new CredentialCipher(
      new EnvMasterKeyProvider(new Uint8Array(32).fill(9)),
    );
    const makeSource = async (connectorId: ConnectorId) =>
      createSource(database, {
        userId: user.id,
        connectorId,
        credentials: await cipher.encrypt("{}", {
          userId: user.id,
          connectorId,
        }),
      });
    const substack = await makeSource(ConnectorId.Substack);
    const rss = await makeSource(ConnectorId.RSS);
    const firstFeed = await createOrReviveFeed(database, {
      userId: user.id,
      sourceId: substack.id,
      externalId: "substack-feed",
      name: "Substack",
      kind: "news",
    });
    const secondFeed = await createOrReviveFeed(database, {
      userId: user.id,
      sourceId: rss.id,
      externalId: "rss-feed",
      name: "RSS",
      kind: "news",
    });
    const payload = (
      connectorId: ConnectorId,
      feedExternalId: string,
      externalId: string,
      url: string,
    ) => ({
      connectorId,
      feedExternalId,
      externalId,
      date: 100,
      title: externalId,
      text: "Accessible report",
      author: null,
      url,
    });
    await upsertItems(database, firstFeed.id, [
      payload(
        ConnectorId.Substack,
        firstFeed.externalId,
        "one",
        "https://one.example/",
      ),
    ], 101);
    await upsertItems(database, secondFeed.id, [
      payload(
        ConnectorId.RSS,
        secondFeed.externalId,
        "two",
        "https://two.example/",
      ),
    ], 101);
    const row = await upsertDigestForPeriod(database, {
      userId: user.id,
      periodStartMs: 0,
      periodEndMs: 200,
      status: "pending",
    });
    const intelligence = new FixtureIntelligence();
    const prompts: SummaryRuleset[] = [];
    let summaryFailure = false;
    const summarizer: SummarizerService = {
      summarize: async (_items, rules) => {
        prompts.push(rules);
        if (summaryFailure) throw new Error("summary failed");
        return [{ text: "Combined development", sourceUrl: null }];
      },
    };
    const first = await assembleStoryDigest(
      database,
      row.id,
      user,
      [firstFeed, secondFeed],
      0,
      200,
      { intelligence, summarizer, analyzerVersion: "fixture-v1" },
    );
    assertEquals(first.hadSummaryFailure, false);
    assertEquals(first.stories.length, 1);
    assertEquals(first.stories[0].sources.map((source) => source.connectorId), [
      ConnectorId.Substack,
      ConnectorId.RSS,
    ]);
    assertEquals(
      prompts[0].systemPrompt.includes("Emphasize concrete changes."),
      true,
    );
    assertEquals(
      prompts[0].systemPrompt.includes("Exclude every story."),
      false,
    );
    const rerun = await assembleStoryDigest(
      database,
      row.id,
      user,
      [firstFeed, secondFeed],
      0,
      200,
      { intelligence, summarizer, analyzerVersion: "fixture-v1" },
    );
    assertEquals(rerun.stories.length, 1);
    assertEquals(intelligence.analyzeCalls, 1);
    assertEquals(intelligence.recentReferenceCounts, [0, 1]);
    intelligence.splitStories = true;
    user.maximumStoriesPerDigest = 1;
    const limited = await assembleStoryDigest(
      database,
      row.id,
      user,
      [firstFeed, secondFeed],
      0,
      200,
      { intelligence, summarizer, analyzerVersion: "fixture-v1" },
    );
    assertEquals(limited.stories.length, 1);
    summaryFailure = true;
    await upsertItems(database, firstFeed.id, [{
      ...payload(
        ConnectorId.Substack,
        firstFeed.externalId,
        "one",
        "https://one.example/",
      ),
      text: "Accessible report with a new development",
    }], 201);
    const failedRerun = await assembleStoryDigest(
      database,
      row.id,
      user,
      [firstFeed, secondFeed],
      0,
      200,
      { intelligence, summarizer, analyzerVersion: "fixture-v1" },
    );
    assertEquals(failedRerun.hadSummaryFailure, true);
    assertEquals(failedRerun.stories.length, 1);
    assertEquals(failedRerun.stories[0].points[0].text, "Combined development");

    await updateSource(database, substack.id, user.id, {
      showPaidPostTitles: true,
    });
    await upsertItems(database, firstFeed.id, [{
      ...payload(
        ConnectorId.Substack,
        firstFeed.externalId,
        "one",
        "https://one.example/",
      ),
      title: "Paid headline",
      text: "",
      meta: { audience: "only_paid", contentAccess: "preview" },
    }], 202);
    const downgraded = await buildDigestViewById(database, user.id, row.id);
    assertEquals(downgraded.stories.length, 0);
    assertEquals(downgraded.paidPosts.map((post) => post.title), [
      "Paid headline",
    ]);
  });
});

test("analysis checkpoints persist before a later failure and reruns resume remaining misses", async () => {
  await withTestDb(async (database) => {
    const user = await createUser(database, {
      name: "Checkpoint Owner",
      email: "story-checkpoints@example.com",
      passwordHash: "$argon2id$fake",
      defaultLanguage: "en",
      systemPrompt: "",
      relevanceThreshold: 0,
    });
    const cipher = new CredentialCipher(
      new EnvMasterKeyProvider(new Uint8Array(32).fill(7)),
    );
    const source = await createSource(database, {
      userId: user.id,
      connectorId: ConnectorId.RSS,
      credentials: await cipher.encrypt("{}", {
        userId: user.id,
        connectorId: ConnectorId.RSS,
      }),
    });
    const feed = await createOrReviveFeed(database, {
      userId: user.id,
      sourceId: source.id,
      externalId: "checkpoint-feed",
      name: "Checkpoint Feed",
      kind: "news",
    });
    const externalIds = Array.from(
      { length: 11 },
      (_, index) => `item-${index}`,
    );
    const stored = await upsertItems(
      database,
      feed.id,
      externalIds.map((externalId, index) => ({
        connectorId: ConnectorId.RSS,
        feedExternalId: feed.externalId,
        externalId,
        date: 100 + index,
        title: externalId,
        text: `Report ${externalId}`,
        author: null,
        url: `https://${externalId}.example/`,
      })),
      200,
    );
    const row = await upsertDigestForPeriod(database, {
      userId: user.id,
      periodStartMs: 0,
      periodEndMs: 200,
      status: "pending",
    });
    const intelligence = new FixtureIntelligence();
    const analyzedBatches: string[][] = [];
    let failSecondCheckpoint = true;
    const fixtureAnalyze = intelligence.analyze.bind(intelligence);
    intelligence.analyze = async (items) => {
      analyzedBatches.push(items.map((item) => item.payload.externalId));
      if (failSecondCheckpoint && analyzedBatches.length === 2) {
        throw new Error("later checkpoint failed");
      }
      return await fixtureAnalyze(items);
    };
    const summarizer: SummarizerService = {
      summarize: async () => [{ text: "Checkpoint summary", sourceUrl: null }],
    };
    const dependencies = {
      intelligence,
      summarizer,
      analyzerVersion: "checkpoint-v1",
    };

    await assertRejects(
      () =>
        assembleStoryDigest(
          database,
          row.id,
          user,
          [feed],
          0,
          200,
          dependencies,
        ),
      Error,
      "later checkpoint failed",
    );
    const lookups = await Promise.all(stored.map(async (item) => ({
      itemId: item.id,
      fingerprint: await fingerprintStoryItem({
        itemId: item.id,
        feedId: item.feedId,
        feedName: feed.name,
        sourceId: feed.sourceId,
        payload: item.payload,
      }),
    })));
    assertEquals(
      (await listItemAnalyses(database, lookups, "checkpoint-v1")).length,
      10,
    );
    assertEquals(await listDigestStories(database, user.id, row.id), []);
    assertEquals(analyzedBatches, [
      externalIds.slice(0, 10),
      externalIds.slice(10),
    ]);

    failSecondCheckpoint = false;
    const rerun = await assembleStoryDigest(
      database,
      row.id,
      user,
      [feed],
      0,
      200,
      dependencies,
    );
    assertEquals(analyzedBatches, [
      externalIds.slice(0, 10),
      externalIds.slice(10),
      externalIds.slice(10),
    ]);
    assertEquals(
      (await listItemAnalyses(database, lookups, "checkpoint-v1")).length,
      11,
    );
    assertEquals(rerun.hadSummaryFailure, false);
    assertEquals(rerun.stories.length, 1);

    await assertRejects(
      () =>
        assembleStoryDigest(database, row.id, user, [feed], 0, 200, {
          ...dependencies,
          analysisCheckpointSize: 1.5,
        }),
      Error,
      "positive integer",
    );

    let malformedCheckpointCalls = 0;
    const malformedIntelligence = new FixtureIntelligence();
    const validAnalyze = malformedIntelligence.analyze.bind(
      malformedIntelligence,
    );
    malformedIntelligence.analyze = async (items) => {
      malformedCheckpointCalls++;
      const analyses = await validAnalyze(items);
      if (malformedCheckpointCalls === 2) {
        return analyses.map((analysis) => ({
          ...analysis,
          fingerprint: "wrong-fingerprint",
        }));
      }
      return analyses;
    };
    await assertRejects(
      () =>
        assembleStoryDigest(database, row.id, user, [feed], 0, 200, {
          intelligence: malformedIntelligence,
          summarizer,
          analyzerVersion: "malformed-checkpoint-v1",
          analysisCheckpointSize: 2,
        }),
      Error,
      "Invalid analyzer checkpoint output: expected exactly one analysis per input with matching item IDs and fingerprints",
    );
    assertEquals(
      (await listItemAnalyses(database, lookups, "malformed-checkpoint-v1"))
        .length,
      2,
    );
    assertEquals(
      await listItemAnalyses(database, [{
        itemId: stored[2].id,
        fingerprint: "wrong-fingerprint",
      }], "malformed-checkpoint-v1"),
      [],
    );
  });
});

test("default and explicit story caps preserve order under bounded analysis and summary concurrency", async () => {
  await withTestDb(async (database) => {
    const user = await createUser(database, {
      name: "Bounded Owner",
      email: "story-bounds@example.com",
      passwordHash: "$argon2id$fake",
      defaultLanguage: "en",
      systemPrompt: "",
      relevanceThreshold: 0,
      maximumStoriesPerDigest: null,
    });
    const cipher = new CredentialCipher(
      new EnvMasterKeyProvider(new Uint8Array(32).fill(6)),
    );
    const source = await createSource(database, {
      userId: user.id,
      connectorId: ConnectorId.RSS,
      credentials: await cipher.encrypt("{}", {
        userId: user.id,
        connectorId: ConnectorId.RSS,
      }),
    });
    const feed = await createOrReviveFeed(database, {
      userId: user.id,
      sourceId: source.id,
      externalId: "bounded-feed",
      name: "Bounded Feed",
      kind: "news",
    });
    const externalIds = Array.from(
      { length: 25 },
      (_, index) => `item-${String(index).padStart(2, "0")}`,
    );
    await upsertItems(database, feed.id, externalIds.map((externalId, index) => ({
      connectorId: ConnectorId.RSS,
      feedExternalId: feed.externalId,
      externalId,
      date: 100 + index,
      title: externalId,
      text: `Report ${externalId}`,
      author: null,
      url: `https://${externalId}.example/`,
    })), 200);
    const row = await upsertDigestForPeriod(database, {
      userId: user.id,
      periodStartMs: 0,
      periodEndMs: 200,
      status: "pending",
    });

    type Gate = { release: () => void; released: boolean };
    const analysisGates: Gate[] = [];
    const summaryGates: Gate[] = [];
    let gateSignal = Promise.withResolvers<void>();
    const notifyGate = () => {
      gateSignal.resolve();
      gateSignal = Promise.withResolvers<void>();
    };
    let activeAnalysis = 0;
    let maxActiveAnalysis = 0;
    let activeSummaries = 0;
    let maxActiveSummaries = 0;
    const intelligence = new FixtureIntelligence();
    intelligence.splitStories = true;
    const fixtureAnalyze = intelligence.analyze.bind(intelligence);
    intelligence.analyze = async (items) => {
      activeAnalysis++;
      maxActiveAnalysis = Math.max(maxActiveAnalysis, activeAnalysis);
      const deferred = Promise.withResolvers<void>();
      const gate: Gate = {
        released: false,
        release: () => {
          gate.released = true;
          deferred.resolve();
        },
      };
      analysisGates.push(gate);
      notifyGate();
      await deferred.promise;
      activeAnalysis--;
      return await fixtureAnalyze(items);
    };
    const summaryCalls: string[] = [];
    const summarizer: SummarizerService = {
      summarize: async (items) => {
        summaryCalls.push(items[0].externalId);
        activeSummaries++;
        maxActiveSummaries = Math.max(maxActiveSummaries, activeSummaries);
        const deferred = Promise.withResolvers<void>();
        const gate: Gate = {
          released: false,
          release: () => {
            gate.released = true;
            deferred.resolve();
          },
        };
        summaryGates.push(gate);
        notifyGate();
        await deferred.promise;
        activeSummaries--;
        return [{ text: `Summary ${items[0].externalId}`, sourceUrl: null }];
      },
    };
    const releaseUntil = async (gates: Gate[], expected: number) => {
      while (gates.length < expected || gates.some((gate) => !gate.released)) {
        const pending = gates.filter((gate) => !gate.released);
        if (pending.length > 0) {
          pending[pending.length - 1].release();
        } else {
          await gateSignal.promise;
        }
      }
    };
    const dependencies = {
      intelligence,
      summarizer,
      analyzerVersion: "bounded-v1",
      analysisCheckpointSize: 1,
      summaryConcurrency: 3,
    };

    const defaultRun = assembleStoryDigest(
      database,
      row.id,
      user,
      [feed],
      0,
      200,
      dependencies,
    );
    await releaseUntil(analysisGates, 25);
    await releaseUntil(summaryGates, 20);
    const defaultResult = await defaultRun;
    assertEquals(defaultResult.stories.length, 20);
    assertEquals(maxActiveAnalysis, 3);
    assertEquals(maxActiveSummaries, 3);
    assertEquals(
      defaultResult.stories.every((story) =>
        story.points[0].text === `Summary ${story.title.replace("Story ", "")}`
      ),
      true,
    );

    user.maximumStoriesPerDigest = 7;
    user.interestProfileVersion++;
    const previousAnalysisCalls = analysisGates.length;
    const previousSummaryCalls = summaryGates.length;
    const explicitRun = assembleStoryDigest(
      database,
      row.id,
      user,
      [feed],
      0,
      200,
      dependencies,
    );
    await releaseUntil(summaryGates, previousSummaryCalls + 7);
    const explicitResult = await explicitRun;
    assertEquals(analysisGates.length, previousAnalysisCalls);
    assertEquals(explicitResult.stories.length, 7);
    assertEquals(
      explicitResult.stories.every((story) =>
        story.points[0].text === `Summary ${story.title.replace("Story ", "")}`
      ),
      true,
    );
  });
});
