import { readFile, stat } from "node:fs/promises";
import { jsonrepair } from "jsonrepair";
import type { NormalizedItem } from "../connectors/connector.types.ts";
import { ConnectorId } from "../constants.ts";
import {
  getSummarizerBudgetConfig,
  getSummarizerRuntimeConfig,
  resolveAllowRemoteSummarization,
  type SummarizerRuntimeConfig,
} from "../config.ts";
import { sanitizeErrorForOps } from "../server/error-sanitizer.ts";
import {
  ModelApiError,
  OpenAICompatibleChatClient,
} from "./openai-compatible-client.ts";
import { buildVisionAnalysisPrompt } from "./prompts.ts";
import type {
  ContentPart,
  ImagePart,
  SummarizationDiagnostic,
  SummarizeOptions,
  SummarizerService,
  SummaryPoint,
  SummaryRuleset,
  TextPart,
} from "./summarizer.types.ts";
import { isEmojiOnly } from "../utils/text.ts";

export interface OpenAICompatibleSummarizerOptions {
  models?: SummarizerRuntimeConfig;
  retryBaseDelayMs?: number;
  maxTextBytesPerChunk?: number;
  maxItemsPerChunk?: number;
  maxImageBytes?: number;
  allowRemoteSummarization?: boolean;
}

interface VisionRunState {
  available: boolean;
}

interface ImageEntry {
  index: number;
  imageNumber: number;
  part: ImagePart;
}

interface IndexedChunkContent {
  textParts: TextPart[];
  itemIndexByTextPart: Array<number | undefined>;
  multimodalParts: ContentPart[];
  visionParts: ContentPart[];
  indexedItems: NormalizedItem[];
  imageEntries: ImageEntry[];
}

interface MergeBatch {
  items: NormalizedItem[];
  userContent: string;
}

interface SummarizerRequestOptions {
  signal?: AbortSignal;
  requestTimeoutMs?: number;
  onDiagnostic?: SummarizeOptions["onDiagnostic"];
}

interface ChunkExecutionContext {
  chunkIndex: number;
  chunkCount: number;
}

interface ResolvedSummarizeOptions extends SummarizerRequestOptions {
  maxTextBytesPerChunk: number;
  maxItemsPerChunk: number;
  maxImageBytes: number;
  summaryMode: "aggregate" | "article";
}

function partitionItems(
  items: NormalizedItem[],
  maxItems: number,
  maxTextBytes: number,
): NormalizedItem[][] {
  const chunks: NormalizedItem[][] = [];
  let current: NormalizedItem[] = [];
  let currentBytes = 0;

  for (const item of items) {
    const textLen = item.text ? item.text.length : 0;
    const effectiveLen = Math.min(textLen, maxTextBytes);
    if (
      current.length > 0 &&
      (current.length >= maxItems || currentBytes + effectiveLen > maxTextBytes)
    ) {
      chunks.push(current);
      current = [];
      currentBytes = 0;
    }
    current.push(item);
    currentBytes += effectiveLen;
  }

  if (current.length > 0) chunks.push(current);
  return chunks;
}

function splitTextByUtf8Bytes(text: string, maxBytes: number): string[] {
  if (
    !Number.isFinite(maxBytes) || !Number.isInteger(maxBytes) || maxBytes <= 0
  ) {
    throw new Error(
      "Article maxTextBytesPerChunk must be a positive finite integer",
    );
  }
  const chunks: string[] = [];
  let chunkStart = 0;
  let chunkBytes = 0;
  for (let index = 0; index < text.length;) {
    const codePoint = text.codePointAt(index)!;
    const scalarWidth = codePoint <= 0x7f
      ? 1
      : codePoint <= 0x7ff
      ? 2
      : codePoint <= 0xffff
      ? 3
      : 4;
    if (scalarWidth > maxBytes) {
      throw new Error(
        `Article maxTextBytesPerChunk ${maxBytes} is smaller than a ${scalarWidth}-byte Unicode scalar`,
      );
    }
    if (chunkBytes + scalarWidth > maxBytes) {
      chunks.push(text.slice(chunkStart, index));
      chunkStart = index;
      chunkBytes = 0;
    }
    chunkBytes += scalarWidth;
    index += codePoint > 0xffff ? 2 : 1;
  }
  if (chunkStart < text.length || text.length === 0) {
    chunks.push(text.slice(chunkStart));
  }
  return chunks;
}

