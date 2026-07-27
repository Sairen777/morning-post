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

const DEFAULT_STORY_ANALYSIS_MAX_ITEMS = 50;
const DEFAULT_STORY_CLASSIFICATION_MAX_ITEMS = 100;
const DEFAULT_STORY_TEXT_BYTES = 120_000;
const MAX_LABELS = 5;
const MAX_EVIDENCE_ITEMS = 3;
const MAX_EVIDENCE_BYTES = 400;

export function resolveStoryAnalysisMaxItems(override?: number): number {
  if (override !== undefined) {
    if (!Number.isInteger(override) || override <= 0) {
      throw new RangeError("Story analysis max items must be a positive integer");
    }
    return override;
  }
  return getSummarizerBudgetConfig().analysisMaxItemsPerRequest;
}

const analysisSchema = z.object({
  i: z.number().int().nonnegative(),
  m: z.number().int().nonnegative(),
  topics: personalizationLabelsSchema.optional(),
  entities: personalizationLabelsSchema.optional(),
  storyKey: z.string().optional(),
  storyTitle: z.string().optional(),
  developmentKey: z.string().optional(),
  developmentType: z.string().optional(),
  developmentTitle: z.string().optional(),
  evidence: z.preprocess(
    (value) => Array.isArray(value)
      ? value.filter((entry): entry is string => typeof entry === "string")
      : value,
    z.array(z.string()),
  ),
}).strict();

const classificationSchema = z.object({
  i: z.number().int().nonnegative(),
  score: z.number().int().min(0).max(100),
  matchedRuleIds: z.array(z.string()),
  reason: z.union([
    z.string().min(1),
    z.null().transform(() => "No classification reason provided."),
  ]),
}).strict();

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value !== null && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)).map(([key, child]) => `${JSON.stringify(key)}:${stableJson(child)}`).join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

function semanticStoryItem(item: StoryItemInput): unknown {
  const meta = item.payload.meta;
  return {
    feedId: item.feedId,
    feedName: item.feedName,
    sourceId: item.sourceId,
    payload: {
      connectorId: item.payload.connectorId,
      title: item.payload.title,
      text: item.payload.text,
      url: item.payload.url,
      date: item.payload.date,
      author: item.payload.author,
      media: item.payload.media,
      meta: meta === undefined ? undefined : {
        canonicalUrl: meta.canonicalUrl,
        canonicalUrls: meta.canonicalUrls,
        isGroup: meta.isGroup,
        messageKind: meta.messageKind,
        replyToMessageId: meta.replyToMessageId,
        threadRootId: meta.threadRootId,
        forwardedFrom: meta.forwardedFrom,
        groupedId: meta.groupedId,
      },
    },
  };
}

export async function fingerprintStoryItem(item: StoryItemInput): Promise<string> {
  return createHash("sha256").update(stableJson(semanticStoryItem(item))).digest("hex");
}

export interface StoryAnalysisUnit {
  items: StoryItemInput[];
  memberIndexes: number[];
}

function definiteThreadRoot(item: StoryItemInput): string | null {
  const value = item.payload.meta?.threadRootId;
  return (typeof value === "string" || typeof value === "number") && String(value).trim()
    ? String(value)
    : null;
}

const THREAD_GAP_MS = 30 * 60 * 1_000;
const ROOTLESS_GAP_MS = 2 * 60 * 1_000;

