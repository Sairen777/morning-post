import { and, asc, desc, eq, gte, inArray, max, ne, or, sql } from "drizzle-orm";
import { z } from "zod";
import { ConnectorId } from "../constants.ts";
import type { Database } from "../db/client.ts";
import { digestStories, itemAnalyses, stories, storyDevelopments, storyItems } from "../db/schema/story.ts";
import { digests } from "../db/schema/digest.ts";
import { feeds } from "../db/schema/feed.ts";
import { items } from "../db/schema/item.ts";
import { sources } from "../db/schema/source.ts";
import type { DigestStoryContent, ItemAnalysisContent, PersistedStoryCandidate, ResolvedStoryCandidate, StoryReference, StorySource } from "../personalization/story.types.ts";
import { normalizedItemSchema, type StoredItem } from "./item-repository.ts";
import { summaryPointSchema } from "./summary-repository.ts";

const keySchema = z.string().trim().min(1).transform((value) =>
  value.normalize("NFKC").toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "-").replace(/^-|-$/g, "")
).pipe(z.string().min(1));
const analysisSchema = z.object({
  language: z.string().nullable(), canonicalUrls: z.array(z.string()), topics: z.array(z.string()), entities: z.array(z.string()),
  storyKey: z.string().min(1), storyTitle: z.string().min(1), developmentKey: z.string().min(1), developmentType: z.string().min(1),
  developmentTitle: z.string().min(1), mediaDescription: z.string().nullable(),
}).strict();
const analyzedItemSchema = z.object({
  itemId: z.string().uuid(), feedId: z.string().uuid(), feedName: z.string(), sourceId: z.string().uuid(), fingerprint: z.string().min(1),
  payload: normalizedItemSchema, analysis: analysisSchema,
}).strict();
const developmentSchema = z.object({
  canonicalKey: keySchema, type: z.string().min(1), title: z.string().min(1), occurredAt: z.number().int().nonnegative(), items: z.array(analyzedItemSchema),
}).strict();
const candidateSchema = z.object({
  canonicalKey: keySchema, title: z.string().min(1), topics: z.array(z.string()), entities: z.array(z.string()), developments: z.array(developmentSchema),
}).strict().superRefine((candidate, context) => {
  const developmentKeys = new Set<string>(); const itemIds = new Set<string>();
  for (const development of candidate.developments) {
    if (developmentKeys.has(development.canonicalKey)) context.addIssue({ code: "custom", message: "duplicate development canonical key" });
    developmentKeys.add(development.canonicalKey);
    for (const item of development.items) {
      if (itemIds.has(item.itemId)) context.addIssue({ code: "custom", message: "an item may belong to only one development" });
      itemIds.add(item.itemId);
    }
  }
});
const storySourceSchema: z.ZodType<StorySource> = z.object({
  itemId: z.string().uuid(), connectorId: z.nativeEnum(ConnectorId), sourceId: z.string().uuid(), feedId: z.string().uuid(), feedName: z.string(),
  title: z.string().nullable(), url: z.string().nullable(), publishedAt: z.number().int().nonnegative(),
}).strict();
const digestContentSchema = z.object({ storyId: z.string().uuid(), storyVersion: z.number().int().positive(), title: z.string(), topics: z.array(z.string()), entities: z.array(z.string()), points: z.array(summaryPointSchema), sources: z.array(storySourceSchema), relevanceScore: z.number().int().min(0).max(100), matchedInterestRuleIds: z.array(z.string().uuid()) }).strict();

export interface UpsertItemAnalysisInput { itemId: string; fingerprint: string; analyzerVersion: string; analysis: ItemAnalysisContent; analyzedAt?: number }
export interface StoredItemAnalysis extends Required<UpsertItemAnalysisInput> {}
export interface StoryMember { developmentId: string; developmentCanonicalKey: string; developmentVersion: number; itemFingerprint: string; item: StoredItem }
export interface UpsertDigestStoryInput { content: DigestStoryContent; profileVersion: number; generatedAt?: number }
export interface StoredDigestStory extends DigestStoryContent { id: string; digestId: string; profileVersion: number; generatedAt: number }
export interface ListRecentStoryReferencesOptions { limit?: number; since?: number }

