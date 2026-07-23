import { createHash } from "node:crypto";
import { jsonrepair } from "jsonrepair";
import { z } from "zod";
import {
  getSummarizerBudgetConfig,
  getSummarizerRuntimeConfig,
  resolveAllowRemoteSummarization,
  type SummarizerRuntimeConfig,
} from "../config.ts";
import type {
  AnalyzedStoryItem,
  ItemAnalysisContent,
  PersistedStoryCandidate,
  ResolvedStoryCandidate,
  StoryReference,
  StoryIntelligenceOptions,
  StoryIntelligenceService,
  StoryItemInput,
  StoryPreferenceRule,
  StoryRelevanceDecision,
} from "../personalization/story.types.ts";
import { personalizationLabelsSchema } from "../personalization/personalization-label.ts";
import { OpenAICompatibleChatClient } from "../summarizers/openai-compatible-client.ts";
import type { FetchFunction } from "../summarizers/openai-compatible-client.ts";
import { OpenAICompatibleSummarizerService } from "../summarizers/openai-compatible-summarizer.ts";
import type {
  SummarizeOptions,
  SummaryPoint,
  SummaryRuleset,
} from "../summarizers/summarizer.types.ts";
import {
  buildStoryAnalysisPrompt,
  buildStoryClassificationPrompt,
  buildStoryMediaAnalysisPrompt,
  buildStoryResolutionPrompt,
} from "../summarizers/prompts.ts";

interface ChatClient {
  complete(systemPrompt: string, content: string, options?: StoryIntelligenceOptions): Promise<string>;
}

export interface StoryMediaDescriber {
  describe(item: StoryItemInput, options?: StoryIntelligenceOptions): Promise<string | null>;
}

export interface StoryMediaSummarizer {
  summarize(
    items: StoryItemInput["payload"][],
    rules: SummaryRuleset,
    options?: SummarizeOptions,
  ): Promise<SummaryPoint[]>;
}

export interface OpenAICompatibleStoryIntelligenceOptions {
  models?: SummarizerRuntimeConfig;
  client?: ChatClient;
  mediaDescriber?: StoryMediaDescriber;
  mediaSummarizer?: StoryMediaSummarizer;
  fetch?: FetchFunction;
  retryBaseDelayMs?: number;
  allowRemoteSummarization?: boolean;
  maxItemsPerChunk?: number;
  maxTextBytesPerChunk?: number;
  minimumTextLengthForMediaDescription?: number;
  maxConcurrentMediaDescriptions?: number;
}

const analysisSchema = z.object({
  i: z.number().int().nonnegative(),
  language: z.string().nullable(),
  canonicalUrls: z.array(z.string()),
  topics: personalizationLabelsSchema,
  entities: personalizationLabelsSchema,
  storyKey: z.string().min(1),
  storyTitle: z.string().min(1),
  developmentKey: z.string().min(1),
  developmentType: z.string().min(1),
  developmentTitle: z.string().min(1),
  mediaDescription: z.string().nullable(),
}).strict();

const resolutionSchema = z.object({
  i: z.number().int().nonnegative(),
  sameStory: z.boolean(),
}).strict();

const classificationSchema = z.object({
  i: z.number().int().nonnegative(),
  score: z.number().int().min(0).max(100),
  matchedRuleIds: z.array(z.string()),
  reason: z.string().min(1),
}).strict();

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value !== null && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)).map(([key, child]) => `${JSON.stringify(key)}:${stableJson(child)}`).join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

export async function fingerprintStoryItem(item: StoryItemInput): Promise<string> {
  return createHash("sha256").update(stableJson(item)).digest("hex");
}

function normalizeKey(value: string): string {
  const normalized = value.normalize("NFKC").trim().toLocaleLowerCase("en-US")
    .replace(/[^\p{L}\p{N}]+/gu, "-").replace(/^-+|-+$/g, "");
  if (!normalized) throw new Error("Story identity key must contain a letter or number");
  return normalized;
}

function normalizeComparable(value: string): string {
  return value.normalize("NFKC").trim().toLocaleLowerCase("en-US")
    .replace(/[^\p{L}\p{N}]+/gu, "-").replace(/^-+|-+$/g, "");
}