export function groupStoryAnalysisUnits(items: StoryItemInput[]): StoryAnalysisUnit[] {
  const units: StoryAnalysisUnit[] = [];
  const latestThreadUnit = new Map<string, StoryAnalysisUnit>();
  items.forEach((item, index) => {
    const root = definiteThreadRoot(item);
    const key = root === null ? null : `${item.feedId}\u0000${root}`;
    let unit = key === null ? undefined : latestThreadUnit.get(key);
    const previous = unit?.items.at(-1);
    if (unit && (unit.items.length >= 8 || !previous || Math.abs(item.payload.date - previous.payload.date) > THREAD_GAP_MS)) {
      unit = undefined;
    }
    if (root === null && item.payload.meta?.isGroup === true && item.payload.author) {
      const adjacent = units.at(-1);
      const prior = adjacent?.items.at(-1);
      if (
        adjacent && adjacent.items.length < 4 && prior &&
        definiteThreadRoot(prior) === null &&
        prior.feedId === item.feedId &&
        prior.payload.author === item.payload.author &&
        Math.abs(item.payload.date - prior.payload.date) <= ROOTLESS_GAP_MS
      ) unit = adjacent;
    }
    if (!unit) {
      unit = { items: [], memberIndexes: [] };
      units.push(unit);
      if (key !== null) latestThreadUnit.set(key, unit);
    }
    unit.items.push(item);
    unit.memberIndexes.push(index);
  });
  return units;
}

export function partitionStoryAnalysisUnits(
  items: StoryItemInput[],
  unitSizes: number[],
): StoryAnalysisUnit[] {
  if (
    unitSizes.some((size) => !Number.isInteger(size) || size <= 0) ||
    unitSizes.reduce((total, size) => total + size, 0) !== items.length
  ) {
    throw new RangeError(
      "Analysis unit sizes must be positive integers covering every input item",
    );
  }
  let offset = 0;
  return unitSizes.map((size) => {
    const start = offset;
    offset += size;
    return {
      items: items.slice(start, offset),
      memberIndexes: Array.from({ length: size }, (_, index) => start + index),
    };
  });
}
type MemberResultDiagnostics = {
  responseKind: "array" | "malformed-json" | "non-array";
  unknown: string[];
  malformed: string[];
  duplicates: string[];
  unassignable: number;
};
type ParsedMemberResults = {
  resolved: Array<z.infer<typeof analysisSchema>>;
  unresolved: Array<{ i: number; m: number }>;
  unexpected: boolean;
  diagnostics: MemberResultDiagnostics;
};
function parseMemberResults(
  raw: string,
  expected: Array<{ i: number; m: number }>,
): ParsedMemberResults {
  const diagnostics: MemberResultDiagnostics = {
    responseKind: "array",
    unknown: [],
    malformed: [],
    duplicates: [],
    unassignable: 0,
  };
  let parsed: unknown;
  try {
    parsed = JSON.parse(jsonrepair(raw));
  } catch {
    diagnostics.responseKind = "malformed-json";
    return {
      resolved: [],
      unresolved: expected,
      unexpected: true,
      diagnostics,
    };
  }
  if (!Array.isArray(parsed)) {
    diagnostics.responseKind = "non-array";
    return {
      resolved: [],
      unresolved: expected,
      unexpected: true,
      diagnostics,
    };
  }
  const expectedKeys = new Set(expected.map(({ i, m }) => `${i}:${m}`));
  const valuesByKey = new Map<
    string,
    Array<z.infer<typeof analysisSchema>>
  >();
  for (const candidate of parsed) {
    const result = analysisSchema.safeParse(candidate);
    if (!result.success) {
      if (
        candidate !== null &&
        typeof candidate === "object" &&
        "i" in candidate &&
        "m" in candidate &&
        typeof candidate.i === "number" &&
        typeof candidate.m === "number"
      ) {
        const key = `${candidate.i}:${candidate.m}`;
        if (expectedKeys.has(key)) {
          const fields = [...new Set(result.error.issues.map((issue) =>
            String(issue.path[0] ?? "record")
          ))].sort().join(",");
          diagnostics.malformed.push(`${key}:${fields}`);
        } else {
          diagnostics.unknown.push(key);
        }
      } else {
        diagnostics.unassignable++;
      }
      continue;
    }
    const key = `${result.data.i}:${result.data.m}`;
    if (!expectedKeys.has(key)) {
      diagnostics.unknown.push(key);
      continue;
    }
    const matches = valuesByKey.get(key);
    if (matches) matches.push(result.data);
    else valuesByKey.set(key, [result.data]);
  }
  const resolved: Array<z.infer<typeof analysisSchema>> = [];
  const unresolved: Array<{ i: number; m: number }> = [];
  for (const member of expected) {
    const key = `${member.i}:${member.m}`;
    const matches = valuesByKey.get(key);
    if (matches?.length === 1) resolved.push(matches[0]!);
    else {
      unresolved.push(member);
      if (matches && matches.length > 1) diagnostics.duplicates.push(key);
    }
  }
  const unexpected = diagnostics.responseKind !== "array" ||
    diagnostics.unknown.length > 0 ||
    diagnostics.unassignable > 0;
  return { resolved, unresolved, unexpected, diagnostics };
}

