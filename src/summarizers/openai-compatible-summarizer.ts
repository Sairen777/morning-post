import { jsonrepair } from "jsonrepair";
import type { NormalizedItem } from "../connectors/connector.types.ts";
import { ConnectorId } from "../constants.ts";
import type {
  ContentPart,
  ImagePart,
  SummarizerService,
  SummarizeOptions,
  SummaryPoint,
  SummaryRuleset,
  TextPart,
} from "./summarizer.types.ts";
import { isEmojiOnly } from "../utils/text.ts";

const DEFAULTS = Deno.env.get("LOCAL_API") === "true"
  ? {
    model: "gemma-4-e4b-uncensored-hauhaucs-aggressive",
    // LM Studio
    baseUrl: "http://localhost:1234/v1",
    apiKey: undefined as string | undefined,
  }
  : {
    model: "gemini-2.5-flash-lite",
    baseUrl: "https://generativelanguage.googleapis.com/v1beta/openai",
    apiKey: Deno.env.get("GEMINI_API_KEY"),
  };

/**
 * Default config-resolved values for summarization limits.
 * These mirror the defaults in src/config.ts.
 */
const DEFAULT_MAX_TEXT_BYTES_PER_CHUNK = 120_000;
const DEFAULT_MAX_ITEMS_PER_CHUNK = 50;
const DEFAULT_MAX_IMAGE_BYTES = 1_000_000;

export function resolveOpenAICompatibleSummarizerModel(model?: string | null): string {
  return model ?? Deno.env.get("SUMMARIZER_MODEL") ?? DEFAULTS.model;
}

export function resolveAllowRemoteSummarization(): boolean {
  const val = Deno.env.get("ALLOW_REMOTE_SUMMARIZATION");
  if (val === undefined) return false;
  return val === "true" || val === "1";
}

function isLoopbackUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    return parsed.hostname === "localhost" ||
      parsed.hostname === "127.0.0.1" ||
      parsed.hostname === "::1";
  } catch {
    return false;
  }
}

