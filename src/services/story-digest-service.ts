import type { Database } from "../db/client.ts";
import { ConnectorId, DEFAULT_MAXIMUM_STORIES_PER_DIGEST } from "../constants.ts";
import type { StoryDetailLevel } from "../story-detail-level.ts";
import { getSummarizerBudgetConfig } from "../config.ts";
import type { PublicFeed } from "../repositories/feed-repository.ts";
import { listActiveInterestRules } from "../repositories/interest-rule-repository.ts";
import { listItemsForFeedsInWindow } from "../repositories/item-repository.ts";
import { listSourcesForUser } from "../repositories/source-repository.ts";
import type { User } from "../repositories/user-repository.ts";
import {
  findLatestDeliveredStoryVersions,
  listDigestStories,
  listReusableDigestStoryPoints,
  listRecentStoryReferences,
  listItemAnalyses,
  replaceDigestStories,
  upsertItemAnalyses,
  upsertResolvedStories,
  type StoredDigestStory,
} from "../repositories/story-repository.ts";
import type {
  AnalyzedStoryItem,
  DigestStoryContent,
  PersistedStoryCandidate,
  StoryItemInput,
  StoryRelevanceDecision,
  StorySource,
} from "../personalization/story.types.ts";
import {
  DEFAULT_SYSTEM_PROMPT,
  buildBatchStorySummaryPrompt,
  buildHeadlineBatchStorySummaryPrompt,
  buildHeadlineStorySummaryPrompt,
  buildStorySummaryPrompt,
  buildThoroughStorySummaryPrompt,
  normalizeInterestPrompt,
} from "../summarizers/prompts.ts";
import { resolveEffectiveRelevanceFilterMode } from "../personalization/relevance-filter-policy.ts";
import { OpenAICompatibleSummarizerService } from "../summarizers/openai-compatible-summarizer.ts";
import { serializeBatchSummaryInput, type BatchSummaryInput, type SummarizerService, type SummaryPoint, type SummaryRuleset } from "../summarizers/summarizer.types.ts";
import {
  fingerprintStoryAnalysisMember,
  groupStoryAnalysisUnits,
  OpenAICompatibleStoryIntelligenceService,
  resolveStoryAnalysisMaxItems,
} from "./story-intelligence-service.ts";
import type { StoryIntelligenceService } from "../personalization/story.types.ts";
import { isInaccessiblePaidItem } from "./content-access.ts";
import {
  type DigestModelStage,
  type DigestModelUsageAggregate,
  type DigestProgressReporter,
  reportDigestModelAttempt,
  reportDigestProgress,
} from "./digest-progress.ts";
import type { ModelAttemptTelemetry } from "../summarizers/openai-compatible-client.ts";

// v2: SummaryPoint gained an optional author; older cached points without it
// must regenerate so X chat points carry speaker identity end to end.
export const HEADLINE_STORY_SUMMARY_VERSION = "story-summary-headlines-v2";
export const CURRENT_STORY_SUMMARY_VERSION = "story-summary-balanced-v2";
export const THOROUGH_STORY_SUMMARY_VERSION = "story-summary-thorough-v2";
type StoryDetailPolicy = {
  singleMaxOutputTokens: number;
  batchMaxOutputTokens: number;
};
const STORY_DETAIL_POLICIES: Record<StoryDetailLevel, StoryDetailPolicy> = {
  headlines: { singleMaxOutputTokens: 700, batchMaxOutputTokens: 3_000 },
  balanced: { singleMaxOutputTokens: 4_000, batchMaxOutputTokens: 6_500 },
  thorough: { singleMaxOutputTokens: 6_500, batchMaxOutputTokens: 6_500 },
};

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
  modelUsageAggregate?: DigestModelUsageAggregate;
  suppressPreviouslyDelivered?: boolean;
}

export interface StoryDigestResult {
  stories: StoredDigestStory[];
  hadSummaryFailure: boolean;
  summaryFailureReason: unknown | null;
}