function memberIntegrityFailure(parsed: ParsedMemberResults): Error {
  const compact = (values: string[]): string =>
    values.length === 0 ? "none" : values.slice(0, 5).join(",");
  return new Error(
    "Story analysis could not recover exact member coverage " +
      `(unresolved=${parsed.unresolved.length}, ` +
      `response=${parsed.diagnostics.responseKind}, ` +
      `unknown=${compact(parsed.diagnostics.unknown)}, ` +
      `malformed=${compact(parsed.diagnostics.malformed)}, ` +
      `duplicates=${compact(parsed.diagnostics.duplicates)}, ` +
      `unassignable=${parsed.diagnostics.unassignable})`,
  );
}


export async function fingerprintStoryAnalysisUnit(unit: StoryAnalysisUnit | StoryItemInput[]): Promise<string> {
  const items = Array.isArray(unit) ? unit : unit.items;
  return createHash("sha256").update(stableJson(items.map(semanticStoryItem))).digest("hex");
}

export async function fingerprintStoryAnalysisMember(unit: StoryAnalysisUnit, memberIndex: number): Promise<string> {
  if (unit.items.length === 1) return fingerprintStoryItem(unit.items[0]!);
  return createHash("sha256").update(stableJson({
    context: unit.items.map(semanticStoryItem),
    member: memberIndex,
  })).digest("hex");
}

function normalizeKeyOrNull(value: string | undefined): string | null {
  if (value === undefined) return null;
  const normalized = value.normalize("NFKC").trim().toLocaleLowerCase("en-US")
    .replace(/[^\p{L}\p{N}]+/gu, "-").replace(/^-+|-+$/g, "");
  return normalized || null;
}

function normalizeKey(value: string): string {
  const normalized = normalizeKeyOrNull(value);
  if (normalized === null) {
    throw new Error("Story identity key must contain a letter or number");
  }
  return normalized;
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

function parseIndexedResults<Output extends { i: number }, Input>(
  raw: string,
  schema: z.ZodType<Output, z.ZodTypeDef, Input>,
  expectedIndexes: readonly number[],
  label: string,
): { values: Output[]; missingIndexes: number[] } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(jsonrepair(raw));
  } catch (error) {
    throw new Error(`${label} returned malformed JSON`, { cause: error });
  }
  const values = z.array(schema).parse(parsed);
  const expected = new Set(expectedIndexes);
  const returned = new Set<number>();
  for (const value of values) {
    if (!expected.has(value.i) || returned.has(value.i)) {
      throw new Error(`${label} returned duplicate or unknown indexes`);
    }
    returned.add(value.i);
  }
  return {
    values,
    missingIndexes: expectedIndexes.filter((index) => !returned.has(index)),
  };
}

function partition<T>(
  values: T[],
  maxItems: number,
  maxBytes: number,
  encode: (value: T, index: number) => string,
  bytesPerItem = 0,
): Array<Array<{ value: T; index: number; encoded: string }>> {
  const batches: Array<Array<{ value: T; index: number; encoded: string }>> = [];
  let batch: Array<{ value: T; index: number; encoded: string }> = [];
  let bytes = 0;
  values.forEach((value, index) => {
    const encoded = encode(value, index);
    const size = new TextEncoder().encode(encoded).length + bytesPerItem;
    if (size > maxBytes) {
      throw new RangeError("A model input record exceeds the request byte budget");
    }
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
        onAttempt: options.onMediaAttempt ?? options.onAttempt,
        maxItemsPerChunk: 1,
      },
    );
    const description = points.map((point) => point.text.trim()).filter(Boolean).join(" ");
    return description || fallback;
  }
}