function truncateUtf8AtScalarBoundary(text: string, maxBytes: number): string {
  let bytes = 0;
  let end = 0;
  for (let index = 0; index < text.length;) {
    const codePoint = text.codePointAt(index)!;
    const scalarBytes = codePoint <= 0x7f
      ? 1
      : codePoint <= 0x7ff
      ? 2
      : codePoint <= 0xffff
      ? 3
      : 4;
    if (bytes + scalarBytes > maxBytes) break;
    bytes += scalarBytes;
    index += codePoint > 0xffff ? 2 : 1;
    end = index;
  }
  return text.slice(0, end);
}

function encodeBytesAsBase64(bytes: Uint8Array): string {
  const binaryChunks: string[] = [];
  const chunkSize = 32_768;
  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    binaryChunks.push(
      String.fromCharCode(...bytes.subarray(offset, offset + chunkSize)),
    );
  }
  return btoa(binaryChunks.join(""));
}

export class OpenAICompatibleSummarizerService implements SummarizerService {
  private readonly models: SummarizerRuntimeConfig;
  private readonly summarizerClient: OpenAICompatibleChatClient;
  private readonly visionClient: OpenAICompatibleChatClient;
  private readonly retryBaseDelayMs: number;
  private readonly maxTextBytesPerChunk: number;
  private readonly maxItemsPerChunk: number;
  private readonly maxImageBytes: number;

  constructor(options: OpenAICompatibleSummarizerOptions = {}) {
    const config = getSummarizerBudgetConfig();
    this.models = options.models ?? getSummarizerRuntimeConfig();
    const allowRemoteSummarization = resolveAllowRemoteSummarization(
      options.allowRemoteSummarization,
    );
    this.retryBaseDelayMs = options.retryBaseDelayMs ?? 1000;
    this.maxTextBytesPerChunk = options.maxTextBytesPerChunk ??
      config.summarizerTextBytesPerChunk;
    this.maxItemsPerChunk = options.maxItemsPerChunk ??
      config.summarizerMaxItemsPerChunk;
    this.maxImageBytes = options.maxImageBytes ??
      config.summarizerMaxImageBytes;
    this.summarizerClient = new OpenAICompatibleChatClient(
      this.models.summarizer,
      {
        retryBaseDelayMs: this.retryBaseDelayMs,
        allowRemote: allowRemoteSummarization,
      },
    );
    this.visionClient = new OpenAICompatibleChatClient(this.models.vision, {
      retryBaseDelayMs: this.retryBaseDelayMs,
      allowRemote: allowRemoteSummarization,
    });
  }

  public async summarize(
    items: NormalizedItem[],
    rules: SummaryRuleset,
    options: SummarizeOptions = {},
  ): Promise<SummaryPoint[]> {
    const state: VisionRunState = { available: true };
    return await this.summarizeInternal(items, rules, {
      maxTextBytesPerChunk: options.maxTextBytesPerChunk ??
        this.maxTextBytesPerChunk,
      maxItemsPerChunk: options.maxItemsPerChunk ?? this.maxItemsPerChunk,
      maxImageBytes: options.maxImageBytes ?? this.maxImageBytes,
      signal: options.signal,
      requestTimeoutMs: options.requestTimeoutMs,
      onDiagnostic: options.onDiagnostic,
      summaryMode: options.summaryMode ?? "aggregate",
    }, state);
  }

