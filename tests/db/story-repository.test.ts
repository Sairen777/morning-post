import { test } from "bun:test";
import { and, eq } from "drizzle-orm";
import { assertEquals } from "../assertions.ts";
import { ConnectorId } from "../../src/constants.ts";
import type { NormalizedItem } from "../../src/connectors/connector.types.ts";
import { CredentialCipher, type EncryptedBlob } from "../../src/crypto/credential-cipher.ts";
import { EnvMasterKeyProvider } from "../../src/crypto/key-provider.ts";
import type { Database } from "../../src/db/client.ts";
import { digests } from "../../src/db/schema/digest.ts";
import { stories, storyDevelopments } from "../../src/db/schema/story.ts";
import { withTestDb } from "../../src/db/testing.ts";
import type { ResolvedStoryCandidate } from "../../src/personalization/story.types.ts";
import { upsertDigestForPeriod } from "../../src/repositories/digest-repository.ts";
import { createOrReviveFeed } from "../../src/repositories/feed-repository.ts";
import { upsertItems } from "../../src/repositories/item-repository.ts";
import { createSource } from "../../src/repositories/source-repository.ts";
import {
  findLatestDeliveredStoryVersion,
  findLatestDeliveredStoryVersions,
  listItemAnalyses,
  listRecentStoryReferences,
  listDigestStories,
  listStoryMembers,
  replaceDigestStories,
  upsertResolvedStory,
  upsertResolvedStories,
  upsertItemAnalyses,
} from "../../src/repositories/story-repository.ts";
import { createUser } from "../../src/repositories/user-repository.ts";

function cipher(): CredentialCipher {
  return new CredentialCipher(new EnvMasterKeyProvider(new Uint8Array(32).fill(19)));
}
async function credentials(userId: string): Promise<EncryptedBlob> {
  return cipher().encrypt(JSON.stringify({ sessionString: "session" }), { userId, connectorId: ConnectorId.Telegram });
}
async function fixture(database: Database, email: string, itemCount = 2) {
  const user = await createUser(database, { name: "Story Owner", email, passwordHash: "$argon2id$fake", systemPrompt: "Be concise", defaultLanguage: "en" });
  const source = await createSource(database, { userId: user.id, connectorId: ConnectorId.Telegram, credentials: await credentials(user.id) });
  const feed = await createOrReviveFeed(database, { userId: user.id, sourceId: source.id, externalId: `feed:${email}`, name: "News", kind: "news" });
  const payloads: NormalizedItem[] = Array.from({ length: itemCount }, (_, index) => ({ connectorId: ConnectorId.Telegram, feedExternalId: feed.externalId, externalId: `item:${index}`, date: 1_700_000_000_000 + index, title: `Item ${index}`, text: `Text ${index}`, author: "News", url: `https://example.test/${index}` }));
  const stored = await upsertItems(database, feed.id, payloads, 1_700_000_001_000);
  return { user, source, feed, stored };
}
function candidate(f: Awaited<ReturnType<typeof fixture>>, storyKey = "Election 2026", assignments: Array<{ item: number; development: string; fingerprint?: string }> = [{ item: 0, development: "announcement" }]): ResolvedStoryCandidate {
  const grouped = new Map<string, typeof assignments>();
  for (const assignment of assignments) grouped.set(assignment.development, [...(grouped.get(assignment.development) ?? []), assignment]);
  return {
    canonicalKey: storyKey,
    title: storyKey,
    topics: ["politics"],
    entities: ["Example"],
    developments: [...grouped].map(([key, members], developmentIndex) => ({
      canonicalKey: key,
      type: "update",
      title: key,
      occurredAt: 1_700_000_000_000 + developmentIndex,
      items: members.map(({ item, fingerprint = `fp-${item}` }) => ({
        itemId: f.stored[item].id,
        feedId: f.feed.id,
        feedName: f.feed.name,
        sourceId: f.source.id,
        fingerprint,
        payload: f.stored[item].payload,
        analysis: { language: "en", canonicalUrls: [], topics: ["politics"], entities: ["Example"], storyKey, storyTitle: storyKey, developmentKey: key, developmentType: "update", developmentTitle: key, mediaDescription: null },
      })),
    })),
  };
}

async function version(database: Database, userId: string, canonicalKey: string) {
  return (await database.select().from(stories).where(and(eq(stories.userId, userId), eq(stories.canonicalKey, canonicalKey))).limit(1))[0];
}