export class OpenAICompatibleStoryIntelligenceService implements StoryIntelligenceService {
  private readonly analysisClient: ChatClient;
  private readonly classificationClient: ChatClient;
  private readonly mediaDescriber: StoryMediaDescriber;
  private readonly maxItems: number;
  private readonly classificationMaxItems: number;
  private readonly maxBytes: number;
  private readonly minimumMediaText: number;
  private readonly mediaConcurrency: number;
  private readonly mediaDescriptions = new Map<string, Promise<string | null>>();

  constructor(options: OpenAICompatibleStoryIntelligenceOptions = {}) {
    const budget = getSummarizerBudgetConfig();
    const models = options.models ?? getSummarizerRuntimeConfig();
    const clientOptions = {
      retryBaseDelayMs: options.retryBaseDelayMs,
      allowRemote: resolveAllowRemoteSummarization(options.allowRemoteSummarization),
      fetch: options.fetch,
    };
    this.analysisClient = options.client ?? new OpenAICompatibleChatClient(models.analysis, clientOptions);
    this.classificationClient = options.client ?? new OpenAICompatibleChatClient(models.classification, clientOptions);
    this.mediaDescriber = options.mediaDescriber ??
      new ModelBackedMediaDescriber(options.mediaSummarizer ??
        new OpenAICompatibleSummarizerService({
          models,
          retryBaseDelayMs: options.retryBaseDelayMs,
          allowRemoteSummarization: options.allowRemoteSummarization,
          maxItemsPerChunk: 1,
        }));
    this.maxItems = resolveStoryAnalysisMaxItems(options.maxItemsPerChunk);
    this.classificationMaxItems = budget.classificationMaxItemsPerRequest;
    this.maxBytes = options.maxTextBytesPerChunk ?? DEFAULT_STORY_TEXT_BYTES;
    this.minimumMediaText = options.minimumTextLengthForMediaDescription ?? 80;
    this.mediaConcurrency = options.maxConcurrentMediaDescriptions ?? 1;
    if (!Number.isInteger(this.maxItems) || this.maxItems <= 0 || !Number.isInteger(this.classificationMaxItems) || this.classificationMaxItems <= 0 || !Number.isInteger(this.maxBytes) || this.maxBytes <= 0 || !Number.isInteger(this.mediaConcurrency) || this.mediaConcurrency <= 0) throw new RangeError("Story intelligence budgets must be positive integers");
  }

