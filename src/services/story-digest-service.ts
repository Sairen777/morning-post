import type { Database } from "../db/client.ts";
import { ConnectorId } from "../constants.ts";
import type { PublicFeed } from "../repositories/feed-repository.ts";
import { listActiveInterestRules } from "../repositories/interest-rule-repository.ts";
import { listItemsForFeedsInWindow } from "../repositories/item-repository.ts";
import { listSourcesForUser, type PublicSource } from "../repositories/source-repository.ts";
import type { User } from "../repositories/user-repository.ts";
import {
  findLatestDeliveredStoryVersions,
  listDigestStories,
  listRecentStoryReferences,
  listItemAnalyses,
  replaceDigestStories,
  upsertItemAnalyses,
  upsertResolvedStories,
  type StoredDigestStory,
} from "../repositories/story-repository.ts";
import type {
  AnalyzedStoryItem,
  PersistedStoryCandidate,
  StoryItemInput,
  StoryRelevanceDecision,
  StorySource,
} from "../personalization/story.types.ts";
import { DEFAULT_SYSTEM_PROMPT, buildStorySummaryPrompt } from "../summarizers/prompts.ts";
import { OpenAICompatibleSummarizerService } from "../summarizers/openai-compatible-summarizer.ts";
import type { SummarizerService } from "../summarizers/summarizer.types.ts";
import {
  fingerprintStoryItem,
  OpenAICompatibleStoryIntelligenceService,
  resolveStoryAnalysisMaxItems,
} from "./story-intelligence-service.ts";
import type { StoryIntelligenceService } from "../personalization/story.types.ts";
import { isInaccessiblePaidItem } from "./content-access.ts";
import {
  type DigestProgressReporter,
  reportDigestProgress,
} from "./digest-progress.ts";

export interface StoryDigestDependencies {
  intelligence?: StoryIntelligenceService;
  summarizer?: SummarizerService;
  analyzerVersion?: string;
  analysisCheckpointSize?: number;
  summaryConcurrency?: number;
  now?: () => number;
  signal?: AbortSignal;
  timeoutMs?: number;
  runId?: string;
  progressReporter?: DigestProgressReporter;
  progressStartedAtMs?: number;
}

export interface StoryDigestResult {
  stories: StoredDigestStory[];
  hadSummaryFailure: boolean;
}

function effectiveMode(feed: PublicFeed, source: PublicSource, user: User) {
  if (feed.relevanceFilterMode !== "inherit") return feed.relevanceFilterMode;
  if (source.relevanceFilterMode !== "inherit") return source.relevanceFilterMode;
  return user.defaultRelevanceFilterMode;
}

async function boundedMap<T, R>(values: T[], concurrency: number, fn: (value: T) => Promise<R>): Promise<PromiseSettledResult<R>[]> {
  const results: PromiseSettledResult<R>[] = new Array(values.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(concurrency, values.length) }, async () => {
    for (;;) {
      const index = next++;
      if (index >= values.length) return;
      try { results[index] = { status: "fulfilled", value: await fn(values[index]) }; }
      catch (reason) { results[index] = { status: "rejected", reason }; }
    }
  }));
  return results;
}