function normalizeUrl(value: string): string | null {
  try {
    const url = new URL(value);
    url.hash = "";
    url.hostname = url.hostname.toLowerCase();
    if (url.pathname.length > 1) url.pathname = url.pathname.replace(/\/+$/, "");
    return url.toString();
  } catch {
    return null;
  }
}

function trustedCanonicalUrls(item: StoryItemInput): string[] {
  const metadata = item.payload.meta;
  const metadataUrls = metadata && Array.isArray(metadata.canonicalUrls)
    ? metadata.canonicalUrls.filter((value): value is string => typeof value === "string")
    : metadata && typeof metadata.canonicalUrl === "string"
    ? [metadata.canonicalUrl]
    : [];
  return [...new Set([
    ...(item.payload.url ? [item.payload.url] : []),
    ...metadataUrls,
  ].map(normalizeUrl).filter((url): url is string => url !== null))];
}

function truncateUtf8(value: string, maximum: number): string {
  const bytes = new TextEncoder().encode(value);
  if (bytes.length <= maximum) return value;
  return new TextDecoder().decode(bytes.slice(0, maximum)).replace(/\uFFFD$/, "");
}

function parseComplete<T extends { i: number }>(
  raw: string,
  schema: z.ZodType<T>,
  expectedIndexes: number[],
  label: string,
): T[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(jsonrepair(raw));
  } catch (error) {
    throw new Error(`${label} returned malformed JSON`, { cause: error });
  }
  const values = z.array(schema).parse(parsed);
  if (values.length !== expectedIndexes.length) {
    throw new Error(`${label} returned ${values.length} results for ${expectedIndexes.length} inputs`);
  }
  const expected = new Set(expectedIndexes);
  const indexes = values.map((value) => value.i);
  if (new Set(indexes).size !== expected.size || indexes.some((index) => !expected.has(index))) {
    throw new Error(`${label} returned duplicate, missing, or unknown indexes`);
  }
  return values.sort((a, b) => a.i - b.i);
}

function partition<T>(values: T[], maxItems: number, maxBytes: number, encode: (value: T, index: number) => string): Array<Array<{ value: T; index: number; encoded: string }>> {
  const batches: Array<Array<{ value: T; index: number; encoded: string }>> = [];
  let batch: Array<{ value: T; index: number; encoded: string }> = [];
  let bytes = 0;
  values.forEach((value, index) => {
    const encoded = truncateUtf8(encode(value, index), maxBytes);
    const size = new TextEncoder().encode(encoded).length;
    if (batch.length && (batch.length >= maxItems || bytes + size > maxBytes)) {
      batches.push(batch);
      batch = [];
      bytes = 0;
    }
    batch.push({ value, index, encoded });
    bytes += size;
  });
  if (batch.length) batches.push(batch);
  return batches;
}

class ModelBackedMediaDescriber implements StoryMediaDescriber {
  constructor(private readonly summarizer: StoryMediaSummarizer) {}

  async describe(
    item: StoryItemInput,
    options: StoryIntelligenceOptions = {},
  ): Promise<string | null> {
    const media = item.payload.media;
    if (!media) return null;
    const fallback = media.type === "album"
      ? `Album with ${media.localPaths.length} images attached.`
      : media.type === "document"
      ? `Document attached (${media.mimeType}).`
      : media.type === "webpage"
      ? `Web page attached: ${media.url}`
      : `${media.type === "photo" ? "Photo" : "Video"} attached.`;
    if (media.type !== "photo" && media.type !== "album") return fallback;
    const points = await this.summarizer.summarize(
      [item.payload],
      buildStoryMediaAnalysisPrompt(),
      {
        signal: options.signal,
        requestTimeoutMs: options.requestTimeoutMs,
        maxItemsPerChunk: 1,
      },
    );
    const description = points.map((point) => point.text.trim()).filter(Boolean).join(" ");
    return description || fallback;
  }
}

export class OpenAICompatibleStoryIntelligenceService implements StoryIntelligenceService {
  private readonly client: ChatClient;
  private readonly mediaDescriber: StoryMediaDescriber;
  private readonly maxItems: number;
  private readonly maxBytes: number;
  private readonly minimumMediaText: number;
  private readonly mediaConcurrency: number;