  async analyze(items: StoryItemInput[], options: StoryIntelligenceOptions = {}): Promise<AnalyzedStoryItem[]> {
    const budget = getSummarizerBudgetConfig();
    const descriptions = new Map<number, string | null>();
    const candidates = items.map((item, index) => ({ item, index })).filter(({ item }) => item.payload.media && item.payload.text.trim().length < this.minimumMediaText);
    for (let offset = 0; offset < candidates.length; offset += this.mediaConcurrency) {
      await Promise.all(candidates.slice(offset, offset + this.mediaConcurrency).map(async ({ item, index }) => {
        const identity = createHash("sha256")
          .update(stableJson(semanticStoryItem(item)))
          .digest("hex");
        let pending = this.mediaDescriptions.get(identity);
        if (!pending) {
          pending = this.mediaDescriber.describe(item, options);
          this.mediaDescriptions.set(identity, pending);
          void pending.catch(() => {
            if (this.mediaDescriptions.get(identity) === pending) {
              this.mediaDescriptions.delete(identity);
            }
          });
        }
        descriptions.set(index, await pending);
      }));
    }
    const units = options.analysisUnitSizes === undefined
      ? groupStoryAnalysisUnits(items)
      : partitionStoryAnalysisUnits(items, options.analysisUnitSizes);
    const encoder = new TextEncoder();
    const serializedBytes = (value: string): number =>
      encoder.encode(value).length;
    const minimumUsefulTextBytes = 2_000;
    const maximumUsefulTextBytes = 16_000;
    const maximumMembers = Math.max(1, Math.min(
      this.maxItems,
      100,
      Math.floor(budget.analysisMaxOutputTokens / 300),
    ));
    type AnalysisRequestRecord = {
      value: StoryAnalysisUnit;
      index: number;
      memberIndexes: number[];
      encoded: string;
    };
    const serializeRecord = (
      unit: StoryAnalysisUnit,
      index: number,
      memberIndexes: number[],
      textByteLimit: number,
    ): string =>
      JSON.stringify({
        i: index,
        members: memberIndexes.map((memberIndex) => {
          const item = unit.items[memberIndex]!;
          return {
            m: memberIndex,
            feed: truncateUtf8(item.feedName, 200),
            title: item.payload.title === null
              ? null
              : truncateUtf8(item.payload.title, 300),
            text: truncateUtf8(item.payload.text, textByteLimit),
            url: item.payload.url === null
              ? null
              : truncateUtf8(item.payload.url, 500),
            date: item.payload.date,
            author: item.payload.author === null
              ? null
              : truncateUtf8(item.payload.author, 300),
            mediaDescription:
              descriptions.get(unit.memberIndexes[memberIndex]!) == null
                ? null
                : truncateUtf8(
                  descriptions.get(unit.memberIndexes[memberIndex]!)!,
                  1_000,
                ),
          };
        }),
      });
    const encodeRecord = (
      unit: StoryAnalysisUnit,
      index: number,
      memberIndexes: number[],
    ): string | null => {
      const longestText = memberIndexes.reduce(
        (maximum, memberIndex) =>
          Math.max(
            maximum,
            serializedBytes(unit.items[memberIndex]!.payload.text),
          ),
        0,
      );
      const minimumLimit = Math.min(minimumUsefulTextBytes, longestText);
      const minimum = serializeRecord(
        unit,
        index,
        memberIndexes,
        minimumLimit,
      );
      if (serializedBytes(minimum) + 1 > this.maxBytes) return null;
      let low = minimumLimit;
      let high = Math.min(longestText, maximumUsefulTextBytes);
      let encoded = minimum;
      while (low <= high) {
        const candidateLimit = Math.floor((low + high) / 2);
        const candidate = serializeRecord(
          unit,
          index,
          memberIndexes,
          candidateLimit,
        );
        if (serializedBytes(candidate) + 1 <= this.maxBytes) {
          encoded = candidate;
          low = candidateLimit + 1;
        } else {
          high = candidateLimit - 1;
        }
      }
      return encoded;
    };
    const requestRecords: AnalysisRequestRecord[] = [];
    const appendRecord = (
      unit: StoryAnalysisUnit,
      index: number,
      memberIndexes: number[],
    ): void => {
      if (memberIndexes.length > maximumMembers) {
        for (let offset = 0; offset < memberIndexes.length; offset += maximumMembers) {
          appendRecord(unit, index, memberIndexes.slice(offset, offset + maximumMembers));
        }
        return;
      }
      const encoded = encodeRecord(unit, index, memberIndexes);
      if (encoded !== null) {
        requestRecords.push({ value: unit, index, memberIndexes, encoded });
        return;
      }
      if (memberIndexes.length === 1) {
        throw new RangeError(
          `Story analysis maxTextBytesPerChunk (${this.maxBytes}) cannot fit member metadata and ${minimumUsefulTextBytes} bytes of useful text context`,
        );
      }
      const middle = Math.ceil(memberIndexes.length / 2);
      appendRecord(unit, index, memberIndexes.slice(0, middle));
      appendRecord(unit, index, memberIndexes.slice(middle));
    };
    units.forEach((unit, index) =>
      appendRecord(unit, index, unit.items.map((_, memberIndex) => memberIndex))
    );
    const maximumRecords = 50;
    const batches: AnalysisRequestRecord[][] = [];
    let batch: AnalysisRequestRecord[] = [];
    let batchBytes = 0;
    let batchMembers = 0;
    for (const record of requestRecords) {
      const size = serializedBytes(record.encoded) + (batch.length ? 1 : 0);
      const members = record.memberIndexes.length;
      if (batch.length && (
        batch.length >= maximumRecords ||
        batchMembers + members > maximumMembers ||
        batchBytes + size > this.maxBytes
      )) {
        batches.push(batch);
        batch = [];
        batchBytes = 0;
        batchMembers = 0;
      }
      batchBytes += serializedBytes(record.encoded) + (batch.length ? 1 : 0);
      batch.push(record);
      batchMembers += members;
    }
    if (batch.length) batches.push(batch);

    const completionOptions = {
      ...options,
      maxOutputTokens: budget.analysisMaxOutputTokens,
      maxAttempts: budget.analysisMaxAttempts,
      jsonOutput: true,
    } as StoryIntelligenceOptions;
    const completeAnalysisBatch = async (
      requestBatch: AnalysisRequestRecord[],
    ): Promise<Array<z.infer<typeof analysisSchema>>> => {
      const raw = await this.analysisClient.complete(
        buildStoryAnalysisPrompt().systemPrompt,
        requestBatch.map(({ encoded }) => encoded).join("\n"),
        completionOptions,
      );
      const expected = requestBatch.flatMap(({ memberIndexes, index }) =>
        memberIndexes.map((m) => ({ i: index, m }))
      );
      const parsed = parseMemberResults(raw, expected);
      if (parsed.unresolved.length === 0 && !parsed.unexpected) {
        return parsed.resolved;
      }

      const retryMembers = parsed.unexpected ? expected : parsed.unresolved;
      const recovered = parsed.unexpected ? [] : [...parsed.resolved];
      const retryResults: Array<z.infer<typeof analysisSchema> | undefined> =
        new Array(retryMembers.length);
      let nextRetry = 0;
      const retryWorker = async (): Promise<void> => {
        for (;;) {
          const retryIndex = nextRetry++;
          if (retryIndex >= retryMembers.length) return;
          const { i, m } = retryMembers[retryIndex]!;
          const unit = units[i]!;
          const encoded = encodeRecord(unit, i, [m]);
          if (encoded === null) {
            throw new RangeError(
              "Story analysis retry member exceeds the request byte budget",
            );
          }
          const isolated = JSON.parse(encoded) as {
            i: number;
            members: Array<{ m: number }>;
          };
          isolated.i = 0;
          isolated.members[0]!.m = 0;
          const retryRaw = await this.analysisClient.complete(
            buildStoryAnalysisPrompt().systemPrompt,
            JSON.stringify(isolated),
            completionOptions,
          );
          const retry = parseMemberResults(retryRaw, [{ i: 0, m: 0 }]);
          if (retry.unresolved.length !== 0 || retry.unexpected) {
            throw memberIntegrityFailure(retry);
          }
          retryResults[retryIndex] = { ...retry.resolved[0]!, i, m };
        }
      };
      await Promise.all(
        Array.from(
          { length: Math.min(3, retryMembers.length) },
          () => retryWorker(),
        ),
      );
      recovered.push(...retryResults.map((result) => result!));
      return recovered;
    };

    const analyses = new Map<number, ItemAnalysisContent>();
    for (const requestBatch of batches) {
      const local = await completeAnalysisBatch(requestBatch);
      local.forEach((result) => {
        const unit = units[result.i]!;
        const itemIndex = unit.memberIndexes[result.m]!;
        const item = unit.items[result.m]!;
        const itemIdentity = normalizeKey(item.itemId);
        const storyKey = normalizeKeyOrNull(result.storyKey) ??
          `item-${itemIdentity}`;
        const developmentKey = normalizeKeyOrNull(result.developmentKey) ??
          `development-${itemIdentity}`;
        const evidenceSource = `${item.payload.title ?? ""}\n${item.payload.text}`;
        analyses.set(itemIndex, {
          language: null,
          canonicalUrls: trustedCanonicalUrls(item),
          topics: [...new Set((result.topics ?? []).map((value) => value.trim()).filter(Boolean))].slice(0, MAX_LABELS),
          entities: [...new Set((result.entities ?? []).map((value) => value.trim()).filter(Boolean))].slice(0, MAX_LABELS),
          storyKey,
          storyTitle: result.storyTitle?.trim() ||
            item.payload.title?.trim() || storyKey,
          developmentKey,
          developmentType: normalizeKeyOrNull(result.developmentType) ??
            developmentKey,
          developmentTitle: result.developmentTitle?.trim() ||
            item.payload.title?.trim() || developmentKey,
          mediaDescription: descriptions.get(itemIndex) ?? null,
          evidence: [...new Set(result.evidence
            .map((value) => value.trim())
            .filter((value) =>
              value.length > 0 &&
              serializedBytes(value) <= MAX_EVIDENCE_BYTES &&
              evidenceSource.includes(value)
            ))].slice(0, MAX_EVIDENCE_ITEMS),
        });
      });
    }
    const fingerprints = await Promise.all(units.flatMap((unit) =>
      unit.items.map((_, memberIndex) => fingerprintStoryAnalysisMember(unit, memberIndex))
    ));
    let fingerprintIndex = 0;
    const fingerprintByIndex = new Map<number, string>();
    units.forEach((unit) => unit.memberIndexes.forEach((index) => {
      fingerprintByIndex.set(index, fingerprints[fingerprintIndex++]!);
    }));
    return items.map((item, index) => ({
      ...item,
      fingerprint: fingerprintByIndex.get(index)!,
      analysis: analyses.get(index)!,
    }));
  }