  private async summarizeInternal(
    items: NormalizedItem[],
    rules: SummaryRuleset,
    options: ResolvedSummarizeOptions,
    state: VisionRunState,
  ): Promise<SummaryPoint[]> {
    if (options.summaryMode === "article") {
      if (items.length !== 1) {
        throw new Error("Article summarization requires exactly one item");
      }
      const item = items[0];
      if (
        !item.text.trim() && item.media?.type !== "photo" &&
        item.media?.type !== "album"
      ) return [];
      const textChunks = splitTextByUtf8Bytes(
        item.text,
        options.maxTextBytesPerChunk,
      );
      const points: SummaryPoint[] = [];
      for (let index = 0; index < textChunks.length; index++) {
        const chunkItem: NormalizedItem = {
          ...item,
          text: textChunks[index],
          media: index === 0 ? item.media : undefined,
        };
        points.push(
          ...await this.processChunkWithDiagnostics(
            [chunkItem],
            rules,
            options,
            state,
            {
              chunkIndex: index + 1,
              chunkCount: textChunks.length,
            },
          ),
        );
      }
      return points;
    }
    const filtered = items.filter((item) => {
      const hasPhoto = item.media?.type === "photo" ||
        item.media?.type === "album";
      if (!item.text.trim() && !hasPhoto) return false;
      if (isEmojiOnly(item.text) && !hasPhoto) return false;
      return true;
    });
    if (filtered.length === 0) return [];

    const chunks = partitionItems(
      filtered,
      options.maxItemsPerChunk,
      options.maxTextBytesPerChunk,
    );
    const chunkResults: SummaryPoint[][] = [];
    for (let chunkIndex = 0; chunkIndex < chunks.length; chunkIndex++) {
      chunkResults.push(
        await this.processChunkWithDiagnostics(
          chunks[chunkIndex],
          rules,
          options,
          state,
          {
            chunkIndex: chunkIndex + 1,
            chunkCount: chunks.length,
          },
        ),
      );
    }
    if (chunkResults.length === 1) return chunkResults[0];

    try {
      return await this.mergeChunkResults(
        chunkResults,
        rules,
        {
          maxTextBytesPerChunk: options.maxTextBytesPerChunk,
          maxItemsPerChunk: options.maxItemsPerChunk,
          signal: options.signal,
          requestTimeoutMs: options.requestTimeoutMs,
          onDiagnostic: options.onDiagnostic,
        },
      );
    } catch (error) {
      await this.reportDiagnostic(options, {
        event: "merge_failed",
        chunkCount: chunks.length,
        model: this.models.summarizer.model,
        errorMessage: sanitizeErrorForOps(error),
      });
      throw error;
    }
  }

  private async processChunkWithDiagnostics(
    items: NormalizedItem[],
    rules: SummaryRuleset,
    options: ResolvedSummarizeOptions,
    state: VisionRunState,
    context: ChunkExecutionContext,
  ): Promise<SummaryPoint[]> {
    try {
      return await this.processChunk(items, rules, options, state, context);
    } catch (error) {
      await this.reportDiagnostic(options, {
        event: "chunk_failed",
        chunkIndex: context.chunkIndex,
        chunkCount: context.chunkCount,
        model: this.models.summarizer.model,
        errorMessage: sanitizeErrorForOps(error),
      });
      throw error;
    }
  }

  private async processChunk(
    items: NormalizedItem[],
    rules: SummaryRuleset,
    options: ResolvedSummarizeOptions,
    state: VisionRunState,
    context: ChunkExecutionContext,
  ): Promise<SummaryPoint[]> {
    const content = await this.buildContentParts(
      items,
      rules,
      options.maxTextBytesPerChunk,
      options.maxImageBytes,
      options.summaryMode,
    );
    if (content.imageEntries.length === 0) {
      return await this.summarizeTextParts(
        content.textParts,
        content.indexedItems,
        rules,
        options,
      );
    }

    const affectedIndexes = [
      ...new Set(content.imageEntries.map((entry) => entry.index)),
    ];
    if (!rules.includeMedia || !state.available) {
      return await this.summarizeUnavailableImages(
        content,
        affectedIndexes,
        rules,
        options,
      );
    }

    if (this.models.sameModel) {
      try {
        const raw = await this.summarizerClient.complete(
          rules.systemPrompt,
          content.multimodalParts,
          options,
        );
        return this.parsePoints(raw, content.indexedItems);
      } catch (error) {
        if (
          !(error instanceof ModelApiError) ||
          ![400, 415, 422].includes(error.status)
        ) {
          throw error;
        }
        await this.markVisionUnavailable(state, error, options, context);
        return await this.summarizeUnavailableImages(
          content,
          affectedIndexes,
          rules,
          options,
        );
      }
    }

    let describedTextParts: TextPart[];
    try {
      const visionRaw = await this.visionClient.complete(
        buildVisionAnalysisPrompt().systemPrompt,
        content.visionParts,
        options,
      );
      const descriptions = this.parseVisionDescriptions(
        visionRaw,
        affectedIndexes,
      );
      describedTextParts = this.addVisionDescriptions(
        content.textParts,
        content.itemIndexByTextPart,
        affectedIndexes,
        descriptions,
      );
    } catch (error) {
      if (
        options.signal?.aborted ||
        (error instanceof DOMException && error.name === "AbortError")
      ) {
        throw error;
      }
      await this.markVisionUnavailable(state, error, options, context);
      return await this.summarizeUnavailableImages(
        content,
        affectedIndexes,
        rules,
        options,
      );
    }
    return await this.summarizeTextParts(
      describedTextParts,
      content.indexedItems,
      rules,
      options,
    );
  }