  constructor(options: OpenAICompatibleStoryIntelligenceOptions = {}) {
    const budget = getSummarizerBudgetConfig();
    const models = options.models ?? getSummarizerRuntimeConfig();
    this.client = options.client ?? new OpenAICompatibleChatClient(models.summarizer, {
      retryBaseDelayMs: options.retryBaseDelayMs,
      allowRemote: resolveAllowRemoteSummarization(options.allowRemoteSummarization),
      fetch: options.fetch,
    });
    this.mediaDescriber = options.mediaDescriber ??
      new ModelBackedMediaDescriber(options.mediaSummarizer ??
        new OpenAICompatibleSummarizerService({
          models,
          retryBaseDelayMs: options.retryBaseDelayMs,
          allowRemoteSummarization: options.allowRemoteSummarization,
          maxItemsPerChunk: 1,
        }));
    this.maxItems = options.maxItemsPerChunk ?? budget.summarizerMaxItemsPerChunk;
    this.maxBytes = options.maxTextBytesPerChunk ?? budget.summarizerTextBytesPerChunk;
    this.minimumMediaText = options.minimumTextLengthForMediaDescription ?? 80;
    this.mediaConcurrency = options.maxConcurrentMediaDescriptions ?? 4;
    if (!Number.isInteger(this.maxItems) || this.maxItems <= 0 || !Number.isInteger(this.maxBytes) || this.maxBytes <= 0 || !Number.isInteger(this.mediaConcurrency) || this.mediaConcurrency <= 0) throw new RangeError("Story intelligence budgets must be positive integers");
  }

  async analyze(items: StoryItemInput[], options: StoryIntelligenceOptions = {}): Promise<AnalyzedStoryItem[]> {
    const descriptions = new Map<number, string | null>();
    const candidates = items.map((item, index) => ({ item, index })).filter(({ item }) => item.payload.media && item.payload.text.trim().length < this.minimumMediaText);
    for (let offset = 0; offset < candidates.length; offset += this.mediaConcurrency) {
      await Promise.all(candidates.slice(offset, offset + this.mediaConcurrency).map(async ({ item, index }) => descriptions.set(index, await this.mediaDescriber.describe(item, options))));
    }
    const encode = (item: StoryItemInput, index: number) => JSON.stringify({ i: index, feed: item.feedName, title: item.payload.title, text: item.payload.text, url: item.payload.url, date: item.payload.date, mediaDescription: descriptions.get(index) ?? null });
    const batches = partition(items, this.maxItems, this.maxBytes, encode);
    const analyses = new Map<number, ItemAnalysisContent>();
    for (const batch of batches) {
      const raw = await this.client.complete(buildStoryAnalysisPrompt().systemPrompt, batch.map(({ encoded }) => encoded).join("\n"), options);
      const local = parseComplete(raw, analysisSchema, batch.map(({ index }) => index), "Story analysis");
      local.forEach((result) => {
        const globalIndex = result.i;
        analyses.set(globalIndex, {
          language: result.language,
          canonicalUrls: trustedCanonicalUrls(items[globalIndex]!),
          topics: [...new Set(result.topics.map((value) => value.trim()).filter(Boolean))],
          entities: [...new Set(result.entities.map((value) => value.trim()).filter(Boolean))],
          storyKey: normalizeKey(result.storyKey), storyTitle: result.storyTitle.trim(),
          developmentKey: normalizeKey(result.developmentKey), developmentType: normalizeKey(result.developmentType), developmentTitle: result.developmentTitle.trim(),
          mediaDescription: result.mediaDescription ?? descriptions.get(globalIndex) ?? null,
        });
      });
    }
    return await Promise.all(items.map(async (item, index) => ({ ...item, fingerprint: await fingerprintStoryItem(item), analysis: analyses.get(index)! })));
  }