test("item analysis batch writes once and returns only exact cache hits", async () => {
  await withTestDb(async (database) => {
    const f = await fixture(database, "story-analysis-batch@example.com");
    const analysis = { language: "en", canonicalUrls: [], topics: ["politics"], entities: ["Example"], storyKey: "story", storyTitle: "Story", developmentKey: "update", developmentType: "update", developmentTitle: "Update", mediaDescription: null };
    assertEquals(await upsertItemAnalyses(database, []), []);
    const written = await upsertItemAnalyses(database, [
      { itemId: f.stored[0].id, fingerprint: "fp-0", analyzerVersion: "v1", analysis, analyzedAt: 100 },
      { itemId: f.stored[1].id, fingerprint: "fp-1", analyzerVersion: "v1", analysis, analyzedAt: 101 },
    ]);
    assertEquals(written.map((value) => value.itemId), [f.stored[0].id, f.stored[1].id]);
    const hits = await listItemAnalyses(database, [
      { itemId: f.stored[0].id, fingerprint: "fp-0" },
      { itemId: f.stored[1].id, fingerprint: "stale" },
    ], "v1");
    assertEquals(hits.map((value) => [value.itemId, value.fingerprint]), [[f.stored[0].id, "fp-0"]]);
    assertEquals(await listItemAnalyses(database, [{ itemId: f.stored[0].id, fingerprint: "fp-0" }], "v2"), []);
    assertEquals(await listItemAnalyses(database, [], "v1"), []);
  });
});

test("recent story references are bounded, ordered, and user scoped", async () => {
  await withTestDb(async (database) => {
    const f = await fixture(database, "story-references@example.com", 0);
    await upsertResolvedStory(database, f.user.id, { canonicalKey: "older", title: "Older", topics: ["one"], entities: ["A"], developments: [] }, 100);
    await upsertResolvedStory(database, f.user.id, { canonicalKey: "newer", title: "Newer", topics: ["two"], entities: ["B"], developments: [] }, 200);
    const other = await fixture(database, "story-references-other@example.com", 0);
    await upsertResolvedStory(database, other.user.id, { canonicalKey: "foreign", title: "Foreign", topics: [], entities: [], developments: [] }, 300);
    const references = await listRecentStoryReferences(database, f.user.id, { since: 100, limit: 2 });
    assertEquals(references.map((story) => [story.canonicalKey, story.topics, story.entities, story.lastUpdatedAt]), [
      ["newer", ["two"], ["B"], 200],
      ["older", ["one"], ["A"], 100],
    ]);
    assertEquals((await listRecentStoryReferences(database, f.user.id, { limit: 1 })).map((story) => story.canonicalKey), ["newer"]);
  });
});

test("story batch persists hundreds of one-item stories idempotently in input order", async () => {
  await withTestDb(async (database) => {
    const f = await fixture(database, "story-batch@example.com", 200);
    const candidates = f.stored.map((_, index) => candidate(f, `Batch Story ${index}`, [{ item: index, development: "update" }]));
    assertEquals(await upsertResolvedStories(database, f.user.id, []), []);
    const first = await upsertResolvedStories(database, f.user.id, candidates, 100);
    assertEquals(first.map((story) => [story.candidate.canonicalKey, story.version]), candidates.map((story) => [story.canonicalKey.toLowerCase().replaceAll(" ", "-"), 1]));
    const replay = await upsertResolvedStories(database, f.user.id, candidates, 200);
    assertEquals(replay.map((story) => [story.id, story.version]), first.map((story) => [story.id, 1]));
  });
});

// This sequence deliberately exercises the interactions in one transactionally isolated fixture:
// initial persistence, replay, development growth, fingerprint change, and cross-story move.
test("story upsert versions only meaningful changes and moves items safely", async () => {
  await withTestDb(async (database) => {
    const f = await fixture(database, "story-sequence@example.com");
    const first = await upsertResolvedStory(database, f.user.id, candidate(f), 100);
    assertEquals(first.version, 1);
    assertEquals((await listStoryMembers(database, f.user.id, first.id)).map((member) => member.item.payload.text), ["Text 0"]);

    const replay = await upsertResolvedStory(database, f.user.id, candidate(f), 200);
    assertEquals(replay.version, 1);
    assertEquals((await database.select().from(storyDevelopments).where(eq(storyDevelopments.storyId, first.id)))[0].version, 1);

    const laterCoverage = candidate(f);
    laterCoverage.developments[0].occurredAt += 1_000;
    assertEquals((await upsertResolvedStory(database, f.user.id, laterCoverage, 225)).version, 1);
    const afterLaterCoverage = (await database.select().from(storyDevelopments).where(eq(storyDevelopments.storyId, first.id)))[0];
    assertEquals([afterLaterCoverage.occurredAt, afterLaterCoverage.version], [candidate(f).developments[0].occurredAt, 1]);

    const metadataChanged = candidate(f);
    metadataChanged.title = "Election 2026 updated";
    metadataChanged.topics = ["politics", "elections"];
    metadataChanged.developments[0].title = "Announcement updated";
    metadataChanged.developments[0].occurredAt += 10;
    assertEquals((await upsertResolvedStory(database, f.user.id, metadataChanged, 250)).version, 2);
    assertEquals((await database.select().from(storyDevelopments).where(eq(storyDevelopments.storyId, first.id)))[0].version, 2);

    const expanded = candidate(f, "Election 2026", [{ item: 0, development: "announcement" }, { item: 1, development: "reaction" }]);
    assertEquals((await upsertResolvedStory(database, f.user.id, expanded, 300)).version, 3);
    const developments = await database.select().from(storyDevelopments).where(eq(storyDevelopments.storyId, first.id));
    assertEquals(developments.map((development) => [development.canonicalKey, development.version]).sort(), [["announcement", 3], ["reaction", 1]]);

    const changed = candidate(f, "Election 2026", [{ item: 0, development: "announcement", fingerprint: "fp-edited" }, { item: 1, development: "reaction" }]);
    assertEquals((await upsertResolvedStory(database, f.user.id, changed, 400)).version, 4);
    assertEquals((await database.select().from(storyDevelopments).where(and(eq(storyDevelopments.storyId, first.id), eq(storyDevelopments.canonicalKey, "announcement"))))[0].version, 4);

    const other = await upsertResolvedStory(database, f.user.id, candidate(f, "Other Story", [{ item: 0, development: "moved", fingerprint: "fp-edited" }]), 500);
    assertEquals(other.version, 1);
    assertEquals((await listStoryMembers(database, f.user.id, first.id)).map((member) => member.item.id), [f.stored[1].id]);
    assertEquals((await listStoryMembers(database, f.user.id, other.id)).map((member) => member.item.id), [f.stored[0].id]);
    assertEquals((await version(database, f.user.id, "election-2026")).version, 5);
  });
});