  async resolve(
    items: AnalyzedStoryItem[],
    recentStories: StoryReference[] = [],
    _options: StoryIntelligenceOptions = {},
  ): Promise<ResolvedStoryCandidate[]> {
    const parent = items.map((_, index) => index);
    const find = (index: number): number =>
      parent[index] === index ? index : (parent[index] = find(parent[index]!));
    const union = (left: number, right: number) => {
      const a = find(left);
      const b = find(right);
      if (a !== b) parent[Math.max(a, b)] = Math.min(a, b);
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
        else union(index, previous);
      });
    });

    const groups = new Map<number, AnalyzedStoryItem[]>();
    items.forEach((item, index) => {
      const root = find(index);
      groups.set(root, [...(groups.get(root) ?? []), item]);
    });
    const referencesByKey = new Map<string, StoryReference[]>();
    recentStories.forEach((reference) => {
      const key = normalizeKey(reference.canonicalKey);
      referencesByKey.set(key, [...(referencesByKey.get(key) ?? []), reference]);
    });

    return [...groups.values()].map((storyItems) => {
      const currentKeys = new Set(storyItems.map((item) => normalizeKey(item.analysis.storyKey)));
      const matchingReferences = [...currentKeys]
        .flatMap((key) => referencesByKey.get(key) ?? [])
        .sort((a, b) =>
          b.lastUpdatedAt - a.lastUpdatedAt ||
          a.canonicalKey.localeCompare(b.canonicalKey)
        );
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
    const encode = (story: PersistedStoryCandidate, index: number) => JSON.stringify({ i: index, id: story.id, title: story.candidate.title, topics: story.candidate.topics.slice(0, MAX_LABELS), entities: story.candidate.entities.slice(0, MAX_LABELS), developments: story.candidate.developments.map((development) => ({ type: development.type, title: development.title, evidence: truncateUtf8(development.items.map((item) => item.payload.text.trim()).filter(Boolean).join("\n"), MAX_EVIDENCE_BYTES) })) });
    const sharedContext = JSON.stringify({ activeRules: active, preferencePrompt });
    const candidateBytes = this.maxBytes - new TextEncoder().encode(sharedContext).length;
    if (stories.length && candidateBytes <= 1) throw new RangeError("Story classification context exceeds the request byte budget");
    const batches = partition(stories, this.classificationMaxItems, candidateBytes, encode, 1);
    const scored = new Map<number, z.infer<typeof classificationSchema>>();
    const allowedRuleIds = new Set(active.map((rule) => rule.id));
    const budget = getSummarizerBudgetConfig();
    const completionOptions = {
      ...options,
      maxOutputTokens: budget.classificationMaxOutputTokens,
      maxAttempts: budget.classificationMaxAttempts,
      jsonOutput: true,
    };
    const systemPrompt = buildStoryClassificationPrompt().systemPrompt;
    type ClassificationRequestRecord = (typeof batches)[number][number];
    const classifyBatch = async (
      requestBatch: ClassificationRequestRecord[],
    ): Promise<void> => {
      const raw = await this.classificationClient.complete(
        systemPrompt,
        [sharedContext, ...requestBatch.map(({ encoded }) => encoded)].join("\n"),
        completionOptions,
      );
      const { values, missingIndexes } = parseIndexedResults(
        raw,
        classificationSchema,
        requestBatch.map(({ index }) => index),
        "Story classification",
      );
      for (const result of values) {
        if (
          new Set(result.matchedRuleIds).size !== result.matchedRuleIds.length ||
          result.matchedRuleIds.some((id) => !allowedRuleIds.has(id))
        ) {
          throw new Error(
            "Story classification returned duplicate or unknown rule IDs",
          );
        }
      }
      for (const result of values) scored.set(result.i, result);
      if (missingIndexes.length === 0) return;

      if (values.length === 0) {
        if (requestBatch.length === 1) {
          throw new Error("Story classification returned 0 results for 1 inputs");
        }
        const middle = Math.ceil(requestBatch.length / 2);
        await classifyBatch(requestBatch.slice(0, middle));
        await classifyBatch(requestBatch.slice(middle));
        return;
      }

      const missing = new Set(missingIndexes);
      await classifyBatch(
        requestBatch.filter(({ index }) => missing.has(index)),
      );
    };
    for (const batch of batches) await classifyBatch(batch);
    if (scored.size !== stories.length) {
      throw new Error(
        `Story classification returned ${scored.size} results for ${stories.length} inputs`,
      );
    }
    return stories.map((story, index) => {
      const result = scored.get(index);
      if (result === undefined) {
        throw new Error(`Story classification omitted input index ${index}`);
      }
      const muted = blocked[index]!;
      return {
        storyId: story.id,
        relevant: muted.length === 0 && result.score >= threshold,
        score: muted.length ? 0 : result.score,
        matchedInterestRuleIds: result.matchedRuleIds,
        blockedByInterestRuleIds: muted,
        reason: muted.length ? "Blocked by a mute rule." : result.reason,
      };
    });
  }

  private matchesRule(story: PersistedStoryCandidate, rule: StoryPreferenceRule): boolean {
    const needle = rule.label.normalize("NFKC").trim().toLocaleLowerCase("en-US");
    if (!needle) return false;
    const candidate = story.candidate;
    const values = rule.kind === "topic" ? candidate.topics : rule.kind === "entity" ? candidate.entities : rule.kind === "story_type" ? candidate.developments.map((value) => value.type) : [candidate.title, ...candidate.developments.flatMap((development) => [development.title, ...development.items.flatMap((item) => [item.payload.title ?? "", item.payload.text])])];
    return values.some((value) => { const normalized = value.normalize("NFKC").toLocaleLowerCase("en-US"); return rule.kind === "phrase" ? normalized.includes(needle) : normalized.trim() === needle; });
  }
}