export async function assembleStoryDigest(
  database: Database,
  digestId: string,
  user: User,
  feeds: PublicFeed[],
  periodStartMs: number,
  periodEndMs: number,
  dependencies: StoryDigestDependencies = {},
): Promise<StoryDigestResult> {
  const currentStories = await listDigestStories(database, user.id, digestId);
  const currentVersionByStoryId = new Map(currentStories.map((story) => [story.storyId, story.storyVersion]));
  const intelligence = dependencies.intelligence ?? new OpenAICompatibleStoryIntelligenceService();
  const summarizer = dependencies.summarizer ?? new OpenAICompatibleSummarizerService();
  const analyzerVersion = dependencies.analyzerVersion ?? "story-v1";
  const now = dependencies.now ?? Date.now;
  const progress = dependencies.progressReporter;
  const runId = dependencies.runId;
  const progressStartedAtMs = dependencies.progressStartedAtMs ?? now();
  const elapsedMs = () => Math.max(0, now() - progressStartedAtMs);
  const sources = await listSourcesForUser(database, user.id);
  const sourceById = new Map(sources.map((source) => [source.id, source]));
  const feedById = new Map(feeds.map((feed) => [feed.id, feed]));
  const feedOrder = new Map(feeds.map((feed, index) => [feed.id, index]));
  const connectorBySource = new Map(sources.map((source) => [source.id, source.connectorId as ConnectorId]));
  const storedItems = (await listItemsForFeedsInWindow(database, feeds.map((feed) => feed.id), periodStartMs, periodEndMs))
    .sort((left, right) =>
      left.payload.date - right.payload.date ||
      (feedOrder.get(left.feedId) ?? Number.MAX_SAFE_INTEGER) -
        (feedOrder.get(right.feedId) ?? Number.MAX_SAFE_INTEGER) ||
      left.payload.externalId.localeCompare(right.payload.externalId) ||
      left.id.localeCompare(right.id)
    );
  const accessible = storedItems.filter((item) => !isInaccessiblePaidItem(item.payload));
  const inputs: StoryItemInput[] = accessible.map((item) => {
    const feed = feedById.get(item.feedId)!;
    return { itemId: item.id, feedId: item.feedId, feedName: feed.name, sourceId: feed.sourceId, payload: item.payload };
  });
  const fingerprints = await Promise.all(inputs.map(fingerprintStoryItem));
  const fingerprintByItemId = new Map(inputs.map((item, i) => [item.itemId, fingerprints[i]]));
  const cached = await listItemAnalyses(database, inputs.map((item, i) => ({ itemId: item.itemId, fingerprint: fingerprints[i] })), analyzerVersion);
  const cachedById = new Map(cached.map((entry) => [entry.itemId, entry]));
  const misses = inputs.filter((item, i) => cachedById.get(item.itemId)?.fingerprint !== fingerprints[i]);
  const checkpointSize = resolveStoryAnalysisMaxItems(dependencies.analysisCheckpointSize);
  const analyzedMisses: AnalyzedStoryItem[] = [];
  for (let start = 0; start < misses.length; start += checkpointSize) {
    const checkpointInputs = misses.slice(start, start + checkpointSize);
    const expectedFingerprints = new Map(checkpointInputs.map((item) => [
      item.itemId,
      fingerprintByItemId.get(item.itemId)!,
    ]));
    const batchIndex = Math.floor(start / checkpointSize) + 1;
    if (runId) reportDigestProgress(progress, {
      event: "analysis_checkpoint",
      runId,
      elapsedMs: elapsedMs(),
      batchIndex,
      batchSize: checkpointInputs.length,
      completedCount: start,
      totalCount: misses.length,
      status: "started",
    });
    const checkpoint = await intelligence.analyze(checkpointInputs, {
      signal: dependencies.signal,
      requestTimeoutMs: dependencies.timeoutMs,
    });
    const returnedIds = new Set(checkpoint.map((item) => item.itemId));
    const validCheckpoint = checkpoint.length === checkpointInputs.length &&
      returnedIds.size === checkpoint.length &&
      checkpoint.every((item) =>
        expectedFingerprints.has(item.itemId) &&
        item.fingerprint === expectedFingerprints.get(item.itemId)
      );
    if (!validCheckpoint) {
      throw new Error("Invalid analyzer checkpoint output: expected exactly one analysis per input with matching item IDs and fingerprints");
    }
    await upsertItemAnalyses(database, checkpoint.map((item) => ({
      itemId: item.itemId,
      fingerprint: item.fingerprint,
      analyzerVersion,
      analysis: item.analysis,
      analyzedAt: now(),
    })));
    analyzedMisses.push(...checkpoint);
    if (runId) reportDigestProgress(progress, {
      event: "analysis_checkpoint",
      runId,
      elapsedMs: elapsedMs(),
      batchIndex,
      batchSize: checkpointInputs.length,
      completedCount: analyzedMisses.length,
      totalCount: misses.length,
      status: "complete",
    });
  }
  const missesById = new Map(analyzedMisses.map((item) => [item.itemId, item]));
  const analyzed: AnalyzedStoryItem[] = inputs.map((item, i) => {
    const miss = missesById.get(item.itemId);
    if (miss) return miss;
    const hit = cachedById.get(item.itemId)!;
    return { ...item, fingerprint: fingerprints[i], analysis: hit.analysis };
  });
  const recentStories = await listRecentStoryReferences(database, user.id, { limit: 200 });
  if (runId) reportDigestProgress(progress, {
    event: "resolution",
    runId,
    elapsedMs: elapsedMs(),
    itemCount: analyzed.length,
    status: "started",
  });
  const resolved = await intelligence.resolve(analyzed, recentStories, { signal: dependencies.signal, requestTimeoutMs: dependencies.timeoutMs });
  const persisted = await upsertResolvedStories(database, user.id, resolved, now());
  if (runId) reportDigestProgress(progress, {
    event: "resolution",
    runId,
    elapsedMs: elapsedMs(),
    itemCount: persisted.length,
    status: "complete",
  });
  const rules = await listActiveInterestRules(database, user.id, now());
  const includeAll: PersistedStoryCandidate[] = [];
  const personalized: PersistedStoryCandidate[] = [];
  for (const story of persisted) {
    const hasIncludeAll = story.candidate.developments.some((development) => development.items.some((item) => {
      const feed = feedById.get(item.feedId)!;
      return effectiveMode(feed, sourceById.get(feed.sourceId)!, user) === "include_all";
    }));
    (hasIncludeAll ? includeAll : personalized).push(story);
  }
  if (runId) reportDigestProgress(progress, {
    event: "classification",
    runId,
    elapsedMs: elapsedMs(),
    itemCount: persisted.length,
    status: "started",
  });
  const decisions: StoryRelevanceDecision[] = [
    ...(personalized.length ? await intelligence.classify(personalized, rules, user.relevanceThreshold, { signal: dependencies.signal, requestTimeoutMs: dependencies.timeoutMs, preferencePrompt: user.systemPrompt }) : []),
    ...(includeAll.length ? await intelligence.classify(includeAll, rules.filter((rule) => rule.disposition === "mute"), 0, { signal: dependencies.signal, requestTimeoutMs: dependencies.timeoutMs }) : []),
  ];
  if (runId) reportDigestProgress(progress, {
    event: "classification",
    runId,
    elapsedMs: elapsedMs(),
    itemCount: decisions.length,
    status: "complete",
  });
  const decisionById = new Map(decisions.map((decision) => [decision.storyId, decision]));
  const deliveredVersions = await findLatestDeliveredStoryVersions(database, user.id, persisted.map((story) => story.id), digestId);
  const relevant: PersistedStoryCandidate[] = [];
  for (const story of persisted) {
    const decision = decisionById.get(story.id);
    if (!decision?.relevant) continue;
    const currentVersion = currentVersionByStoryId.get(story.id);
    const delivered = deliveredVersions.get(story.id);
    if (currentVersion !== story.version && delivered !== undefined && delivered >= story.version) continue;
    relevant.push(story);
  }
  relevant.sort((a, b) => (decisionById.get(b.id)!.score - decisionById.get(a.id)!.score));
  const selected = user.maximumStoriesPerDigest === null ? relevant : relevant.slice(0, user.maximumStoriesPerDigest);
  const storyRules = buildStorySummaryPrompt({ language: user.defaultLanguage ?? undefined });
  storyRules.systemPrompt = [DEFAULT_SYSTEM_PROMPT, user.summaryPrompt.trim(), storyRules.systemPrompt].filter(Boolean).join("\n\n");
  if (runId) reportDigestProgress(progress, {
    event: "summarization",
    runId,
    elapsedMs: elapsedMs(),
    itemCount: selected.length,
    completedCount: 0,
    status: "started",
  });
  const summaries = await boundedMap(selected, Math.max(1, dependencies.summaryConcurrency ?? 2), async (story) => {
    const prior = currentStories.find((current) =>
      current.storyId === story.id &&
      current.storyVersion === story.version &&
      current.profileVersion === user.interestProfileVersion
    );
    if (prior) {
      const { id: _id, digestId: _digestId, profileVersion, generatedAt, ...content } = prior;
      return { content, profileVersion, generatedAt };
    }
    const items = story.candidate.developments.flatMap((development) => development.items);
    const points = await summarizer.summarize(items.map((item) => item.payload), storyRules, { signal: dependencies.signal, requestTimeoutMs: dependencies.timeoutMs });
    if (items.length > 0 && points.length === 0) throw new Error("Story summarization returned no points");
    const decision = decisionById.get(story.id)!;
    const sources: StorySource[] = items.map((item) => ({ itemId: item.itemId, connectorId: connectorBySource.get(item.sourceId)!, sourceId: item.sourceId, feedId: item.feedId, feedName: item.feedName, title: item.payload.title, url: item.payload.url, publishedAt: item.payload.date }));
    return { content: { storyId: story.id, storyVersion: story.version, title: story.candidate.title, topics: story.candidate.topics, entities: story.candidate.entities, points, sources, relevanceScore: decision.score, matchedInterestRuleIds: decision.matchedInterestRuleIds }, profileVersion: user.interestProfileVersion, generatedAt: now() };
  });
  if (runId) reportDigestProgress(progress, {
    event: "summarization",
    runId,
    elapsedMs: elapsedMs(),
    itemCount: selected.length,
    completedCount: summaries.length,
    status: "complete",
  });
  const replacement = summaries.flatMap((result, index) => {
    if (result.status === "fulfilled") return [result.value];
    const prior = currentStories.find((story) => story.storyId === selected[index].id);
    if (!prior) return [];
    const { id: _id, digestId: _digestId, profileVersion, generatedAt, ...content } = prior;
    return [{ content, profileVersion, generatedAt }];
  });
  return { stories: await replaceDigestStories(database, user.id, digestId, replacement), hadSummaryFailure: summaries.some((result) => result.status === "rejected") };
}