  private async summarizeUnavailableImages(
    content: IndexedChunkContent,
    affectedIndexes: number[],
    rules: SummaryRuleset,
    options: SummarizerRequestOptions,
  ): Promise<SummaryPoint[]> {
    const unavailableTextParts = content.textParts.map((part, partIndex) => {
      const index = content.itemIndexByTextPart[partIndex];
      if (index === undefined || !affectedIndexes.includes(index)) return part;
      return {
        type: "text" as const,
        text: `${part.text}\n[IMAGE_ANALYSIS_UNAVAILABLE]`,
      };
    });
    return await this.summarizeTextParts(
      unavailableTextParts,
      content.indexedItems,
      rules,
      options,
    );
  }

  private async summarizeTextParts(
    textParts: TextPart[],
    indexedItems: NormalizedItem[],
    rules: SummaryRuleset,
    options: SummarizerRequestOptions,
  ): Promise<SummaryPoint[]> {
    const content = textParts.map((part) => part.text).join("\n\n");
    const raw = await this.summarizerClient.complete(
      rules.systemPrompt,
      content,
      options,
    );
    return this.parsePoints(raw, indexedItems);
  }

  private addVisionDescriptions(
    textParts: TextPart[],
    itemIndexByTextPart: Array<number | undefined>,
    affectedIndexes: number[],
    descriptions: Map<number, string>,
  ): TextPart[] {
    return textParts.map((part, partIndex) => {
      const index = itemIndexByTextPart[partIndex];
      if (index === undefined || !affectedIndexes.includes(index)) return part;
      return {
        type: "text" as const,
        text: `${part.text}\n[IMAGE_ANALYSIS]\n${
          descriptions.get(index)
        }\n[/IMAGE_ANALYSIS]`,
      };
    });
  }

  private async markVisionUnavailable(
    state: VisionRunState,
    error: unknown,
    options: SummarizerRequestOptions,
    context: ChunkExecutionContext,
  ): Promise<void> {
    if (!state.available) return;
    state.available = false;
    const errorMessage = sanitizeErrorForOps(error);
    console.warn(
      `[summarization] vision analysis unavailable at chunk ${context.chunkIndex}/${context.chunkCount}; continuing with text-only fallback:`,
      errorMessage,
    );
    await this.reportDiagnostic(options, {
      event: "vision_unavailable",
      chunkIndex: context.chunkIndex,
      chunkCount: context.chunkCount,
      model: this.models.vision.model,
      errorMessage,
    });
  }

  private async reportDiagnostic(
    options: SummarizerRequestOptions,
    diagnostic: SummarizationDiagnostic,
  ): Promise<void> {
    try {
      await options.onDiagnostic?.(diagnostic);
    } catch (error) {
      console.warn(
        "[summarization] diagnostic reporter failed:",
        sanitizeErrorForOps(error),
      );
    }
  }

  private async mergeChunkResults(
    chunkResults: SummaryPoint[][],
    rules: SummaryRuleset,
    options: SummarizerRequestOptions & {
      maxTextBytesPerChunk: number;
      maxItemsPerChunk: number;
    },
  ): Promise<SummaryPoint[]> {
    let mergeItems = this.createMergeItems(chunkResults);
    let mergeLevel = 0;

    while (mergeItems.length > 0) {
      const mergeBatches = this.partitionMergeItems(
        mergeItems,
        options.maxItemsPerChunk,
        options.maxTextBytesPerChunk,
      );
      if (mergeBatches.length === 1) {
        return await this.summarizeMergeBatch(
          mergeBatches[0],
          rules,
          options,
        );
      }

      const collapsedItems: NormalizedItem[] = [];
      for (let batchIndex = 0; batchIndex < mergeBatches.length; batchIndex++) {
        const points = await this.summarizeMergeBatch(
          mergeBatches[batchIndex],
          rules,
          options,
        );
        if (points.length === 0) {
          throw new Error("Non-final merge batch returned no summary points");
        }
        collapsedItems.push(
          this.collapseMergePoints(points, mergeLevel, batchIndex),
        );
      }
      mergeItems = collapsedItems;
      mergeLevel++;
    }

    return [];
  }