export async function listRecentStoryReferences(database: Database, userId: string, options: ListRecentStoryReferencesOptions = {}): Promise<StoryReference[]> {
  const validUserId = z.string().uuid().parse(userId);
  const parsed = z.object({
    limit: z.number().int().positive().max(200).default(50),
    since: z.number().int().nonnegative().optional(),
  }).strict().parse(options);
  const conditions = [eq(stories.userId, validUserId)];
  if (parsed.since !== undefined) conditions.push(gte(stories.lastUpdatedAt, parsed.since));
  const rows = await database.select({
    id: stories.id,
    canonicalKey: stories.canonicalKey,
    title: stories.title,
    topics: stories.topics,
    entities: stories.entities,
    lastUpdatedAt: stories.lastUpdatedAt,
  }).from(stories).where(and(...conditions)).orderBy(desc(stories.lastUpdatedAt), asc(stories.id)).limit(parsed.limit);
  const schema: z.ZodType<StoryReference> = z.object({
    id: z.string().uuid(),
    canonicalKey: z.string().min(1),
    title: z.string(),
    topics: z.array(z.string()),
    entities: z.array(z.string()),
    lastUpdatedAt: z.number().int().nonnegative(),
  }).strict();
  return rows.map((row) => schema.parse(row));
}

function parseAnalysis(row: unknown): StoredItemAnalysis {
  return z.object({ itemId: z.string().uuid(), fingerprint: z.string(), analyzerVersion: z.string(), analysis: analysisSchema, analyzedAt: z.number() }).parse(row);
}

export async function findItemAnalysis(database: Database, itemId: string, fingerprint: string, analyzerVersion: string): Promise<StoredItemAnalysis | null> {
  const rows = await database.select().from(itemAnalyses).where(and(eq(itemAnalyses.itemId, z.string().uuid().parse(itemId)), eq(itemAnalyses.fingerprint, fingerprint), eq(itemAnalyses.analyzerVersion, analyzerVersion))).limit(1);
  return rows[0] ? parseAnalysis(rows[0]) : null;
}
export interface ItemAnalysisLookupInput { itemId: string; fingerprint: string }

export async function listItemAnalyses(database: Database, inputs: ItemAnalysisLookupInput[], analyzerVersion: string): Promise<StoredItemAnalysis[]> {
  const parsedInputs = z.array(z.object({ itemId: z.string().uuid(), fingerprint: z.string().min(1) }).strict()).parse(inputs);
  const validAnalyzerVersion = z.string().min(1).parse(analyzerVersion);
  if (parsedInputs.length === 0) return [];
  const rows = await database.select().from(itemAnalyses).where(and(
    eq(itemAnalyses.analyzerVersion, validAnalyzerVersion),
    or(...parsedInputs.map((input) => and(eq(itemAnalyses.itemId, input.itemId), eq(itemAnalyses.fingerprint, input.fingerprint)))),
  ));
  const byItemId = new Map(rows.map((row) => [row.itemId, parseAnalysis(row)]));
  return parsedInputs.flatMap((input) => {
    const analysis = byItemId.get(input.itemId);
    return analysis ? [analysis] : [];
  });
}