async function boundedMap<T, R>(
  values: T[],
  concurrency: number,
  fn: (value: T) => Promise<R>,
  stopOnError = false,
): Promise<PromiseSettledResult<R>[]> {
  const results: PromiseSettledResult<R>[] = new Array(values.length);
  let next = 0;
  let stoppedReason: unknown;
  await Promise.all(Array.from({ length: Math.min(concurrency, values.length) }, async () => {
    for (;;) {
      const index = next++;
      if (index >= values.length) return;
      if (stopOnError && stoppedReason !== undefined) {
        results[index] = { status: "rejected", reason: stoppedReason };
        continue;
      }
      try {
        results[index] = { status: "fulfilled", value: await fn(values[index]) };
      } catch (reason) {
        stoppedReason = reason;
        results[index] = { status: "rejected", reason };
      }
    }
  }));
  return results;
}

const encoder = new TextEncoder();
const COMPACT_ITEM_THRESHOLD_BYTES = 8_000;
const COMPACT_CONTEXT_BYTES = 2_000;
const EVIDENCE_MAX_COUNT = 3;
const EVIDENCE_MAX_BYTES = 400;

function truncateUtf8(text: string, maxBytes: number, fromEnd = false): string {
  if (encoder.encode(text).byteLength <= maxBytes) return text;
  const scalars = [...text];
  let used = 0;
  const kept: string[] = [];
  const iterable = fromEnd ? scalars.reverse() : scalars;
  for (const scalar of iterable) {
    const bytes = encoder.encode(scalar).byteLength;
    if (used + bytes > maxBytes) break;
    kept.push(scalar);
    used += bytes;
  }
  return (fromEnd ? kept.reverse() : kept).join("");
}

function buildBatchItems(story: PersistedStoryCandidate): StoryItemInput["payload"][] {
  return story.candidate.developments.flatMap((development) =>
    development.items.map((item) => {
      const payload = item.payload;
      if (encoder.encode(payload.text).byteLength <= COMPACT_ITEM_THRESHOLD_BYTES) {
        return payload;
      }
      const evidence = item.analysis.evidence.slice(0, EVIDENCE_MAX_COUNT)
        .map((value) => truncateUtf8(value, EVIDENCE_MAX_BYTES))
        .filter(Boolean);
      const leading = truncateUtf8(payload.text, COMPACT_CONTEXT_BYTES);
      const trailing = truncateUtf8(payload.text, COMPACT_CONTEXT_BYTES, true);
      const compactText = evidence.length
        ? [
          payload.title?.trim() ? `Title: ${payload.title.trim()}` : "",
          `Analysis evidence:\n${evidence.map((value) => `- ${value}`).join("\n")}`,
          `Leading context:\n${leading}`,
          `Trailing context:\n${trailing}`,
        ].filter(Boolean).join("\n\n")
        : `${leading}\n\n[...]\n\n${trailing}`;
      return { ...payload, text: compactText };
    })
  );
}

function storyHasMedia(story: PersistedStoryCandidate): boolean {
  return story.candidate.developments.some((development) =>
    development.items.some((item) => item.payload.media !== undefined)
  );
}

function resolveStoryDetailLevel(
  story: PersistedStoryCandidate,
  feedById: Map<string, PublicFeed>,
  profileDetailLevel: StoryDetailLevel,
): StoryDetailLevel {
  return story.candidate.developments.some((development) =>
      development.items.some((item) =>
        feedById.get(item.feedId)!.summarizationMode === "thorough"
      )
    )
    ? "thorough"
    : profileDetailLevel;
}