  private createMergeItems(chunkResults: SummaryPoint[][]): NormalizedItem[] {
    const mergeItems: NormalizedItem[] = [];
    for (let chunkIndex = 0; chunkIndex < chunkResults.length; chunkIndex++) {
      for (
        let pointIndex = 0;
        pointIndex < chunkResults[chunkIndex].length;
        pointIndex++
      ) {
        const point = chunkResults[chunkIndex][pointIndex];
        mergeItems.push({
          connectorId: ConnectorId.Telegram,
          feedExternalId: point.channel ?? `merge-chunk-${chunkIndex}`,
          externalId: `merge-${chunkIndex}-${pointIndex}`,
          date: point.date ? new Date(point.date).getTime() : Date.now(),
          title: null,
          text: point.text,
          author: null,
          url: point.sourceUrl,
        });
      }
    }
    return mergeItems;
  }

  private partitionMergeItems(
    mergeItems: NormalizedItem[],
    maxItemsPerChunk: number,
    maxTextBytesPerChunk: number,
  ): MergeBatch[] {
    const mergeFanIn = Math.max(2, maxItemsPerChunk);
    const minimumPairContent = this.serializeMergeItems([
      { ...mergeItems[0], text: "" },
      { ...mergeItems[Math.min(1, mergeItems.length - 1)], text: "" },
    ]);
    if (
      mergeItems.length > 1 &&
      new TextEncoder().encode(minimumPairContent).byteLength >
        maxTextBytesPerChunk
    ) {
      throw new Error(
        `Merge maxTextBytesPerChunk ${maxTextBytesPerChunk} cannot encode two framed items`,
      );
    }

    const batches: MergeBatch[] = [];
    for (let offset = 0; offset < mergeItems.length;) {
      const remaining = mergeItems.length - offset;
      let itemCount = Math.min(mergeFanIn, remaining);
      while (
        itemCount > 2 &&
        new TextEncoder().encode(
            this.serializeMergeItems(
              mergeItems.slice(offset, offset + itemCount).map((item) => ({
                ...item,
                text: "",
              })),
            ),
          ).byteLength > maxTextBytesPerChunk
      ) {
        itemCount--;
      }
      batches.push(
        this.buildMergeBatch(
          mergeItems.slice(offset, offset + itemCount),
          maxTextBytesPerChunk,
        ),
      );
      offset += itemCount;
    }
    return batches;
  }

  private buildMergeBatch(
    items: NormalizedItem[],
    maxTextBytesPerChunk: number,
  ): MergeBatch {
    const emptyContent = this.serializeMergeItems(
      items.map((item) => ({ ...item, text: "" })),
    );
    const encoder = new TextEncoder();
    let textBytesRemaining = maxTextBytesPerChunk -
      encoder.encode(emptyContent).byteLength;
    if (textBytesRemaining < 0) {
      throw new Error(
        `Merge maxTextBytesPerChunk ${maxTextBytesPerChunk} cannot encode framed items`,
      );
    }
    const boundedItems = items.map((item, index) => {
      const itemBudget = Math.floor(
        textBytesRemaining / (items.length - index),
      );
      const text = truncateUtf8AtScalarBoundary(item.text, itemBudget);
      textBytesRemaining -= encoder.encode(text).byteLength;
      return { ...item, text };
    });
    return {
      items: boundedItems,
      userContent: this.serializeMergeItems(boundedItems),
    };
  }

  private serializeMergeItems(items: NormalizedItem[]): string {
    return items.map((item, index) => `[${index}]\n${item.text}`).join("\n\n");
  }

  private collapseMergePoints(
    points: SummaryPoint[],
    mergeLevel: number,
    batchIndex: number,
  ): NormalizedItem {
    const provenancePoint = points.find((point) =>
      point.channel || point.date || point.sourceUrl
    ) ?? points[0];
    return {
      connectorId: ConnectorId.Telegram,
      feedExternalId: provenancePoint.channel ??
        `merge-level-${mergeLevel}`,
      externalId: `merge-level-${mergeLevel}-batch-${batchIndex}`,
      date: provenancePoint.date
        ? new Date(provenancePoint.date).getTime()
        : Date.now(),
      title: null,
      text: points.map((point) => point.text).join("\n"),
      author: null,
      url: provenancePoint.sourceUrl ?? null,
    };
  }