export async function upsertItemAnalysis(database: Database, input: UpsertItemAnalysisInput): Promise<StoredItemAnalysis> {
  const parsed = z.object({ itemId: z.string().uuid(), fingerprint: z.string().min(1), analyzerVersion: z.string().min(1), analysis: analysisSchema, analyzedAt: z.number().int().nonnegative().default(() => Date.now()) }).parse(input);
  const rows = await database.insert(itemAnalyses).values(parsed).onConflictDoUpdate({ target: itemAnalyses.itemId, set: { fingerprint: parsed.fingerprint, analyzerVersion: parsed.analyzerVersion, analysis: parsed.analysis, analyzedAt: parsed.analyzedAt } }).returning();
  return parseAnalysis(rows[0]);
}
export async function upsertItemAnalyses(database: Database, inputs: UpsertItemAnalysisInput[]): Promise<StoredItemAnalysis[]> {
  const parsed = z.array(z.object({ itemId: z.string().uuid(), fingerprint: z.string().min(1), analyzerVersion: z.string().min(1), analysis: analysisSchema, analyzedAt: z.number().int().nonnegative().default(() => Date.now()) }).strict()).superRefine((values, context) => {
    const itemIds = new Set<string>();
    for (const value of values) {
      if (itemIds.has(value.itemId)) context.addIssue({ code: "custom", message: "duplicate item analysis" });
      itemIds.add(value.itemId);
    }
  }).parse(inputs);
  if (parsed.length === 0) return [];
  const rows = await database.insert(itemAnalyses).values(parsed).onConflictDoUpdate({
    target: itemAnalyses.itemId,
    set: { fingerprint: sql`excluded.fingerprint`, analyzerVersion: sql`excluded.analyzer_version`, analysis: sql`excluded.analysis`, analyzedAt: sql`excluded.analyzed_at` },
  }).returning();
  const byItemId = new Map(rows.map((row) => [row.itemId, parseAnalysis(row)]));
  return parsed.map((input) => byItemId.get(input.itemId)!);
}