function summaryVersionForDetail(detail: StoryDetailLevel): string {
  if (detail === "headlines") return HEADLINE_STORY_SUMMARY_VERSION;
  return detail === "thorough"
    ? THOROUGH_STORY_SUMMARY_VERSION
    : CURRENT_STORY_SUMMARY_VERSION;
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
  const currentStoryById = new Map(currentStories.map((story) => [story.storyId, story]));
  const summarizer = dependencies.summarizer ?? new OpenAICompatibleSummarizerService();
  const intelligence = dependencies.intelligence ?? new OpenAICompatibleStoryIntelligenceService();
  const analyzerVersion = dependencies.analyzerVersion ?? "story-v2";
  const now = dependencies.now ?? Date.now;
  const suppressPreviouslyDelivered = dependencies.suppressPreviouslyDelivered ?? true;
  const progress = dependencies.progressReporter;
  const runId = dependencies.runId;
  const progressStartedAtMs = dependencies.progressStartedAtMs ?? now();
  const elapsedMs = () => Math.max(0, now() - progressStartedAtMs);
  const onAttempt = (stage: DigestModelStage) =>
    (attempt: ModelAttemptTelemetry): void =>
      reportDigestModelAttempt(
        progress,
        runId,
        elapsedMs(),
        stage,
        dependencies.modelUsageAggregate,
        attempt,
      );
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
  const units = groupStoryAnalysisUnits(inputs);
  const memberFingerprints = await Promise.all(units.flatMap((unit) =>
    unit.items.map((_, memberIndex) =>
      fingerprintStoryAnalysisMember(unit, memberIndex)
    )
  ));
  let memberFingerprintIndex = 0;
  const fingerprintByItemId = new Map<string, string>();
  units.forEach((unit) => unit.items.forEach((item) =>
    fingerprintByItemId.set(item.itemId, memberFingerprints[memberFingerprintIndex++]!)
  ));
  const cached = await listItemAnalyses(database, inputs.map((item) => ({
    itemId: item.itemId,
    fingerprint: fingerprintByItemId.get(item.itemId)!,
  })), analyzerVersion);
  const cachedById = new Map(cached.map((entry) => [entry.itemId, entry]));
  const missedUnits = units.filter((unit) => unit.items.some((item) =>
    cachedById.get(item.itemId)?.fingerprint !== fingerprintByItemId.get(item.itemId)
  ));
  const misses = missedUnits.flatMap((unit) => unit.items);
  const checkpointSize = resolveStoryAnalysisMaxItems(dependencies.analysisCheckpointSize);
  const checkpointInputs: Array<{
    batchIndex: number;
    inputs: StoryItemInput[];
    analysisUnitSizes: number[];
  }> = [];
  for (const unit of missedUnits) {
    const current = checkpointInputs.at(-1);
    if (!current || (current.inputs.length > 0 && current.inputs.length + unit.items.length > checkpointSize)) {
      checkpointInputs.push({
        batchIndex: checkpointInputs.length + 1,
        inputs: [...unit.items],
        analysisUnitSizes: [unit.items.length],
      });
    } else {
      current.inputs.push(...unit.items);
      current.analysisUnitSizes.push(unit.items.length);
    }
  }
  let completedAnalysisCount = 0;
  const checkpoints = await boundedMap(
    checkpointInputs,
    Math.max(1, dependencies.summaryConcurrency ?? 1),
    async ({ batchIndex, inputs, analysisUnitSizes }) => {
      const expectedFingerprints = new Map(inputs.map((item) => [
        item.itemId,
        fingerprintByItemId.get(item.itemId)!,
      ]));
      if (runId) reportDigestProgress(progress, {
        event: "analysis_checkpoint",
        runId,
        elapsedMs: elapsedMs(),
        batchIndex,
        batchSize: inputs.length,
        completedCount: completedAnalysisCount,
        totalCount: misses.length,
        status: "started",
      });
      const checkpoint = await intelligence.analyze(inputs, {
        signal: dependencies.signal,
        requestTimeoutMs: dependencies.timeoutMs,
        onAttempt: onAttempt("analysis"),
        onMediaAttempt: onAttempt("media"),
        analysisUnitSizes,
      });
      const returnedIds = new Set(checkpoint.map((item) => item.itemId));
      const validCheckpoint = checkpoint.length === inputs.length &&
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
      completedAnalysisCount += checkpoint.length;
      if (runId) reportDigestProgress(progress, {
        event: "analysis_checkpoint",
        runId,
        elapsedMs: elapsedMs(),
        batchIndex,
        batchSize: inputs.length,
        completedCount: completedAnalysisCount,
        totalCount: misses.length,
        status: "complete",
      });
      return checkpoint;
    },
    true,
  );
  const failedCheckpoint = checkpoints.find((result) => result.status === "rejected");
  if (failedCheckpoint?.status === "rejected") throw failedCheckpoint.reason;
  const analyzedMisses = checkpoints.flatMap((result) =>
    result.status === "fulfilled" ? result.value : []
  );
  const missesById = new Map(analyzedMisses.map((item) => [item.itemId, item]));
  const analyzed: AnalyzedStoryItem[] = inputs.map((item) => {
    const miss = missesById.get(item.itemId);
    if (miss) return miss;
    const hit = cachedById.get(item.itemId)!;
    return { ...item, fingerprint: fingerprintByItemId.get(item.itemId)!, analysis: hit.analysis };
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
      const source = sourceById.get(feed.sourceId)!;
      return resolveEffectiveRelevanceFilterMode(
        user.defaultRelevanceFilterMode,
        source.relevanceFilterMode,
        feed.relevanceFilterMode,
        source.relevanceWarmup,
      ) === "include_all";
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
    ...(personalized.length ? await intelligence.classify(personalized, rules, user.relevanceThreshold, { signal: dependencies.signal, requestTimeoutMs: dependencies.timeoutMs, preferencePrompt: normalizeInterestPrompt(user.systemPrompt), onAttempt: onAttempt("classification") }) : []),
    ...(includeAll.length ? await intelligence.classify(includeAll, rules.filter((rule) => rule.disposition === "mute"), 0, { signal: dependencies.signal, requestTimeoutMs: dependencies.timeoutMs, onAttempt: onAttempt("classification") }) : []),
  ];
  if (runId) reportDigestProgress(progress, {
    event: "classification",
    runId,
    elapsedMs: elapsedMs(),
    itemCount: decisions.length,
    status: "complete",
  });
  const decisionById = new Map(decisions.map((decision) => [decision.storyId, decision]));
  const deliveredVersions = suppressPreviouslyDelivered
    ? await findLatestDeliveredStoryVersions(database, user.id, persisted.map((story) => story.id), digestId)
    : new Map<string, number>();
  const relevant: PersistedStoryCandidate[] = [];
  for (const story of persisted) {
    const decision = decisionById.get(story.id);
    if (!decision?.relevant) continue;
    const currentVersion = currentStoryById.get(story.id)?.storyVersion;
    const delivered = deliveredVersions.get(story.id);
    if (suppressPreviouslyDelivered && currentVersion !== story.version && delivered !== undefined && delivered >= story.version) continue;
    relevant.push(story);
  }
  relevant.sort((a, b) => (decisionById.get(b.id)!.score - decisionById.get(a.id)!.score));
  const selected = relevant.slice(
    0,
    user.maximumStoriesPerDigest ?? DEFAULT_MAXIMUM_STORIES_PER_DIGEST,
  );
  const detailByStoryId = new Map(
    selected.map((story) => [
      story.id,
      resolveStoryDetailLevel(story, feedById, user.storyDetailLevel),
    ]),
  );
  const withUserPrompt = (rules: SummaryRuleset) => {
    rules.systemPrompt = [DEFAULT_SYSTEM_PROMPT, user.summaryPrompt.trim(), rules.systemPrompt].filter(Boolean).join("\n\n");
    return rules;
  };
  const singleRulesByDetail: Record<StoryDetailLevel, SummaryRuleset> = {
    headlines: withUserPrompt(buildHeadlineStorySummaryPrompt({ language: user.defaultLanguage ?? undefined })),
    balanced: withUserPrompt(buildStorySummaryPrompt({ language: user.defaultLanguage ?? undefined })),
    thorough: withUserPrompt(buildThoroughStorySummaryPrompt({ language: user.defaultLanguage ?? undefined })),
  };
  const batchRulesByDetail: Record<Exclude<StoryDetailLevel, "thorough">, SummaryRuleset> = {
    headlines: withUserPrompt(buildHeadlineBatchStorySummaryPrompt({ language: user.defaultLanguage ?? undefined })),
    balanced: withUserPrompt(buildBatchStorySummaryPrompt({ language: user.defaultLanguage ?? undefined })),
  };
  if (runId) reportDigestProgress(progress, {
    event: "summarization",
    runId,
    elapsedMs: elapsedMs(),
    itemCount: selected.length,
    completedCount: 0,
    status: "started",
  });
  type SummaryValue = {
    content: DigestStoryContent;
    profileVersion: number;
    summaryVersion: string;
    generatedAt: number;
  };
  const summaries: PromiseSettledResult<SummaryValue>[] = new Array(selected.length);
  type SummaryEntry = {
    index: number;
    story: PersistedStoryCandidate;
    detail: StoryDetailLevel;
  };
  const uncached: SummaryEntry[] = [];
  const makeSummary = (
    story: PersistedStoryCandidate,
    points: SummaryPoint[],
  ): SummaryValue => {
    const items = story.candidate.developments.flatMap((development) => development.items);
    const decision = decisionById.get(story.id)!;
    const sources: StorySource[] = items.map((item) => ({ itemId: item.itemId, connectorId: connectorBySource.get(item.sourceId)!, sourceId: item.sourceId, feedId: item.feedId, feedName: item.feedName, title: item.payload.title, url: item.payload.url, publishedAt: item.payload.date }));
    const summaryVersion = summaryVersionForDetail(
      detailByStoryId.get(story.id)!,
    );
    return { content: { storyId: story.id, storyVersion: story.version, title: story.candidate.title, topics: story.candidate.topics, entities: story.candidate.entities, points, sources, relevanceScore: decision.score, matchedInterestRuleIds: decision.matchedInterestRuleIds }, profileVersion: user.interestProfileVersion, summaryVersion, generatedAt: now() };
  };
  const reusableInputs = selected.flatMap((story) => {
    const summaryVersion = summaryVersionForDetail(
      detailByStoryId.get(story.id)!,
    );
    const current = currentStoryById.get(story.id);
    return current?.storyVersion === story.version &&
        current.profileVersion === user.interestProfileVersion &&
        current.summaryVersion === summaryVersion
      ? []
      : [{
        storyId: story.id,
        storyVersion: story.version,
        profileVersion: user.interestProfileVersion,
        summaryVersion,
      }];
  });
  const reusable = await listReusableDigestStoryPoints(
    database,
    user.id,
    reusableInputs,
    digestId,
  );
  const reusableByStoryId = new Map(reusable.map((story) => [story.storyId, story]));
  selected.forEach((story, index) => {
    const detail = detailByStoryId.get(story.id)!;
    const summaryVersion = summaryVersionForDetail(detail);
    const current = currentStoryById.get(story.id);
    const points = current?.storyVersion === story.version &&
        current.profileVersion === user.interestProfileVersion &&
        current.summaryVersion === summaryVersion
      ? current.points
      : reusableByStoryId.get(story.id)?.points;
    if (points) {
      summaries[index] = {
        status: "fulfilled",
        value: makeSummary(story, points),
      };
    } else {
      uncached.push({ index, story, detail });
    }
  });
  const budget = getSummarizerBudgetConfig();
  const batchMax = Math.min(5, budget.summaryBatchMaxStories);
  const batches: Array<Array<SummaryEntry & { input: BatchSummaryInput }>> = [];
  const singles: SummaryEntry[] = [];
  for (const candidate of uncached) {
    if (candidate.detail === "thorough") {
      singles.push(candidate);
      continue;
    }
    const rawItems = candidate.story.candidate.developments.flatMap((development) => development.items.map((item) => item.payload));
    const rawBytes = rawItems.reduce((total, item) => total + encoder.encode(item.text).byteLength, 0);
    if (!summarizer.summarizeBatch || storyHasMedia(candidate.story) || rawBytes > budget.summarizerTextBytesPerChunk) {
      singles.push(candidate);
      continue;
    }
    const input = { storyId: candidate.story.id, items: buildBatchItems(candidate.story) };
    const batchRules = batchRulesByDetail[candidate.detail];
    const inputBytes = encoder.encode(
      serializeBatchSummaryInput([input], batchRules.showTitle ?? false),
    ).byteLength;
    if (inputBytes > budget.summarizerTextBytesPerChunk) {
      singles.push(candidate);
      continue;
    }
    const batch = batches.at(-1);
    const candidateEntries = batch
      ? [...batch, { ...candidate, input }]
      : [{ ...candidate, input }];
    const candidateBytes = encoder.encode(serializeBatchSummaryInput(
      candidateEntries.map((entry) => entry.input),
      batchRules.showTitle ?? false,
    )).byteLength;
    if (
      !batch ||
      batch[0].detail !== candidate.detail ||
      batch.length >= batchMax ||
      candidateBytes > budget.summarizerTextBytesPerChunk
    ) {
      batches.push([{ ...candidate, input }]);
    } else {
      batch.push({ ...candidate, input });
    }
  }
  const summaryJobs: Array<
    | { kind: "batch"; entries: (typeof batches)[number] }
    | { kind: "single"; entry: (typeof singles)[number] }
  > = [
    ...batches.map((entries) => ({ kind: "batch" as const, entries })),
    ...singles.map((entry) => ({ kind: "single" as const, entry })),
  ];
  const summarizeOne = async (
    entry: SummaryEntry,
  ): Promise<void> => {
    const { index, story } = entry;
    try {
      const items = story.candidate.developments.flatMap((development) =>
        development.items
      );
      const points = await summarizer.summarize(
        items.map((item) => item.payload),
        singleRulesByDetail[entry.detail],
        {
          signal: dependencies.signal,
          requestTimeoutMs: dependencies.timeoutMs,
          onAttempt: onAttempt("summarization"),
          maxOutputTokens: STORY_DETAIL_POLICIES[entry.detail].singleMaxOutputTokens,
        },
      );
      if (items.length > 0 && points.length === 0) {
        throw new Error("Story summarization returned no points");
      }
      summaries[index] = {
        status: "fulfilled",
        value: makeSummary(story, points),
      };
    } catch (reason) {
      summaries[index] = { status: "rejected", reason };
    }
  };
  await boundedMap(
    summaryJobs,
    Math.max(1, dependencies.summaryConcurrency ?? 1),
    async (job) => {
      if (job.kind === "batch") {
        try {
          const detail = job.entries[0].detail as Exclude<StoryDetailLevel, "thorough">;
          const results = await summarizer.summarizeBatch!(
            job.entries.map((entry) => entry.input),
            batchRulesByDetail[detail],
            {
              signal: dependencies.signal,
              requestTimeoutMs: dependencies.timeoutMs,
              onAttempt: onAttempt("summarization"),
              maxOutputTokens: STORY_DETAIL_POLICIES[detail].batchMaxOutputTokens,
            },
          );
          const byId = new Map(results.map((result) => [result.storyId, result]));
          for (const entry of job.entries) {
            const result = byId.get(entry.story.id);
            summaries[entry.index] = result?.points && !result.error
              ? { status: "fulfilled", value: makeSummary(entry.story, result.points) }
              : { status: "rejected", reason: result?.error ?? new Error("Missing batch summary result") };
          }
        } catch (reason) {
          for (const entry of job.entries) {
            summaries[entry.index] = { status: "rejected", reason };
          }
        }
        return;
      }
      await summarizeOne(job.entry);
    },
  );
  const failedBatchEntries = batches.flatMap((entries) =>
    entries.filter(({ index }) => summaries[index]?.status === "rejected")
  );
  await boundedMap(
    failedBatchEntries,
    Math.max(1, dependencies.summaryConcurrency ?? 1),
    summarizeOne,
  );
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
    const prior = currentStoryById.get(selected[index].id);
    const expectedSummaryVersion = summaryVersionForDetail(
      detailByStoryId.get(selected[index].id)!,
    );
    if (!prior || prior.summaryVersion !== expectedSummaryVersion) return [];
    const { id: _id, digestId: _digestId, profileVersion, summaryVersion, generatedAt, ...content } = prior;
    return [{ content, profileVersion, summaryVersion, generatedAt }];
  });
  const summaryFailure = summaries.find((result) =>
    result.status === "rejected"
  );
  return {
    stories: await replaceDigestStories(
      database,
      user.id,
      digestId,
      replacement,
    ),
    hadSummaryFailure: summaryFailure !== undefined,
    summaryFailureReason: summaryFailure?.status === "rejected"
      ? summaryFailure.reason
      : null,
  };
}