  private async summarizeMergeBatch(
    mergeBatch: MergeBatch,
    rules: SummaryRuleset,
    options: SummarizerRequestOptions & {
      maxTextBytesPerChunk: number;
    },
  ): Promise<SummaryPoint[]> {
    const mergeTextParts: TextPart[] = [{
      type: "text",
      text: mergeBatch.userContent,
    }];
    return await this.summarizeTextParts(
      mergeTextParts,
      mergeBatch.items,
      rules,
      options,
    );
  }

  private async buildContentParts(
    items: NormalizedItem[],
    rules: SummaryRuleset,
    maxTextBytesPerChunk: number,
    maxImageBytes: number,
    summaryMode: "aggregate" | "article",
  ): Promise<IndexedChunkContent> {
    const showAuthors = rules.showAuthors ?? false;
    const includeMedia = rules.includeMedia ?? true;
    const textParts: TextPart[] = [];
    const itemIndexByTextPart: Array<number | undefined> = [];
    const multimodalParts: ContentPart[] = [];
    const visionParts: ContentPart[] = [];
    const indexedItems: NormalizedItem[] = [];
    const imageEntries: ImageEntry[] = [];

    for (const item of items) {
      const hasPhoto = item.media?.type === "photo" ||
        item.media?.type === "album";
      if (!item.text.trim() && !hasPhoto) continue;
      if (summaryMode === "aggregate" && isEmojiOnly(item.text) && !hasPhoto) {
        continue;
      }

      const index = indexedItems.length;
      indexedItems.push(item);
      const itemText =
        summaryMode === "aggregate" && item.text.length > maxTextBytesPerChunk
          ? item.text.slice(0, maxTextBytesPerChunk)
          : item.text;
      const headerParts = [
        showAuthors ? `[${index}] ${item.author ?? "Unknown"}` : `[${index}]`,
      ];
      if (rules.showTitle && item.title?.trim()) {
        headerParts.push(`Title: ${item.title.trim()}`);
      }
      const textPart = {
        type: "text" as const,
        text: `${headerParts.join("\n")}\n${itemText}`,
      };
      textParts.push(textPart);
      itemIndexByTextPart.push(index);
      multimodalParts.push(textPart);

      if (!includeMedia) continue;
      const localPaths = item.media?.type === "photo"
        ? [item.media.localPath]
        : item.media?.type === "album"
        ? item.media.localPaths
        : [];
      let imageNumber = 0;
      const itemVisionParts: ContentPart[] = [];
      for (const localPath of localPaths) {
        imageNumber++;
        const imagePart = await this.loadImagePart(localPath, maxImageBytes);
        if (!imagePart) {
          const omittedPart = {
            type: "text" as const,
            text: "[IMAGE_OMITTED]",
          };
          textParts.push(omittedPart);
          itemIndexByTextPart.push(undefined);
          multimodalParts.push(omittedPart);
          continue;
        }
        const imageLabel = {
          type: "text" as const,
          text: `Item [${index}], Image ${imageNumber}`,
        };
        multimodalParts.push(imagePart);
        itemVisionParts.push(imageLabel, imagePart);
        imageEntries.push({ index, imageNumber, part: imagePart });
      }
      if (itemVisionParts.length > 0) {
        visionParts.push(textPart, ...itemVisionParts);
      }
    }

    return {
      textParts,
      itemIndexByTextPart,
      multimodalParts,
      visionParts,
      indexedItems,
      imageEntries,
    };
  }

  private async loadImagePart(
    localPath: string,
    maxImageBytes: number,
  ): Promise<ImagePart | null> {
    try {
      if (maxImageBytes > 0) {
        const fileStat = await stat(localPath);
        if (fileStat.size > maxImageBytes) return null;
      }
      const bytes = await readFile(localPath);
      if (maxImageBytes > 0 && bytes.length > maxImageBytes) return null;
      const b64 = encodeBytesAsBase64(bytes);
      const extension = localPath.toLowerCase().split(".").pop();
      const mimeType = extension === "png"
        ? "image/png"
        : extension === "webp"
        ? "image/webp"
        : extension === "gif"
        ? "image/gif"
        : extension === "avif"
        ? "image/avif"
        : "image/jpeg";
      return {
        type: "image_url",
        image_url: { url: `data:${mimeType};base64,${b64}` },
      };
    } catch {
      return null;
    }
  }