export async function upsertResolvedStories(database: Database, userId: string, inputs: ResolvedStoryCandidate[], now = Date.now()): Promise<PersistedStoryCandidate[]> {
  const candidates = z.array(candidateSchema).superRefine((values, context) => {
    const storyKeys = new Set<string>(); const itemIds = new Set<string>();
    for (const candidate of values) {
      if (storyKeys.has(candidate.canonicalKey)) context.addIssue({ code: "custom", message: "duplicate story canonical key" });
      storyKeys.add(candidate.canonicalKey);
      for (const development of candidate.developments) for (const item of development.items) {
        if (itemIds.has(item.itemId)) context.addIssue({ code: "custom", message: "an item may occur in only one story candidate" });
        itemIds.add(item.itemId);
      }
    }
  }).parse(inputs) as ResolvedStoryCandidate[];
  if (candidates.length === 0) return [];
  const validUserId = z.string().uuid().parse(userId);
  const candidateItemIds = candidates.flatMap((candidate) => candidate.developments.flatMap((development) => development.items.map((item) => item.itemId)));
  return await database.transaction(async (tx) => {
    const db = tx as Database;
    await db.execute(sql`select pg_advisory_xact_lock(hashtext(${validUserId}))`);
    if (candidateItemIds.length) {
      const owned = await db.select({ id: items.id }).from(items).innerJoin(feeds, eq(items.feedId, feeds.id)).innerJoin(sources, eq(feeds.sourceId, sources.id)).where(and(inArray(items.id, candidateItemIds), eq(sources.userId, validUserId)));
      if (owned.length !== candidateItemIds.length) throw new Error("story items must all be owned by the story user");
    }

    const existingStories = await db.select().from(stories).where(and(eq(stories.userId, validUserId), inArray(stories.canonicalKey, candidates.map((candidate) => candidate.canonicalKey))));
    const storyByKey = new Map(existingStories.map((story) => [story.canonicalKey, story]));
    const missingCandidates = candidates.filter((candidate) => !storyByKey.has(candidate.canonicalKey));
    if (missingCandidates.length) {
      const inserted = await db.insert(stories).values(missingCandidates.map((candidate) => ({ userId: validUserId, canonicalKey: candidate.canonicalKey, title: candidate.title, topics: candidate.topics, entities: candidate.entities, firstSeenAt: now, lastUpdatedAt: now }))).returning();
      for (const story of inserted) storyByKey.set(story.canonicalKey, story);
    }
    const newStoryIds = new Set(missingCandidates.map((candidate) => storyByKey.get(candidate.canonicalKey)!.id));
    const storyIds = candidates.map((candidate) => storyByKey.get(candidate.canonicalKey)!.id);
    const storedDevelopments = await db.select().from(storyDevelopments).where(inArray(storyDevelopments.storyId, storyIds));
    const developmentByKey = new Map(storedDevelopments.map((development) => [`${development.storyId}:${development.canonicalKey}`, development]));
    const missingDevelopments = candidates.flatMap((candidate) => {
      const story = storyByKey.get(candidate.canonicalKey)!;
      return candidate.developments.filter((development) => !developmentByKey.has(`${story.id}:${development.canonicalKey}`)).map((development) => ({ story, development }));
    });
    if (missingDevelopments.length) {
      const inserted = await db.insert(storyDevelopments).values(missingDevelopments.map(({ story, development }) => ({ storyId: story.id, canonicalKey: development.canonicalKey, type: development.type, title: development.title, occurredAt: development.occurredAt, firstSeenAt: now, lastUpdatedAt: now }))).returning();
      for (const development of inserted) developmentByKey.set(`${development.storyId}:${development.canonicalKey}`, development);
    }
    const newDevelopmentIds = new Set(missingDevelopments.map(({ story, development }) => developmentByKey.get(`${story.id}:${development.canonicalKey}`)!.id));
    const changedStoryIds = new Set<string>(); const changedDevelopmentIds = new Set<string>();
    for (const { story } of missingDevelopments) if (!newStoryIds.has(story.id)) changedStoryIds.add(story.id);

    for (const candidate of candidates) {
      const story = storyByKey.get(candidate.canonicalKey)!;
      const storyMetadataChanged = story.title !== candidate.title || JSON.stringify(story.topics) !== JSON.stringify(candidate.topics) || JSON.stringify(story.entities) !== JSON.stringify(candidate.entities);
      if (storyMetadataChanged && !newStoryIds.has(story.id)) changedStoryIds.add(story.id);
      if (storyMetadataChanged) await db.update(stories).set({ title: candidate.title, topics: candidate.topics, entities: candidate.entities, lastUpdatedAt: now }).where(eq(stories.id, story.id));
      for (const development of candidate.developments) {
        const stored = developmentByKey.get(`${story.id}:${development.canonicalKey}`)!;
        const occurredAt = Math.min(stored.occurredAt, development.occurredAt);
        if (!newDevelopmentIds.has(stored.id) && (stored.type !== development.type || stored.title !== development.title || stored.occurredAt !== occurredAt)) {
          await db.update(storyDevelopments).set({ type: development.type, title: development.title, occurredAt, lastUpdatedAt: now }).where(eq(storyDevelopments.id, stored.id));
          changedDevelopmentIds.add(stored.id); changedStoryIds.add(story.id);
        }
      }
    }

    const currentMemberships = candidateItemIds.length
      ? await db.select({ developmentId: storyItems.developmentId, itemId: storyItems.itemId, fingerprint: storyItems.itemFingerprint, storyId: storyDevelopments.storyId }).from(storyItems).innerJoin(storyDevelopments, eq(storyItems.developmentId, storyDevelopments.id)).where(inArray(storyItems.itemId, candidateItemIds))
      : [];
    const membershipByItem = new Map(currentMemberships.map((membership) => [membership.itemId, membership]));
    const replacementItemIds: string[] = []; const replacementRows: Array<typeof storyItems.$inferInsert> = [];
    for (const candidate of candidates) {
      const story = storyByKey.get(candidate.canonicalKey)!;
      for (const development of candidate.developments) {
        const stored = developmentByKey.get(`${story.id}:${development.canonicalKey}`)!;
        for (const member of development.items) {
          const current = membershipByItem.get(member.itemId);
          if (current?.developmentId === stored.id && current.fingerprint === member.fingerprint) continue;
          replacementItemIds.push(member.itemId);
          replacementRows.push({ developmentId: stored.id, itemId: member.itemId, itemFingerprint: member.fingerprint, confidence: 100, addedAt: now });
          if (current) {
            changedDevelopmentIds.add(current.developmentId);
            changedStoryIds.add(current.storyId);
          }
          if (!newDevelopmentIds.has(stored.id)) changedDevelopmentIds.add(stored.id);
          if (!newStoryIds.has(story.id)) changedStoryIds.add(story.id);
        }
      }
    }
    if (replacementItemIds.length) {
      await db.delete(storyItems).where(inArray(storyItems.itemId, replacementItemIds));
      await db.insert(storyItems).values(replacementRows);
    }
    if (changedDevelopmentIds.size) await db.update(storyDevelopments).set({ version: sql`${storyDevelopments.version} + 1`, lastUpdatedAt: now }).where(inArray(storyDevelopments.id, [...changedDevelopmentIds]));
    if (changedStoryIds.size) await db.update(stories).set({ version: sql`${stories.version} + 1`, lastUpdatedAt: now }).where(inArray(stories.id, [...changedStoryIds]));
    const finalStories = await db.select().from(stories).where(inArray(stories.id, storyIds));
    const finalById = new Map(finalStories.map((story) => [story.id, story]));
    return candidates.map((candidate) => {
      const story = finalById.get(storyByKey.get(candidate.canonicalKey)!.id)!;
      return { id: story.id, version: story.version, candidate };
    });
  });
}