function delay(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) {
    return Promise.reject(new DOMException("Aborted", "AbortError"));
  }
  return new Promise<void>((resolve, reject) => {
    const timer = setTimeout(resolve, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(new DOMException("Aborted", "AbortError"));
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

/**
 * Partition items into chunks respecting maxItemsPerChunk and maxTextBytesPerChunk.
 * Items whose text alone exceeds the text budget are truncated at the budget
 * (their index is preserved); they start a new chunk as a single-item chunk.
 */
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

    // Start a new chunk if the current one is full — but never start empty
    if (current.length > 0 && (current.length >= maxItems || currentBytes + effectiveLen > maxTextBytes)) {
      chunks.push(current);
      current = [];
      currentBytes = 0;
    }

    current.push(item);
    currentBytes += effectiveLen;
  }

  if (current.length > 0) {
    chunks.push(current);
  }

  return chunks;
}

export class OpenAICompatibleSummarizerService implements SummarizerService {
  constructor(
    private model: string = resolveOpenAICompatibleSummarizerModel(),
    private baseUrl: string = Deno.env.get("SUMMARIZER_BASE_URL") ??
      DEFAULTS.baseUrl,
    private apiKey: string | undefined = DEFAULTS.apiKey,
    private retryBaseDelayMs: number = 1000,
    private maxTextBytesPerChunk: number = DEFAULT_MAX_TEXT_BYTES_PER_CHUNK,
    private maxItemsPerChunk: number = DEFAULT_MAX_ITEMS_PER_CHUNK,
    private maxImageBytes: number = DEFAULT_MAX_IMAGE_BYTES,
    private allowRemoteSummarization: boolean = resolveAllowRemoteSummarization(),
  ) {}

  public async summarize(
    items: NormalizedItem[],
    rules: SummaryRuleset,
    options: SummarizeOptions = {},
  ): Promise<SummaryPoint[]> {
    const maxTextBytesPerChunk = options.maxTextBytesPerChunk ?? this.maxTextBytesPerChunk;
    const maxItemsPerChunk = options.maxItemsPerChunk ?? this.maxItemsPerChunk;
    const maxImageBytes = options.maxImageBytes ?? this.maxImageBytes;
    const signal = options.signal;
    const allowRemote = options.allowRemoteSummarization ?? this.allowRemoteSummarization;

    // Remote URL validation: only loopback is allowed without explicit opt-in.
    if (!isLoopbackUrl(this.baseUrl) && !allowRemote) {
      throw new Error(
        `Remote summarizer base URL "${this.baseUrl}" requires ALLOW_REMOTE_SUMMARIZATION=true`,
      );
    }

    return this.summarizeInternal(items, rules, {
      ...options,
      maxTextBytesPerChunk,
      maxItemsPerChunk,
      maxImageBytes,
      signal,
    });
  }

  /**
   * Internal summarization that skips remote-URL validation (used by merge).
   */
  private async summarizeInternal(
    items: NormalizedItem[],
    rules: SummaryRuleset,
    options: Required<Pick<SummarizeOptions, "maxTextBytesPerChunk" | "maxItemsPerChunk" | "maxImageBytes">> &
      Pick<SummarizeOptions, "model" | "signal">,
  ): Promise<SummaryPoint[]> {
    const maxTextBytes = options.maxTextBytesPerChunk;
    const maxItems = options.maxItemsPerChunk;
    const maxImageBytes = options.maxImageBytes;
    const signal = options.signal;

    // Filter emoji-only / empty-text items (same logic as buildContentParts filtering)
    const filtered = items.filter((item) => {
      const hasPhoto = item.media?.type === "photo" || item.media?.type === "album";
      if (!item.text.trim() && !hasPhoto) return false;
      if (isEmojiOnly(item.text) && !hasPhoto) return false;
      return true;
    });

    if (filtered.length === 0) {
      return [];
    }

    // Partition into chunks
    const chunks = partitionItems(filtered, maxItems, maxTextBytes);

    // Process each chunk sequentially
    const chunkResults: SummaryPoint[][] = [];
    for (const chunk of chunks) {
      const result = await this.processChunk(chunk, rules, {
        maxTextBytesPerChunk: maxTextBytes,
        maxImageBytes,
        model: options.model,
        signal,
      });
      chunkResults.push(result);
    }

    if (chunkResults.length === 1) {
      return chunkResults[0];
    }

    // Merge multiple chunk results
    return this.mergeChunkResults(chunkResults, rules, {
      maxTextBytesPerChunk: maxTextBytes,
      maxItemsPerChunk: maxItems,
      maxImageBytes: 0,
      model: options.model,
      signal,
    });
  }

  /**
   * Build content parts and make one API call for a single chunk.
   */
  private async processChunk(
    items: NormalizedItem[],
    rules: SummaryRuleset,
    options: {
      maxTextBytesPerChunk: number;
      maxImageBytes: number;
      model?: string;
      signal?: AbortSignal;
    },
  ): Promise<SummaryPoint[]> {
    const { parts, indexedItems } = await this.buildContentParts(
      items,
      rules,
      options.maxTextBytesPerChunk,
      options.maxImageBytes,
    );

    return this.callApiWithRetry(parts, indexedItems, rules, options.model, options.signal);
  }

  /**
   * Make the API call with retry logic, signal support, and Retry-After parsing.
   */
  private async callApiWithRetry(
    parts: ContentPart[] | string,
    indexedItems: NormalizedItem[],
    rules: SummaryRuleset,
    model?: string,
    signal?: AbortSignal,
  ): Promise<SummaryPoint[]> {
    const body = JSON.stringify({
      model: model ?? this.model,
      stream: false,
      messages: [
        { role: "system", content: rules.systemPrompt },
        { role: "user", content: parts },
      ],
    });

    const maxRetries = 3;
    let lastError: Error | null = null;

    for (let attempt = 0; attempt < maxRetries; attempt++) {
      if (signal?.aborted) {
        throw new DOMException("Aborted", "AbortError");
      }

      const response = await fetch(`${this.baseUrl}/chat/completions`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(this.apiKey && { Authorization: `Bearer ${this.apiKey}` }),
        },
        body,
        signal,
      });

      if (response.ok) {
        const data = await response.json();
        const raw = data.choices[0].message.content as string;
        return this.parsePoints(raw, indexedItems);
      }

      let bodyText = "";
      try {
        bodyText = await response.text();
      } catch {
        // ignore
      }

      const retryable = response.status === 429 || response.status === 503;
      lastError = new Error(
        `Summarizer API ${response.status} — ${bodyText.slice(0, 300)}`,
      );

      if (retryable && attempt < maxRetries - 1) {
        // Parse optional Retry-After header, bounded by same overall backoff cap
        let retryAfterMs = Math.pow(2, attempt) * this.retryBaseDelayMs;
        const retryAfterHeader = response.headers.get("Retry-After");
        if (retryAfterHeader) {
          const parsed = parseInt(retryAfterHeader, 10);
          if (!isNaN(parsed) && parsed > 0) {
            retryAfterMs = Math.min(parsed * 1000, 30_000); // clamp to 30s
          }
        }

        await delay(retryAfterMs, signal);
        continue;
      }

      throw lastError;
    }

    throw lastError ?? new Error("Summarizer API: unexpected retry exhaustion");
  }

  /**
   * Merge multiple chunk results into a single SummaryPoint[].
   * Creates synthetic NormalizedItems from the chunk summaries, then
   * summarizes them (no images). If the merge input exceeds chunk budgets,
   * it is further partitioned and merged sequentially.
   */
  private async mergeChunkResults(
    chunkResults: SummaryPoint[][],
    rules: SummaryRuleset,
    options: {
      maxTextBytesPerChunk: number;
      maxItemsPerChunk: number;
      maxImageBytes: number;
      model?: string;
      signal?: AbortSignal;
    },
  ): Promise<SummaryPoint[]> {
    // Build synthetic items from chunk results
    const mergeItems: NormalizedItem[] = [];
    for (let chunkIdx = 0; chunkIdx < chunkResults.length; chunkIdx++) {
      for (let pointIdx = 0; pointIdx < chunkResults[chunkIdx].length; pointIdx++) {
        const point = chunkResults[chunkIdx][pointIdx];
        mergeItems.push({
          connectorId: ConnectorId.Telegram,
          feedExternalId: point.channel ?? `merge-chunk-${chunkIdx}`,
          externalId: `merge-${chunkIdx}-${pointIdx}`,
          date: point.date ? new Date(point.date).getTime() : Date.now(),
          title: null,
          text: point.text,
          author: null,
          url: point.sourceUrl,
        });
      }
    }

    // No images in merge
    const mergeRules: SummaryRuleset = {
      ...rules,
      includeMedia: false,
    };

    // Recurse through summarization (skips remote URL check since we call the internal method)
    return this.summarizeInternal(mergeItems, mergeRules, options);
  }

  private async buildContentParts(
    items: NormalizedItem[],
    rules: SummaryRuleset,
    maxTextBytesPerChunk: number,
    maxImageBytes: number,
  ): Promise<{
    parts: ContentPart[] | string;
    indexedItems: NormalizedItem[];
  }> {
    const showAuthors = rules.showAuthors ?? false;
    const includeMedia = rules.includeMedia ?? true;
    const parts: ContentPart[] = [];
    const indexedItems: NormalizedItem[] = [];

    for (const item of items) {
      const hasPhoto = item.media?.type === "photo" ||
        item.media?.type === "album";
      if (!item.text.trim() && !hasPhoto) continue;
      if (isEmojiOnly(item.text) && !hasPhoto) continue;

      const i = indexedItems.length;
      indexedItems.push(item);

      // Truncate oversize item text to the per-item cap
      const itemText = item.text.length > maxTextBytesPerChunk
        ? item.text.slice(0, maxTextBytesPerChunk)
        : item.text;

      const header = showAuthors
        ? `[${i}] ${item.author ?? "Unknown"}`
        : `[${i}]`;
      parts.push({ type: "text", text: `${header}\n${itemText}` });

      if (includeMedia) {
        if (item.media?.type === "photo") {
          const omitted = await this.maybeAppendImage(item.media.localPath, maxImageBytes, parts);
          if (omitted) {
            parts.push({ type: "text", text: `[IMAGE_OMITTED]` });
          }
        } else if (item.media?.type === "album") {
          for (const localPath of item.media.localPaths) {
            const omitted = await this.maybeAppendImage(localPath, maxImageBytes, parts);
            if (omitted) {
              parts.push({ type: "text", text: `[IMAGE_OMITTED]` });
            }
          }
        }
      }
    }

    // No images? collapse to a plain string to avoid the {"type":"text","text":...}
    // wrapper overhead on every message.
    const hasAnyImage = parts.some((p) => p.type === "image_url");
    if (!hasAnyImage) {
      const text = parts.map((p) => (p as TextPart).text).join("\n\n");
      return { parts: text, indexedItems };
    }

    return { parts, indexedItems };
  }

  /**
   * Check image file size against maxImageBytes and either append the image
   * part or skip. Returns true if the image was skipped (omitted).
   */
  private async maybeAppendImage(
    localPath: string,
    maxImageBytes: number,
    parts: ContentPart[],
  ): Promise<boolean> {
    if (maxImageBytes > 0) {
      try {
        const stat = await Deno.stat(localPath);
        if (stat.size > maxImageBytes) {
          return true; // caller inserts [IMAGE_OMITTED]
        }
      } catch {
        return true; // can't stat, omit
      }
    }
    parts.push(await this.imagePartFromPath(localPath));
    return false;
  }

  private parsePoints(
    raw: string,
    indexedItems: NormalizedItem[],
  ): SummaryPoint[] {
    // Strip <think>...</think> reasoning tokens (Qwen3, DeepSeek-R1, etc.)
    let cleaned = raw.replace(/<think>[\s\S]*?<\/think>/gi, "").trim();

    // Strip markdown code fences (```json / ```) that some models wrap output in.
    // jsonrepair handles inner JSON quirks but fences confuse it.
    const fenceMatch = cleaned.match(/```(?:json)?\s*([\s\S]*?)```/);
    if (fenceMatch) {
      cleaned = fenceMatch[1].trim();
    }

    if (!cleaned) {
      throw new Error(
        `Summarizer returned empty response. Raw: ${raw.slice(0, 200)}`,
      );
    }

    let json: string;
    try {
      json = jsonrepair(cleaned);
    } catch {
      throw new Error(
        `jsonrepair failed on summarizer output: ${cleaned.slice(0, 200)}`,
      );
    }

    let parsed: Array<{ t: string; i?: number }>;
    try {
      parsed = JSON.parse(json) as Array<{ t: string; i?: number }>;
    } catch {
      throw new Error(
        `Summarizer returned unparseable JSON after repair. Cleaned: ${cleaned.slice(0, 200)}`,
      );
    }

    if (!Array.isArray(parsed)) {
      throw new Error(
        `Summarizer returned non-array: ${JSON.stringify(parsed).slice(0, 200)}`,
      );
    }

    for (let idx = 0; idx < parsed.length; idx++) {
      const el = parsed[idx];
      if (typeof el !== "object" || el === null) {
        throw new Error(
          `Summarizer returned non-object at index ${idx}: ${JSON.stringify(el)}`,
        );
      }
      if (typeof el.t !== "string") {
        throw new Error(
          `Summarizer returned element without string "t" at index ${idx}: ${JSON.stringify(el).slice(0, 100)}`,
        );
      }
    }

    return parsed.map((p) => {
      const idx = typeof p.i === "number" ? p.i : typeof p.i === "string" ? Number(p.i) : NaN;
      const item = Number.isFinite(idx) && idx >= 0 ? indexedItems[idx] : undefined;
      return {
        text: p.t,
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

  private async imagePartFromPath(localPath: string): Promise<ImagePart> {
    const bytes = await Deno.readFile(localPath);
    const b64 = btoa(String.fromCharCode(...bytes));
    return {
      type: "image_url",
      image_url: { url: `data:image/jpeg;base64,${b64}` },
    };
  }
}