  private cleanJsonResponse(raw: string): string {
    let cleaned = raw.replace(/<think>[\s\S]*?<\/think>/gi, "").trim();
    const fenceMatch = cleaned.match(/```(?:json)?\s*([\s\S]*?)```/);
    if (fenceMatch) cleaned = fenceMatch[1].trim();
    if (!cleaned) throw new Error("Summarizer returned empty response");
    try {
      return jsonrepair(cleaned);
    } catch {
      throw new Error("Summarizer returned invalid JSON");
    }
  }

  private parsePoints(
    raw: string,
    indexedItems: NormalizedItem[],
  ): SummaryPoint[] {
    let parsed: Array<{ t: string; i?: number | string }>;
    const cleaned = this.cleanJsonResponse(raw);
    try {
      parsed = JSON.parse(cleaned) as Array<{ t: string; i?: number | string }>;
    } catch {
      throw new Error("Summarizer returned unparseable JSON after repair");
    }
    if (!Array.isArray(parsed)) {
      throw new Error("Summarizer returned non-array JSON");
    }
    for (let index = 0; index < parsed.length; index++) {
      const element = parsed[index];
      if (typeof element !== "object" || element === null) {
        throw new Error(`Summarizer returned non-object at index ${index}`);
      }
      if (typeof element.t !== "string") {
        throw new Error(
          `Summarizer returned element without string "t" at index ${index}`,
        );
      }
    }
    return parsed.map((point) => {
      const index = typeof point.i === "number"
        ? point.i
        : typeof point.i === "string"
        ? Number(point.i)
        : NaN;
      const item = Number.isFinite(index) && index >= 0
        ? indexedItems[index]
        : undefined;
      return {
        text: point.t,
        sourceUrl: item?.url ?? null,
        ...(item && {
          channel: item.feedExternalId,
          date: new Date(item.date).toLocaleString("en-GB", {
            day: "numeric",
            month: "short",
            year: "numeric",
            hour: "2-digit",
            minute: "2-digit",
            hour12: false,
          }),
        }),
      };
    });
  }

  private parseVisionDescriptions(
    raw: string,
    expectedIndexes: number[],
  ): Map<number, string> {
    const cleaned = this.cleanJsonResponse(raw);
    let parsed: unknown;
    try {
      parsed = JSON.parse(cleaned);
    } catch {
      throw new Error("vision response validation failed: unparseable JSON");
    }
    if (!Array.isArray(parsed)) {
      throw new Error("vision response validation failed: expected array");
    }
    const expected = new Set(expectedIndexes);
    const descriptionsByIndex = new Map<number, string[]>();
    for (const element of parsed) {
      if (typeof element !== "object" || element === null) {
        throw new Error(
          `vision response validation failed: invalid entry count=${parsed.length}`,
        );
      }
      const keys = Object.keys(element);
      if (
        keys.length !== 2 || !keys.includes("i") ||
        !keys.includes("description")
      ) {
        throw new Error(
          `vision response validation failed: unexpected fields count=${parsed.length}`,
        );
      }
      const entry = element as { i: unknown; description: unknown };
      if (
        typeof entry.i !== "number" || !Number.isInteger(entry.i) ||
        !expected.has(entry.i)
      ) {
        throw new Error(
          `vision response validation failed: invalid index count=${parsed.length}`,
        );
      }
      if (
        typeof entry.description !== "string" || entry.description.trim() === ""
      ) {
        throw new Error(
          `vision response validation failed: blank description index=${entry.i}`,
        );
      }
      const description = entry.description.trim();
      const descriptions = descriptionsByIndex.get(entry.i);
      if (descriptions === undefined) {
        descriptionsByIndex.set(entry.i, [description]);
      } else if (!descriptions.includes(description)) {
        descriptions.push(description);
      }
    }
    if (descriptionsByIndex.size !== expected.size) {
      throw new Error(
        `vision response validation failed: expected=${expected.size} received=${descriptionsByIndex.size}`,
      );
    }
    return new Map(
      [...descriptionsByIndex].map(([index, descriptions]) => [
        index,
        descriptions.join("\n"),
      ]),
    );
  }
}