export async function upsertResolvedStory(database: Database, userId: string, input: ResolvedStoryCandidate, now = Date.now()): Promise<PersistedStoryCandidate> {
  return (await upsertResolvedStories(database, userId, [input], now))[0];
}

export async function listStoryMembers(database: Database, userId: string, storyId: string): Promise<StoryMember[]> {
  const rows = await database.select({ developmentId: storyDevelopments.id, developmentCanonicalKey: storyDevelopments.canonicalKey, developmentVersion: storyDevelopments.version, itemFingerprint: storyItems.itemFingerprint, item: items }).from(stories).innerJoin(storyDevelopments, eq(stories.id, storyDevelopments.storyId)).innerJoin(storyItems, eq(storyDevelopments.id, storyItems.developmentId)).innerJoin(items, eq(storyItems.itemId, items.id)).where(and(eq(stories.id, z.string().uuid().parse(storyId)), eq(stories.userId, z.string().uuid().parse(userId)))).orderBy(asc(storyDevelopments.occurredAt), asc(items.date));
  return rows.map((row) => ({ ...row, item: z.object({ id: z.string().uuid(), feedId: z.string().uuid(), externalId: z.string(), date: z.number(), payload: normalizedItemSchema, fetchedAt: z.number() }).parse(row.item) }));
}

export async function replaceDigestStories(database: Database, userId: string, digestId: string, inputs: UpsertDigestStoryInput[]): Promise<StoredDigestStory[]> {
  const validUserId = z.string().uuid().parse(userId); const validDigestId = z.string().uuid().parse(digestId);
  const parsed = inputs.map((input) => ({ content: digestContentSchema.parse(input.content), profileVersion: z.number().int().positive().parse(input.profileVersion), generatedAt: z.number().int().nonnegative().parse(input.generatedAt ?? Date.now()) }));
  return await database.transaction(async (tx) => {
    const db = tx as Database; const digest = (await db.select({ id: digests.id }).from(digests).where(and(eq(digests.id, validDigestId), eq(digests.userId, validUserId))).limit(1))[0];
    if (!digest) throw new Error("digest is not owned by user");
    if (parsed.length) {
      const ownedStories = await db.select({ id: stories.id }).from(stories).where(and(eq(stories.userId, validUserId), inArray(stories.id, parsed.map((value) => value.content.storyId))));
      if (ownedStories.length !== new Set(parsed.map((value) => value.content.storyId)).size) throw new Error("digest stories must be owned by user");
    }
    await db.update(digests).set({ contentMode: "stories" }).where(eq(digests.id, validDigestId));
    await db.delete(digestStories).where(eq(digestStories.digestId, validDigestId));
    if (parsed.length) await db.insert(digestStories).values(parsed.map(({ content, profileVersion, generatedAt }) => ({ digestId: validDigestId, storyId: content.storyId, storyVersion: content.storyVersion, profileVersion, title: content.title, topics: content.topics, entities: content.entities, points: content.points, sources: content.sources, relevanceScore: content.relevanceScore, matchedInterestRuleIds: content.matchedInterestRuleIds, generatedAt })));
    return listDigestStories(db, validUserId, validDigestId);
  });
}