  async resolve(
    items: AnalyzedStoryItem[],
    recentStories: StoryReference[] = [],
    options: StoryIntelligenceOptions = {},
  ): Promise<ResolvedStoryCandidate[]> {
    const itemParent = items.map((_, index) => index);
    const findItem = (index: number): number =>
      itemParent[index] === index ? index : (itemParent[index] = findItem(itemParent[index]!));
    const unionItems = (left: number, right: number) => {
      const a = findItem(left);
      const b = findItem(right);
      if (a !== b) itemParent[Math.max(a, b)] = Math.min(a, b);
    };
    const identities = new Map<string, number>();
    items.forEach((item, index) => {
      const keys = [
        `key:${normalizeKey(item.analysis.storyKey)}`,
        ...trustedCanonicalUrls(item).map((url) => `url:${url}`),
      ];
      keys.forEach((key) => {
        const previous = identities.get(key);
        if (previous === undefined) identities.set(key, index);
        else unionItems(index, previous);
      });
    });
    const exactGroups = new Map<number, AnalyzedStoryItem[]>();
    items.forEach((item, index) => {
      const root = findItem(index);
      exactGroups.set(root, [...(exactGroups.get(root) ?? []), item]);
    });
    const groups = [...exactGroups.values()];
    const nodeCount = groups.length + recentStories.length;
    const parent = Array.from({ length: nodeCount }, (_, index) => index);
    const find = (index: number): number =>
      parent[index] === index ? index : (parent[index] = find(parent[index]!));
    const union = (left: number, right: number) => {
      const a = find(left);
      const b = find(right);
      if (a !== b) parent[Math.max(a, b)] = Math.min(a, b);
    };
    const compactGroups = groups.map((group) => ({
      title: group[0]!.analysis.storyTitle,
      storyKeys: [...new Set(group.map((item) => normalizeKey(item.analysis.storyKey)))],
      topics: [...new Set(group.flatMap((item) => item.analysis.topics))],
      entities: [...new Set(group.flatMap((item) => item.analysis.entities))],
      developments: [...new Set(group.map((item) => item.analysis.developmentTitle))],
    }));
    const compactReferences = recentStories.map((reference) => ({
      title: reference.title,
      storyKeys: [normalizeKey(reference.canonicalKey)],
      topics: reference.topics,
      entities: reference.entities,
      developments: [] as string[],
    }));
    const compactNodes = [...compactGroups, ...compactReferences];
    const normalizedValues = compactNodes.map((node) => ({
      keys: new Set(node.storyKeys.map(normalizeKey)),
      topics: new Set(node.topics.map(normalizeComparable).filter(Boolean)),
      entities: new Set(node.entities.map(normalizeComparable).filter(Boolean)),
      titleTokens: new Set(normalizeComparable(node.title).split("-").filter((token) => token.length > 2)),
    }));
    const pairs: Array<{ left: number; right: number }> = [];
    for (let left = 0; left < groups.length; left++) {
      for (let right = left + 1; right < nodeCount; right++) {
        if (right >= groups.length && compactReferences[right - groups.length] === undefined) continue;
        const a = normalizedValues[left]!;
        const b = normalizedValues[right]!;
        if ([...a.keys].some((key) => b.keys.has(key))) {
          union(left, right);
          continue;
        }
        const entityOverlap = [...a.entities].some((value) => b.entities.has(value));
        const topicOverlap = [...a.topics].some((value) => b.topics.has(value));
        const titleOverlap = [...a.titleTokens].some((value) => b.titleTokens.has(value));
        if (entityOverlap || (topicOverlap && titleOverlap)) pairs.push({ left, right });
      }
    }
    const encodePair = (pair: { left: number; right: number }, index: number) =>
      JSON.stringify({ i: index, left: compactNodes[pair.left], right: compactNodes[pair.right] });
    const batches = partition(pairs, this.maxItems, this.maxBytes, encodePair);
    for (const batch of batches) {
      const raw = await this.client.complete(
        buildStoryResolutionPrompt().systemPrompt,
        batch.map(({ encoded }) => encoded).join("\n"),
        options,
      );
      parseComplete(
        raw,
        resolutionSchema,
        batch.map(({ index }) => index),
        "Story resolution",
      ).forEach((decision) => {
        if (decision.sameStory) {
          const pair = pairs[decision.i]!;
          union(pair.left, pair.right);
        }
      });
    }
    const merged = new Map<number, AnalyzedStoryItem[]>();
    groups.forEach((group, index) => {
      const root = find(index);
      merged.set(root, [...(merged.get(root) ?? []), ...group]);
    });
    return [...merged.entries()].map(([root, storyItems]) => {
      const matchingReferences = recentStories
        .filter((_, index) => find(groups.length + index) === root)
        .sort((a, b) => b.lastUpdatedAt - a.lastUpdatedAt || a.canonicalKey.localeCompare(b.canonicalKey));
      const storyKey = matchingReferences[0]?.canonicalKey ??
        normalizeKey(storyItems[0]!.analysis.storyKey);
      const developments = new Map<string, AnalyzedStoryItem[]>();
      storyItems.forEach((item) => {
        const key = normalizeKey(item.analysis.developmentKey);
        developments.set(key, [...(developments.get(key) ?? []), item]);
      });
      return {
        canonicalKey: storyKey,
        title: storyItems[0]!.analysis.storyTitle,
        topics: [...new Set(storyItems.flatMap((item) => item.analysis.topics))].sort(),
        entities: [...new Set(storyItems.flatMap((item) => item.analysis.entities))].sort(),
        developments: [...developments.entries()].sort(([a], [b]) => a.localeCompare(b))
          .map(([key, developmentItems]) => ({
            canonicalKey: `${storyKey}:${key}`,
            type: developmentItems[0]!.analysis.developmentType,
            title: developmentItems[0]!.analysis.developmentTitle,
            occurredAt: Math.min(...developmentItems.map((item) => item.payload.date)),
            items: developmentItems,
          })),
      };
    });
  }

