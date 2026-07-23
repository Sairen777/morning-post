import { test } from "bun:test";
import { assertEquals, assertStringIncludes } from "../assertions.ts";
import { ConnectorId } from "../../src/constants.ts";
import { CredentialCipher } from "../../src/crypto/credential-cipher.ts";
import { EnvMasterKeyProvider } from "../../src/crypto/key-provider.ts";
import { withTestDb } from "../../src/db/testing.ts";
import { createOrReviveFeed, softDeleteFeed } from "../../src/repositories/feed-repository.ts";
import { upsertItems } from "../../src/repositories/item-repository.ts";
import { setDigestContentMode, upsertDigestForPeriod } from "../../src/repositories/digest-repository.ts";
import { upsertSummaryForPeriod } from "../../src/repositories/summary-repository.ts";
import { createSource } from "../../src/repositories/source-repository.ts";
import { createUser } from "../../src/repositories/user-repository.ts";
import { assembleDigestForPeriod, buildDigestViewById, renderDigestMarkdown } from "../../src/services/digest-service.ts";
import { fingerprintStoryItem } from "../../src/services/story-intelligence-service.ts";
import type { AnalyzedStoryItem, PersistedStoryCandidate, StoryIntelligenceService, StoryItemInput, StoryPreferenceRule } from "../../src/personalization/story.types.ts";
import type { SummarizerService } from "../../src/summarizers/summarizer.types.ts";

const start = 1_700_000_000_000;
const end = start + 86_400_000;

class FixtureIntelligence implements StoryIntelligenceService {
  async analyze(items: StoryItemInput[]): Promise<AnalyzedStoryItem[]> {
    return await Promise.all(items.map(async (item) => ({
      ...item,
      fingerprint: await fingerprintStoryItem(item),
      analysis: { language: "en", canonicalUrls: item.payload.url ? [item.payload.url] : [], topics: ["news"], entities: [], storyKey: "shared-story", storyTitle: "Shared Story", developmentKey: item.payload.externalId, developmentType: "report", developmentTitle: item.payload.title ?? "Report", mediaDescription: null },
    })));
  }
  async resolve(items: AnalyzedStoryItem[]) {
    return [{ canonicalKey: "shared-story", title: "Shared Story", topics: ["news"], entities: [], developments: items.map((item) => ({ canonicalKey: item.payload.externalId, type: "report", title: item.payload.title ?? "Report", occurredAt: item.payload.date, items: [item] })) }];
  }
  async classify(stories: PersistedStoryCandidate[], _rules: StoryPreferenceRule[], _threshold: number) {
    return stories.map((story) => ({ storyId: story.id, relevant: true, score: 90, matchedInterestRuleIds: [], blockedByInterestRuleIds: [], reason: "fixture" }));
  }
}

const summarizer: SummarizerService = {
  summarize: async () => [{ text: "Combined development", sourceUrl: null }],
};

async function fixtureSource(database: Parameters<typeof createUser>[0], userId: string, connectorId: ConnectorId) {
  const cipher = new CredentialCipher(new EnvMasterKeyProvider(new Uint8Array(32).fill(7)));
  return await createSource(database, { userId, connectorId, credentials: await cipher.encrypt("{}", { userId, connectorId }) });
}

async function fixtureUser(database: Parameters<typeof createUser>[0], email: string) {
  return await createUser(database, { name: "Owner", email, passwordHash: "$argon2id$fake", systemPrompt: "Summarize tersely.", defaultLanguage: "en", relevanceThreshold: 0 });
}

test("assembleDigestForPeriod creates a story digest with multi-source provenance and Markdown", async () => {
  await withTestDb(async (database) => {
    const user = await fixtureUser(database, "story-digest@example.com");
    const telegram = await fixtureSource(database, user.id, ConnectorId.Telegram);
    const rss = await fixtureSource(database, user.id, ConnectorId.RSS);
    const first = await createOrReviveFeed(database, { userId: user.id, sourceId: telegram.id, externalId: "telegram", name: "Telegram", kind: "news" });
    const second = await createOrReviveFeed(database, { userId: user.id, sourceId: rss.id, externalId: "rss", name: "RSS", kind: "news" });
    await upsertItems(database, first.id, [{ connectorId: ConnectorId.Telegram, feedExternalId: first.externalId, externalId: "one", date: start + 1, title: "Report one", text: "First report", author: null, url: "https://one.example/report" }], start + 2);
    await upsertItems(database, second.id, [{ connectorId: ConnectorId.RSS, feedExternalId: second.externalId, externalId: "two", date: start + 1, title: "Report two", text: "Second report", author: null, url: "https://two.example/report" }], start + 2);

    const view = await assembleDigestForPeriod(database, user.id, start, end, { intelligence: new FixtureIntelligence(), summarizer, now: () => end });

    assertEquals(view.digest.contentMode, "stories");
    assertEquals(view.digest.status, "complete");
    assertEquals(view.sections, []);
    assertEquals(view.stories.length, 1);
    assertEquals(view.stories[0].sources.map((source) => source.feedName), ["RSS", "Telegram"]);
    const markdown = renderDigestMarkdown(view);
    assertStringIncludes(markdown, "## Shared Story");
    assertStringIncludes(markdown, "https://one.example/report");
    assertStringIncludes(markdown, "https://two.example/report");
  });
});

test("buildDigestViewById reads explicitly legacy summaries after their feed is removed", async () => {
  await withTestDb(async (database) => {
    const user = await fixtureUser(database, "legacy-digest@example.com");
    const source = await fixtureSource(database, user.id, ConnectorId.Telegram);
    const feed = await createOrReviveFeed(database, { userId: user.id, sourceId: source.id, externalId: "legacy", name: "Legacy Feed", kind: "news" });
    await upsertSummaryForPeriod(database, { feedId: feed.id, periodStartMs: start, periodEndMs: end, feedNameSnapshot: feed.name, content: { kind: "aggregate", points: [{ text: "Historical summary", sourceUrl: null }] } }, end);
    const digest = await upsertDigestForPeriod(database, { userId: user.id, periodStartMs: start, periodEndMs: end, status: "complete" }, end);
    await setDigestContentMode(database, digest.id, user.id, "legacy", end);
    await softDeleteFeed(database, feed.id, user.id);

    const view = await buildDigestViewById(database, user.id, digest.id);
    assertEquals(view.digest.contentMode, "legacy");
    assertEquals(view.stories, []);
    assertEquals(view.sections[0].feedRemoved, true);
    assertEquals(view.sections[0].content, { kind: "aggregate", points: [{ text: "Historical summary", sourceUrl: null }] });
    assertStringIncludes(renderDigestMarkdown(view), "### Legacy Feed (removed)");
  });
});