export async function upsertDigestStory(database: Database, userId: string, digestId: string, input: UpsertDigestStoryInput): Promise<StoredDigestStory> {
  const validUserId = z.string().uuid().parse(userId); const validDigestId = z.string().uuid().parse(digestId);
  const content = digestContentSchema.parse(input.content); const profileVersion = z.number().int().positive().parse(input.profileVersion); const generatedAt = z.number().int().nonnegative().parse(input.generatedAt ?? Date.now());
  return await database.transaction(async (tx) => {
    const db = tx as Database;
    const ownership = (await db.select({ digestId: digests.id, storyId: stories.id }).from(digests).innerJoin(stories, and(eq(stories.id, content.storyId), eq(stories.userId, digests.userId))).where(and(eq(digests.id, validDigestId), eq(digests.userId, validUserId))).limit(1))[0];
    if (!ownership) throw new Error("digest and story must be owned by user");
    await db.update(digests).set({ contentMode: "stories" }).where(eq(digests.id, validDigestId));
    await db.insert(digestStories).values({ digestId: validDigestId, storyId: content.storyId, storyVersion: content.storyVersion, profileVersion, title: content.title, topics: content.topics, entities: content.entities, points: content.points, sources: content.sources, relevanceScore: content.relevanceScore, matchedInterestRuleIds: content.matchedInterestRuleIds, generatedAt }).onConflictDoUpdate({
      target: [digestStories.digestId, digestStories.storyId],
      set: { storyVersion: content.storyVersion, profileVersion, title: content.title, topics: content.topics, entities: content.entities, points: content.points, sources: content.sources, relevanceScore: content.relevanceScore, matchedInterestRuleIds: content.matchedInterestRuleIds, generatedAt },
    });
    const stored = await listDigestStories(db, validUserId, validDigestId);
    return stored.find((story) => story.storyId === content.storyId)!;
  });
}

export async function listDigestStories(database: Database, userId: string, digestId: string): Promise<StoredDigestStory[]> {
  const rows = await database.select({ row: digestStories }).from(digestStories).innerJoin(digests, eq(digestStories.digestId, digests.id)).where(and(eq(digestStories.digestId, z.string().uuid().parse(digestId)), eq(digests.userId, z.string().uuid().parse(userId)))).orderBy(asc(digestStories.generatedAt), asc(digestStories.id));
  return rows.map(({ row }) => ({ id: row.id, digestId: row.digestId, profileVersion: row.profileVersion, generatedAt: row.generatedAt, ...digestContentSchema.parse({ storyId: row.storyId, storyVersion: row.storyVersion, title: row.title, topics: row.topics, entities: row.entities, points: row.points, sources: row.sources, relevanceScore: row.relevanceScore, matchedInterestRuleIds: row.matchedInterestRuleIds }) }));
}

export async function findLatestDeliveredStoryVersions(database: Database, userId: string, storyIds: string[], excludeDigestId?: string): Promise<Map<string, number>> {
  const validUserId = z.string().uuid().parse(userId);
  const validStoryIds = z.array(z.string().uuid()).parse(storyIds);
  if (validStoryIds.length === 0) return new Map();
  const conditions = [eq(digests.userId, validUserId), inArray(digestStories.storyId, validStoryIds), eq(digests.status, "complete")];
  if (excludeDigestId) conditions.push(ne(digests.id, z.string().uuid().parse(excludeDigestId)));
  const rows = await database.select({ storyId: digestStories.storyId, version: max(digestStories.storyVersion) })
    .from(digestStories)
    .innerJoin(digests, eq(digestStories.digestId, digests.id))
    .where(and(...conditions))
    .groupBy(digestStories.storyId);
  return new Map(rows.filter((row) => row.version !== null).map((row): [string, number] => [row.storyId, row.version!]));
}

export async function findLatestDeliveredStoryVersion(database: Database, userId: string, storyId: string, excludeDigestId?: string): Promise<number | null> {
  return (await findLatestDeliveredStoryVersions(database, userId, [storyId], excludeDigestId)).get(storyId) ?? null;
}