test("digest stories replace, parse content, and latest delivery is user scoped", async () => {
  await withTestDb(async (database) => {
    const f = await fixture(database, "story-digest@example.com", 1);
    const persisted = await upsertResolvedStory(database, f.user.id, candidate(f), 100);
    const secondary = await upsertResolvedStory(database, f.user.id, { canonicalKey: "secondary-story", title: "Secondary", topics: [], entities: [], developments: [] }, 101);
    const oldDigest = await upsertDigestForPeriod(database, { userId: f.user.id, periodStartMs: 1, periodEndMs: 2, status: "complete" }, 10);
    const currentDigest = await upsertDigestForPeriod(database, { userId: f.user.id, periodStartMs: 3, periodEndMs: 4, status: "complete" }, 20);
    const content = { storyId: persisted.id, storyVersion: persisted.version, title: "Election", topics: ["politics"], entities: ["Example"], points: [{ text: "Point", sourceUrl: "https://example.test/0" }], sources: [{ itemId: f.stored[0].id, connectorId: ConnectorId.Telegram, sourceId: f.source.id, feedId: f.feed.id, feedName: f.feed.name, title: "Item 0", url: "https://example.test/0", publishedAt: f.stored[0].date }], relevanceScore: 90, matchedInterestRuleIds: [] };
    await replaceDigestStories(database, f.user.id, oldDigest.id, [{ content, profileVersion: 1, generatedAt: 100 }, { content: { ...content, storyId: secondary.id, title: "Secondary" }, profileVersion: 1, generatedAt: 101 }]);
    await replaceDigestStories(database, f.user.id, currentDigest.id, [{ content: { ...content, storyVersion: 2, title: "Updated" }, profileVersion: 2, generatedAt: 200 }]);
    await replaceDigestStories(database, f.user.id, currentDigest.id, [{ content: { ...content, storyVersion: 3, title: "Replacement" }, profileVersion: 2, generatedAt: 300 }]);
    const listed = await listDigestStories(database, f.user.id, currentDigest.id);
    assertEquals(listed.length, 1);
    assertEquals([listed[0].title, listed[0].topics, listed[0].entities, listed[0].storyVersion, listed[0].points[0].text, listed[0].sources[0].connectorId], ["Replacement", ["politics"], ["Example"], 3, "Point", ConnectorId.Telegram]);
    assertEquals((await database.select({ contentMode: digests.contentMode }).from(digests).where(eq(digests.id, currentDigest.id)))[0].contentMode, "stories");
    assertEquals(await findLatestDeliveredStoryVersion(database, f.user.id, persisted.id), 3);
    assertEquals(await findLatestDeliveredStoryVersion(database, f.user.id, persisted.id, currentDigest.id), 1);
    const delivered = await findLatestDeliveredStoryVersions(database, f.user.id, [persisted.id, secondary.id]);
    assertEquals([delivered.get(persisted.id), delivered.get(secondary.id)], [3, 1]);
    const prior = await findLatestDeliveredStoryVersions(database, f.user.id, [persisted.id, secondary.id], currentDigest.id);
    assertEquals([prior.get(persisted.id), prior.get(secondary.id)], [1, 1]);
    assertEquals(await findLatestDeliveredStoryVersions(database, f.user.id, []), new Map());

    const stranger = await fixture(database, "story-stranger@example.com", 0);
    assertEquals(await findLatestDeliveredStoryVersion(database, stranger.user.id, persisted.id), null);
    assertEquals(await listDigestStories(database, stranger.user.id, currentDigest.id), []);
  });
});
