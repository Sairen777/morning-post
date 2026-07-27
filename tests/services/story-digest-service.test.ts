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
import {
  createOrReviveFeed,
  updateFeed,
} from "../../src/repositories/feed-repository.ts";
import { upsertItems } from "../../src/repositories/item-repository.ts";
import { upsertDigestForPeriod } from "../../src/repositories/digest-repository.ts";
import {
  listDigestStories,
  listItemAnalyses,
  replaceDigestStories,
} from "../../src/repositories/story-repository.ts";
import {
  assembleStoryDigest,
  CURRENT_STORY_SUMMARY_VERSION,
  THOROUGH_STORY_SUMMARY_VERSION,
} from "../../src/services/story-digest-service.ts";
import { fingerprintStoryAnalysisMember, fingerprintStoryItem, groupStoryAnalysisUnits, partitionStoryAnalysisUnits } from "../../src/services/story-intelligence-service.ts";
import type {
  AnalyzedStoryItem,
  PersistedStoryCandidate,
  StoryIntelligenceService,
  StoryItemInput,
  StoryIntelligenceOptions,
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
      summaryVersion: CURRENT_STORY_SUMMARY_VERSION,
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
  async analyze(items: StoryItemInput[], options: StoryIntelligenceOptions = {}): Promise<AnalyzedStoryItem[]> {
    this.analyzeCalls++;
    const units = options.analysisUnitSizes === undefined
      ? groupStoryAnalysisUnits(items)
      : partitionStoryAnalysisUnits(items, options.analysisUnitSizes);
    const memberFingerprints = await Promise.all(units.flatMap((unit) =>
      unit.items.map((_, memberIndex) =>
        fingerprintStoryAnalysisMember(unit, memberIndex)
      )
    ));
    let fingerprintIndex = 0;
    const fingerprintByInputIndex = new Map<number, string>();
    units.forEach((unit) => unit.memberIndexes.forEach((inputIndex) => {
      fingerprintByInputIndex.set(inputIndex, memberFingerprints[fingerprintIndex++]!);
    }));
    return await Promise.all(items.map(async (item, index) => ({
      ...item,
      fingerprint: fingerprintByInputIndex.get(index)!,
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
        evidence: [],
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

test("point reuse requires exact story, profile, and summary versions while rebuilding current sources", async () => {
  await withTestDb(async (database) => {
    const user = await createUser(database, {
      name: "Reusable Points Owner",
      email: "story-reusable-points@example.com",
      passwordHash: "$argon2id$fake",
      defaultLanguage: "en",
      systemPrompt: "",
      relevanceThreshold: 0,
    });
    const cipher = new CredentialCipher(
      new EnvMasterKeyProvider(new Uint8Array(32).fill(4)),
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
      externalId: "reusable-points-feed",
      name: "Original Feed",
      kind: "news",
    });
    const reusableItem = {
      connectorId: ConnectorId.RSS,
      feedExternalId: feed.externalId,
      externalId: "reusable-item",
      date: 100,
      title: "Reusable report",
      text: "Original report",
      author: null,
      url: "https://reusable.example/report",
    };
    await upsertItems(database, feed.id, [reusableItem], 100);
    const intelligence = new FixtureIntelligence();
    const summaryCalls: string[] = [];
    const summarizer: SummarizerService = {
      summarize: async (items) => {
        summaryCalls.push(items[0]!.text);
        return [{
          text: `Fresh summary ${summaryCalls.length}`,
          sourceUrl: `https://summary.example/${summaryCalls.length}`,
        }];
      },
    };
    const dependencies = {
      intelligence,
      summarizer,
      analyzerVersion: "reusable-points-v1",
      suppressPreviouslyDelivered: false,
    };
    const seedDigest = await upsertDigestForPeriod(database, {
      userId: user.id,
      periodStartMs: 0,
      periodEndMs: 200,
      status: "complete",
    }, 100);
    const seeded = await assembleStoryDigest(
      database,
      seedDigest.id,
      user,
      [feed],
      0,
      200,
      dependencies,
    );
    assertEquals(summaryCalls, ["Original report"]);
    assertEquals(seeded.stories[0]!.points, [{
      text: "Fresh summary 1",
      sourceUrl: "https://summary.example/1",
    }]);
    const {
      id: _seededId,
      digestId: _seededDigestId,
      profileVersion: seededProfileVersion,
      summaryVersion: _seededSummaryVersion,
      generatedAt: seededGeneratedAt,
      ...seededContent
    } = seeded.stories[0]!;
    const replaceSeedWithLegacyVersion = async () => {
      await replaceDigestStories(database, user.id, seedDigest.id, [{
        content: {
          ...seededContent,
          sources: seededContent.sources.map((storySource) => ({
            ...storySource,
            feedName: "Stale Cached Feed Name",
          })),
        },
        profileVersion: seededProfileVersion,
        summaryVersion: "legacy",
        generatedAt: seededGeneratedAt,
      }]);
    };
    await replaceSeedWithLegacyVersion();
    const [legacySeed] = await listDigestStories(
      database,
      user.id,
      seedDigest.id,
    );
    assertEquals(
      [legacySeed!.summaryVersion, legacySeed!.sources[0]!.feedName],
      ["legacy", "Stale Cached Feed Name"],
    );

    const currentDigestLegacyMiss = await assembleStoryDigest(
      database,
      seedDigest.id,
      user,
      [feed],
      0,
      200,
      dependencies,
    );
    assertEquals(summaryCalls.length, 2);
    assertEquals(
      currentDigestLegacyMiss.stories[0]!.points[0]!.text,
      "Fresh summary 2",
    );
    assertEquals(
      currentDigestLegacyMiss.stories[0]!.summaryVersion,
      CURRENT_STORY_SUMMARY_VERSION,
    );
    assertEquals(
      currentDigestLegacyMiss.stories[0]!.sources[0]!.feedName,
      "Original Feed",
    );

    await replaceSeedWithLegacyVersion();
    const exactDigest = await upsertDigestForPeriod(database, {
      userId: user.id,
      periodStartMs: 0,
      periodEndMs: 201,
      status: "complete",
    }, 200);
    const exact = await assembleStoryDigest(
      database,
      exactDigest.id,
      user,
      [feed],
      0,
      201,
      dependencies,
    );
    assertEquals(summaryCalls.length, 3);
    assertEquals(exact.stories.length, 1);
    assertEquals(exact.stories[0]!.storyId, seeded.stories[0]!.storyId);
    assertEquals(exact.stories[0]!.storyVersion, seeded.stories[0]!.storyVersion);
    assertEquals(exact.stories[0]!.profileVersion, seeded.stories[0]!.profileVersion);
    assertEquals(
      exact.stories[0]!.summaryVersion,
      CURRENT_STORY_SUMMARY_VERSION,
    );
    assertEquals(exact.stories[0]!.points[0]!.text, "Fresh summary 3");
    assertEquals(exact.stories[0]!.sources[0]!.feedName, "Original Feed");

    const currentVersionRerun = await assembleStoryDigest(
      database,
      exactDigest.id,
      user,
      [feed],
      0,
      201,
      dependencies,
    );
    assertEquals(summaryCalls.length, 3);
    assertEquals(currentVersionRerun.stories[0]!.points, exact.stories[0]!.points);
    assertEquals(
      currentVersionRerun.stories[0]!.summaryVersion,
      CURRENT_STORY_SUMMARY_VERSION,
    );

    const newestExactDigest = await upsertDigestForPeriod(database, {
      userId: user.id,
      periodStartMs: 0,
      periodEndMs: 202,
      status: "complete",
    }, 250);
    const newestExact = await assembleStoryDigest(
      database,
      newestExactDigest.id,
      user,
      [feed],
      0,
      202,
      dependencies,
    );
    assertEquals(summaryCalls.length, 3);
    assertEquals(newestExact.stories[0]!.points, exact.stories[0]!.points);
    assertEquals(
      newestExact.stories[0]!.summaryVersion,
      CURRENT_STORY_SUMMARY_VERSION,
    );

    user.interestProfileVersion++;
    const profileMismatchDigest = await upsertDigestForPeriod(database, {
      userId: user.id,
      periodStartMs: 0,
      periodEndMs: 203,
      status: "complete",
    }, 300);
    const profileMismatch = await assembleStoryDigest(
      database,
      profileMismatchDigest.id,
      user,
      [feed],
      0,
      203,
      dependencies,
    );
    assertEquals(summaryCalls.length, 4);
    assertEquals(profileMismatch.stories[0]!.storyVersion, seeded.stories[0]!.storyVersion);
    assertEquals(profileMismatch.stories[0]!.profileVersion, user.interestProfileVersion);
    assertEquals(
      profileMismatch.stories[0]!.summaryVersion,
      CURRENT_STORY_SUMMARY_VERSION,
    );
    assertEquals(profileMismatch.stories[0]!.points[0]!.text, "Fresh summary 4");

    await upsertItems(database, feed.id, [{
      ...reusableItem,
      text: "Materially updated report",
    }], 400);
    const versionMismatchDigest = await upsertDigestForPeriod(database, {
      userId: user.id,
      periodStartMs: 0,
      periodEndMs: 204,
      status: "complete",
    }, 400);
    const versionMismatch = await assembleStoryDigest(
      database,
      versionMismatchDigest.id,
      user,
      [feed],
      0,
      204,
      dependencies,
    );
    assertEquals(summaryCalls.length, 5);
    assertEquals(
      versionMismatch.stories[0]!.storyVersion,
      seeded.stories[0]!.storyVersion + 1,
    );
    assertEquals(versionMismatch.stories[0]!.profileVersion, user.interestProfileVersion);
    assertEquals(
      versionMismatch.stories[0]!.summaryVersion,
      CURRENT_STORY_SUMMARY_VERSION,
    );
    assertEquals(versionMismatch.stories[0]!.points[0]!.text, "Fresh summary 5");
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
      analysisCheckpointSize: 10,
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
    const storedInputs: StoryItemInput[] = stored.map((item) => ({
      itemId: item.id,
      feedId: item.feedId,
      feedName: feed.name,
      sourceId: feed.sourceId,
      payload: item.payload,
    }));
    const storedUnits = groupStoryAnalysisUnits(storedInputs);
    const storedMemberFingerprints = await Promise.all(storedUnits.flatMap((unit) =>
      unit.items.map((_, memberIndex) =>
        fingerprintStoryAnalysisMember(unit, memberIndex)
      )
    ));
    let storedFpIndex = 0;
    const storedFingerprintByItemId = new Map<string, string>();
    storedUnits.forEach((unit) => unit.items.forEach((item) =>
      storedFingerprintByItemId.set(item.itemId, storedMemberFingerprints[storedFpIndex++]!)
    ));
    const lookups = stored.map((item) => ({
      itemId: item.id,
      fingerprint: storedFingerprintByItemId.get(item.id)!,
    }));
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
    await releaseUntil(summaryGates, 12);
    const defaultResult = await defaultRun;
    assertEquals(defaultResult.stories.length, 12);
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
test("cached story cards are skipped before batch packing and batch concurrency stays bounded", async () => {
  await withTestDb(async (database) => {
    const user = await createUser(database, {
      name: "Cache-bounded Owner",
      email: "story-cache-bounded@example.com",
      passwordHash: "$argon2id$fake",
      defaultLanguage: "en",
      systemPrompt: "",
      relevanceThreshold: 0,
      maximumStoriesPerDigest: 15,
    });
    const cipher = new CredentialCipher(
      new EnvMasterKeyProvider(new Uint8Array(32).fill(5)),
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
      externalId: "cache-bounded-feed",
      name: "Cache Bounded Feed",
      kind: "news",
    });
    const makeItem = (index: number) => {
      const externalId = `item-${String(index).padStart(2, "0")}`;
      return {
        connectorId: ConnectorId.RSS,
        feedExternalId: feed.externalId,
        externalId,
        date: 100 + index,
        title: `Title ${externalId}`,
        text: `Report ${externalId}`,
        author: null,
        url: `https://${externalId}.example/`,
      };
    };
    const digest = await upsertDigestForPeriod(database, {
      userId: user.id,
      periodStartMs: 0,
      periodEndMs: 1_000,
      status: "pending",
    });
    const intelligence = new FixtureIntelligence();
    intelligence.splitStories = true;
    const seedCalls: string[][] = [];
    const seedSummarizer: SummarizerService = {
      summarize: async () => {
        throw new Error("unexpected single-story summarization");
      },
      summarizeBatch: async (stories) => {
        seedCalls.push(stories.map((story) => story.storyId));
        return stories.map(({ storyId, items }) => {
          const externalId = items[0]!.externalId;
          return {
            storyId,
            points: [{
              text: `Seed summary ${externalId}`,
              sourceUrl: `https://seed.example/${externalId}`,
            }],
          };
        });
      },
    };
    await upsertItems(database, feed.id, [0, 1, 2].map(makeItem), 200);
    const seedResult = await assembleStoryDigest(
      database,
      digest.id,
      user,
      [feed],
      0,
      1_000,
      {
        intelligence,
        summarizer: seedSummarizer,
        analyzerVersion: "batch-cache-v1",
        summaryConcurrency: 2,
      },
    );
    assertEquals(seedCalls.length, 1);
    assertEquals(seedCalls[0].length, 3);
    const seededStories = new Map(seedResult.stories.map((story) => [story.storyId, story]));

    await upsertItems(database, feed.id, Array.from({ length: 12 }, (_, index) => makeItem(index + 3)), 300);
    type Gate = { release: () => void; released: boolean };
    const rerunCalls: string[][] = [];
    const rerunGates: Gate[] = [];
    let activeBatchCalls = 0;
    let maxActiveBatchCalls = 0;
    let gateSignal = Promise.withResolvers<void>();
    const notifyGate = () => {
      gateSignal.resolve();
      gateSignal = Promise.withResolvers<void>();
    };
    const rerunSummarizer: SummarizerService = {
      summarize: async () => {
        throw new Error("unexpected single-story summarization");
      },
      summarizeBatch: async (stories) => {
        rerunCalls.push(stories.map((story) => story.storyId));
        activeBatchCalls++;
        maxActiveBatchCalls = Math.max(maxActiveBatchCalls, activeBatchCalls);
        const deferred = Promise.withResolvers<void>();
        const gate: Gate = {
          released: false,
          release: () => {
            gate.released = true;
            deferred.resolve();
          },
        };
        rerunGates.push(gate);
        notifyGate();
        await deferred.promise;
        activeBatchCalls--;
        return stories.map(({ storyId, items }) => {
          const externalId = items[0]!.externalId;
          return {
            storyId,
            points: [{
              text: `Batch summary ${externalId}`,
              sourceUrl: `https://batch.example/${externalId}`,
            }],
          };
        });
      },
    };
    const waitForCalls = async (count: number) => {
      while (rerunCalls.length < count) {
        await gateSignal.promise;
        if (rerunCalls.length < count) {
          await Promise.resolve();
          await Promise.resolve();
          if (rerunCalls.length < count && rerunGates.some((gate) => !gate.released)) {
            rerunGates.find((gate) => !gate.released)?.release();
          }
        }
      }
    };
    const rerunPromise = assembleStoryDigest(
      database,
      digest.id,
      user,
      [feed],
      0,
      1_000,
      {
        intelligence,
        summarizer: rerunSummarizer,
        analyzerVersion: "batch-cache-v1",
        summaryConcurrency: 2,
      },
    );
    await waitForCalls(2);
    assertEquals(maxActiveBatchCalls, 2);
    rerunGates.find((gate) => !gate.released)?.release();
    await waitForCalls(3);
    while (rerunGates.some((gate) => !gate.released)) {
      rerunGates.find((gate) => !gate.released)?.release();
    }
    const rerunResult = await rerunPromise;
    assertEquals(rerunResult.stories.length, 15);
    assertEquals(rerunCalls.length, 3);
    assertEquals(rerunCalls.map((call) => call.length), [5, 5, 2]);
    assertEquals(
      rerunCalls.flat().some((storyId) => seededStories.has(storyId)),
      false,
    );
    assertEquals(new Set(rerunCalls.flat()).size, 12);
    for (const story of rerunResult.stories) {
      const externalId = story.title.replace("Story ", "");
      const expectedSourceUrl = `https://${externalId}.example/`;
      const sourceUrl = story.sources[0]!.url;
      assertEquals(sourceUrl, expectedSourceUrl);
      if (seededStories.has(story.storyId)) {
        const seededStory = seededStories.get(story.storyId)!;
        assertEquals(story.points[0]!.text, seededStory.points[0]!.text);
        assertEquals(story.points[0]!.sourceUrl, seededStory.points[0]!.sourceUrl);
      } else {
        assertEquals(story.points[0]!.text, `Batch summary ${externalId}`);
        assertEquals(
          story.points[0]!.sourceUrl,
          `https://batch.example/${externalId}`,
        );
      }
    }
    await upsertItems(database, feed.id, [{
      ...makeItem(3),
      text: "Updated report item-03",
    }], 400);
    let failedBatchCalls = 0;
    let isolatedFallbackCalls = 0;
    const fallbackSummarizer: SummarizerService = {
      summarizeBatch: async (stories) => {
        failedBatchCalls++;
        return stories.map(({ storyId }) => ({
          storyId,
          error: new Error("provider omitted the batch member"),
        }));
      },
      summarize: async (items) => {
        isolatedFallbackCalls++;
        return [{
          text: `Isolated recovery ${items[0]!.externalId}`,
          sourceUrl: items[0]!.url,
        }];
      },
    };
    const recovered = await assembleStoryDigest(
      database,
      digest.id,
      user,
      [feed],
      0,
      1_000,
      {
        intelligence,
        summarizer: fallbackSummarizer,
        analyzerVersion: "batch-cache-v1",
        summaryConcurrency: 2,
      },
    );
    assertEquals(failedBatchCalls, 1);
    assertEquals(isolatedFallbackCalls, 1);
    assertEquals(recovered.hadSummaryFailure, false);
    assertEquals(recovered.summaryFailureReason, null);
    assertEquals(
      recovered.stories.some((story) =>
        story.points[0]?.text === "Isolated recovery item-03"
      ),
      true,
    );
  });
});

test("cached separators preserve rootless discussion unit boundaries", async () => {
  await withTestDb(async (database) => {
    const user = await createUser(database, {
      name: "Rootless Boundary Owner",
      email: "rootless-boundary@example.com",
      passwordHash: "$argon2id$fake",
      defaultLanguage: "en",
      systemPrompt: "",
      summaryPrompt: "",
      relevanceThreshold: 0,
    });
    const source = await createSource(database, {
      userId: user.id,
      connectorId: ConnectorId.Telegram,
      credentials: await new CredentialCipher(
        new EnvMasterKeyProvider(new Uint8Array(32).fill(6)),
      ).encrypt("{}", {
        userId: user.id,
        connectorId: ConnectorId.Telegram,
      }),
    });
    const feed = await createOrReviveFeed(database, {
      userId: user.id,
      sourceId: source.id,
      externalId: "rootless-boundary-feed",
      name: "Rootless Boundary Feed",
      kind: "discussion",
    });
    const makeItem = (
      externalId: string,
      date: number,
      author: string,
    ) => ({
      connectorId: ConnectorId.Telegram,
      feedExternalId: feed.externalId,
      externalId,
      date,
      title: externalId,
      text: `Message ${externalId}`,
      author,
      url: `https://t.me/rootless/${externalId}`,
      meta: { isGroup: true },
    });
    await upsertItems(
      database,
      feed.id,
      [makeItem("separator-b", 110, "author-y")],
      200,
    );
    const digest = await upsertDigestForPeriod(database, {
      userId: user.id,
      periodStartMs: 0,
      periodEndMs: 1_000,
      status: "pending",
    });
    const intelligence = new FixtureIntelligence();
    const observedUnitSizes: number[][] = [];
    const analyze = intelligence.analyze.bind(intelligence);
    intelligence.analyze = async (items, options = {}) => {
      observedUnitSizes.push([...(options.analysisUnitSizes ?? [])]);
      return await analyze(items, options);
    };
    const summarizer: SummarizerService = {
      summarize: async () => [{
        text: "Discussion summary",
        sourceUrl: null,
      }],
    };
    await assembleStoryDigest(
      database,
      digest.id,
      user,
      [feed],
      0,
      1_000,
      { intelligence, summarizer, analyzerVersion: "rootless-v1" },
    );
    await upsertItems(database, feed.id, [
      makeItem("miss-a", 100, "author-x"),
      makeItem("miss-c", 120, "author-x"),
    ], 300);
    const rerun = await assembleStoryDigest(
      database,
      digest.id,
      user,
      [feed],
      0,
      1_000,
      { intelligence, summarizer, analyzerVersion: "rootless-v1" },
    );
    assertEquals(rerun.hadSummaryFailure, false);
    assertEquals(observedUnitSizes, [[1], [1, 1]]);
    assertEquals(intelligence.analyzeCalls, 2);
  });
});

test("same-source feed summary modes isolate thorough stories and key cache reuse", async () => {
  await withTestDb(async (database) => {
    const user = await createUser(database, {
      name: "Summary Mode Owner",
      email: "story-summary-mode@example.com",
      passwordHash: "$argon2id$fake",
      defaultLanguage: "en",
      systemPrompt: "",
      summaryPrompt: "Keep concrete source distinctions.",
      relevanceThreshold: 0,
    });
    const cipher = new CredentialCipher(
      new EnvMasterKeyProvider(new Uint8Array(32).fill(8)),
    );
    const sharedSource = await createSource(database, {
      userId: user.id,
      connectorId: ConnectorId.Telegram,
      credentials: await cipher.encrypt("{}", {
        userId: user.id,
        connectorId: ConnectorId.Telegram,
      }),
    });
    const basicFeed = await createOrReviveFeed(database, {
      userId: user.id,
      sourceId: sharedSource.id,
      externalId: "summary-mode-basic",
      name: "Basic feed",
      kind: "news",
      summarizationMode: "basic",
    });
    let switchingFeed = await createOrReviveFeed(database, {
      userId: user.id,
      sourceId: sharedSource.id,
      externalId: "summary-mode-switching",
      name: "Switching discussion",
      kind: "discussion",
      summarizationMode: "basic",
    });
    assertEquals(basicFeed.sourceId, switchingFeed.sourceId);
    const longDiscussionText = `Minority view with supporting detail: ${
      "material chronology and caveat ".repeat(320)
    }`;
    await upsertItems(database, basicFeed.id, [
      {
        connectorId: ConnectorId.Telegram,
        feedExternalId: basicFeed.externalId,
        externalId: "basic-only",
        date: 100,
        title: "Basic only",
        text: "A routine basic story.",
        author: null,
        url: "https://basic.example/only",
      },
      {
        connectorId: ConnectorId.Telegram,
        feedExternalId: basicFeed.externalId,
        externalId: "mixed-basic",
        date: 120,
        title: "Mixed context",
        text: "The first source reports the initial development.",
        author: null,
        url: "https://basic.example/mixed",
      },
    ], 200);
    await upsertItems(database, switchingFeed.id, [
      {
        connectorId: ConnectorId.Telegram,
        feedExternalId: switchingFeed.externalId,
        externalId: "switch-only",
        date: 110,
        title: "Switch only",
        text: "A standalone discussion report.",
        author: "Reporter",
        url: "https://t.me/summary-mode/1",
        meta: { isGroup: true },
      },
      {
        connectorId: ConnectorId.Telegram,
        feedExternalId: switchingFeed.externalId,
        externalId: "mixed-thorough",
        date: 130,
        title: "Mixed disagreement",
        text: longDiscussionText,
        author: "Dissenting participant",
        url: "https://t.me/summary-mode/2",
        meta: { isGroup: true },
      },
    ], 200);

    const intelligence = new FixtureIntelligence();
    intelligence.resolve = async (items) => {
      const itemByExternalId = new Map(
        items.map((item) => [item.payload.externalId, item]),
      );
      const makeStory = (
        canonicalKey: string,
        title: string,
        externalIds: string[],
      ) => ({
        canonicalKey,
        title,
        topics: ["technology"],
        entities: ["Example"],
        developments: externalIds.map((externalId) => {
          const item = itemByExternalId.get(externalId)!;
          return {
            canonicalKey: `development-${externalId}`,
            type: "report",
            title: item.payload.title ?? externalId,
            occurredAt: item.payload.date,
            items: [item],
          };
        }),
      });
      return [
        makeStory("mode-basic", "Basic-only story", ["basic-only"]),
        makeStory("mode-switch", "Switch-only story", ["switch-only"]),
        makeStory("mode-mixed", "Mixed-feed story", [
          "mixed-basic",
          "mixed-thorough",
        ]),
      ];
    };
    const batchCalls: string[][][] = [];
    const singleCalls: Array<{
      externalIds: string[];
      texts: string[];
      systemPrompt: string;
      maxItemsPerChunk: number | undefined;
      maxTextBytesPerChunk: number | undefined;
    }> = [];
    const summarizer: SummarizerService = {
      summarizeBatch: async (stories) => {
        batchCalls.push(stories.map((story) =>
          story.items.map((item) => item.externalId)
        ));
        return stories.map((story) => ({
          storyId: story.storyId,
          points: [{
            text: `Standard ${story.items.map((item) => item.externalId).join("+")}`,
            sourceUrl: story.items[0]!.url,
          }],
        }));
      },
      summarize: async (items, rules, options) => {
        singleCalls.push({
          externalIds: items.map((item) => item.externalId),
          texts: items.map((item) => item.text),
          systemPrompt: rules.systemPrompt,
          maxItemsPerChunk: options?.maxItemsPerChunk,
          maxTextBytesPerChunk: options?.maxTextBytesPerChunk,
        });
        return [{
          text: `Thorough ${items.map((item) => item.externalId).join("+")}`,
          sourceUrl: items[0]!.url,
        }];
      },
    };
    const dependencies = {
      intelligence,
      summarizer,
      analyzerVersion: "summary-mode-v1",
      suppressPreviouslyDelivered: false,
    };
    const createAndAssemble = async (periodEndMs: number, createdAt: number) => {
      const digest = await upsertDigestForPeriod(database, {
        userId: user.id,
        periodStartMs: 0,
        periodEndMs,
        status: "complete",
      }, createdAt);
      const result = await assembleStoryDigest(
        database,
        digest.id,
        user,
        [basicFeed, switchingFeed],
        0,
        periodEndMs,
        dependencies,
      );
      return { digest, result };
    };

    const seed = await createAndAssemble(1_000, 300);
    assertEquals(batchCalls.length, 1);
    assertEquals(
      batchCalls[0]!.map((members) => members.join("+")).sort(),
      ["basic-only", "mixed-basic+mixed-thorough", "switch-only"],
    );
    assertEquals(singleCalls.length, 0);
    assertEquals(
      seed.result.stories.every((story) =>
        story.summaryVersion === CURRENT_STORY_SUMMARY_VERSION
      ),
      true,
    );
    const seedByTitle = new Map(
      seed.result.stories.map((story) => [story.title, story]),
    );
    const sameModeReuse = await createAndAssemble(1_001, 350);
    assertEquals(batchCalls.length, 1);
    assertEquals(singleCalls.length, 0);
    let failedThoroughCalls = 0;
    let failedBasicBatchCalls = 0;
    switchingFeed = await updateFeed(
      database,
      switchingFeed.id,
      user.id,
      { summarizationMode: "thorough" },
    );
    assertEquals(
      [basicFeed.summarizationMode, switchingFeed.summarizationMode],
      ["basic", "thorough"],
    );
    const failedModeChange = await assembleStoryDigest(
      database,
      sameModeReuse.digest.id,
      user,
      [basicFeed, switchingFeed],
      0,
      1_001,
      {
        ...dependencies,
        summarizer: {
          summarize: async () => {
            failedThoroughCalls++;
            throw new Error("thorough summary failed");
          },
          summarizeBatch: async () => {
            failedBasicBatchCalls++;
            throw new Error("unexpected basic batch");
          },
        },
      },
    );
    assertEquals(failedModeChange.hadSummaryFailure, true);
    assertEquals(failedThoroughCalls, 2);
    assertEquals(failedBasicBatchCalls, 0);
    assertEquals(
      failedModeChange.stories.map((story) => story.title),
      ["Basic-only story"],
    );
    assertEquals(
      failedModeChange.stories[0]!.summaryVersion,
      CURRENT_STORY_SUMMARY_VERSION,
    );

    const thorough = await createAndAssemble(1_002, 400);
    assertEquals(batchCalls.length, 1);
    assertEquals(
      singleCalls.map((call) => call.externalIds.join("+")).sort(),
      ["mixed-basic+mixed-thorough", "switch-only"],
    );
    assertEquals(
      singleCalls.every((call) =>
        call.systemPrompt.includes("comprehensive, faithful summary") &&
        call.systemPrompt.includes("Keep concrete source distinctions.") &&
        call.maxItemsPerChunk === undefined &&
        call.maxTextBytesPerChunk === undefined
      ),
      true,
    );
    const mixedCall = singleCalls.find((call) =>
      call.externalIds.includes("mixed-thorough")
    )!;
    assertEquals(
      mixedCall.texts[mixedCall.externalIds.indexOf("mixed-thorough")],
      longDiscussionText,
    );
    const thoroughByTitle = new Map(
      thorough.result.stories.map((story) => [story.title, story]),
    );
    assertEquals(
      thoroughByTitle.get("Basic-only story")!.summaryVersion,
      CURRENT_STORY_SUMMARY_VERSION,
    );
    assertEquals(
      thoroughByTitle.get("Basic-only story")!.points,
      seedByTitle.get("Basic-only story")!.points,
    );
    assertEquals(
      thoroughByTitle.get("Switch-only story")!.summaryVersion,
      THOROUGH_STORY_SUMMARY_VERSION,
    );
    assertEquals(
      thoroughByTitle.get("Mixed-feed story")!.summaryVersion,
      THOROUGH_STORY_SUMMARY_VERSION,
    );

    await assembleStoryDigest(
      database,
      thorough.digest.id,
      user,
      [basicFeed, switchingFeed],
      0,
      1_002,
      dependencies,
    );
    assertEquals(batchCalls.length, 1);
    assertEquals(singleCalls.length, 2);

    switchingFeed = await updateFeed(
      database,
      switchingFeed.id,
      user.id,
      { summarizationMode: "basic" },
    );
    const reverted = await createAndAssemble(1_003, 500);
    assertEquals(batchCalls.length, 1);
    assertEquals(singleCalls.length, 2);
    assertEquals(
      reverted.result.stories.every((story) =>
        story.summaryVersion === CURRENT_STORY_SUMMARY_VERSION &&
        story.points[0]!.text === seedByTitle.get(story.title)!.points[0]!.text
      ),
      true,
    );
  });
});