  async classify(stories: PersistedStoryCandidate[], rules: StoryPreferenceRule[], threshold: number, options: StoryIntelligenceOptions = {}): Promise<StoryRelevanceDecision[]> {
    if (!Number.isFinite(threshold) || threshold < 0 || threshold > 100) throw new RangeError("Story relevance threshold must be between 0 and 100");
    const muteRules = rules.filter((rule) => rule.disposition === "mute");
    const active = rules.filter((rule) => rule.disposition !== "mute");
    const blocked = stories.map((story) => muteRules.filter((rule) => this.matchesRule(story, rule)).map((rule) => rule.id));
    const preferencePrompt = options.preferencePrompt?.trim() || null;
    if (!active.length && preferencePrompt === null) return stories.map((story, index) => ({ storyId: story.id, relevant: blocked[index]!.length === 0, score: blocked[index]!.length ? 0 : 100, matchedInterestRuleIds: [], blockedByInterestRuleIds: blocked[index]!, reason: blocked[index]!.length ? "Blocked by a mute rule." : "No active preference rules; included by default." }));
    const encode = (story: PersistedStoryCandidate, index: number) => JSON.stringify({ i: index, id: story.id, title: story.candidate.title, topics: story.candidate.topics, entities: story.candidate.entities, developments: story.candidate.developments.map((development) => ({ type: development.type, title: development.title })), rules: active, preferencePrompt });
    const batches = partition(stories, this.maxItems, this.maxBytes, encode);
    const scored = new Map<number, z.infer<typeof classificationSchema>>();
    for (const batch of batches) {
      const raw = await this.client.complete(buildStoryClassificationPrompt(preferencePrompt ?? undefined).systemPrompt, batch.map(({ encoded }) => encoded).join("\n"), options);
      parseComplete(raw, classificationSchema, batch.map(({ index }) => index), "Story classification").forEach((result) => {
        const allowed = new Set(active.map((rule) => rule.id));
        if (new Set(result.matchedRuleIds).size !== result.matchedRuleIds.length || result.matchedRuleIds.some((id) => !allowed.has(id))) throw new Error("Story classification returned duplicate or unknown rule IDs");
        scored.set(result.i, result);
      });
    }
    return stories.map((story, index) => { const result = scored.get(index)!; const muted = blocked[index]!; return { storyId: story.id, relevant: muted.length === 0 && result.score >= threshold, score: muted.length ? 0 : result.score, matchedInterestRuleIds: result.matchedRuleIds, blockedByInterestRuleIds: muted, reason: muted.length ? "Blocked by a mute rule." : result.reason }; });
  }

  private matchesRule(story: PersistedStoryCandidate, rule: StoryPreferenceRule): boolean {
    const needle = rule.label.normalize("NFKC").trim().toLocaleLowerCase("en-US");
    if (!needle) return false;
    const candidate = story.candidate;
    const values = rule.kind === "topic" ? candidate.topics : rule.kind === "entity" ? candidate.entities : rule.kind === "story_type" ? candidate.developments.map((value) => value.type) : [candidate.title, ...candidate.developments.flatMap((development) => [development.title, ...development.items.flatMap((item) => [item.payload.title ?? "", item.payload.text])])];
    return values.some((value) => { const normalized = value.normalize("NFKC").toLocaleLowerCase("en-US"); return rule.kind === "phrase" ? normalized.includes(needle) : normalized.trim() === needle; });
  }
}
