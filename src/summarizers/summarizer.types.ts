import type { ModelAttemptTelemetryCallback } from "./openai-compatible-client.ts";

import type { NormalizedItem } from "../connectors/connector.types.ts";

export interface SummaryRuleset {
  systemPrompt: string;
  showAuthors?: boolean;
  includeMedia?: boolean;
  showTitle?: boolean;
}

// Note: sourceUrl refers to the primary/first post when a bullet covers multiple posts.
export interface SummaryPoint {
  text: string;
  sourceUrl: string | null;
  channel?: string;
  date?: string;
}

export interface AggregateSummaryContent {
  kind: "aggregate";
  points: SummaryPoint[];
}

export interface ArticleSummary {
  sourceExternalId: string;
  title: string;
  sourceUrl: string | null;
  publishedAt: number;
  contentAccess: "full" | "preview" | "paid";
  points: SummaryPoint[];
}

export interface ArticleSummaryContent {
  kind: "articles";
  articles: ArticleSummary[];
}

export type SummaryContent = AggregateSummaryContent | ArticleSummaryContent;

export interface SummarizationDiagnostic {
  event: "vision_unavailable" | "chunk_failed" | "merge_failed";
  chunkIndex?: number;
  chunkCount: number;
  model: string;
  errorMessage: string;
}

export interface SummarizeOptions {
  /** AbortSignal for cancellation through retries, backoff, and merge */
  signal?: AbortSignal;
  /** Timeout for each model request; renewed for every chunk, fallback, and merge */
  requestTimeoutMs?: number;
  /** Receives content-safe telemetry once for each model HTTP attempt */
  onAttempt?: ModelAttemptTelemetryCallback;
  /** Receives redacted operational events without item or prompt content */
  onDiagnostic?: (
    diagnostic: SummarizationDiagnostic,
  ) => Promise<void> | void;
  /** Max text bytes per chunk; default resolved from config (120_000) */
  maxTextBytesPerChunk?: number;
  /** Max items per chunk; default resolved from config (50) */
  maxItemsPerChunk?: number;
  /** Max bytes for a single image payload; larger images are omitted with [IMAGE_OMITTED] */
  maxImageBytes?: number;
  /** Internal per-request output ceiling; runtime configuration may impose a tighter limit */
  maxOutputTokens?: number;
  /** Article mode requires one item and keeps chunk results article-local */
  summaryMode?: "aggregate" | "article";
}

export interface BatchSummaryInput {
  storyId: string;
  items: NormalizedItem[];
}

export function serializeBatchSummaryInput(
  stories: BatchSummaryInput[],
  showTitle: boolean,
): string {
  return JSON.stringify(stories.map((story) => ({
    story_id: story.storyId,
    sources: story.items.map((item, index) => ({
      i: index,
      title: showTitle ? item.title : null,
      text: item.text,
    })),
  })));
}

export interface BatchSummaryResult {
  storyId: string;
  points?: SummaryPoint[];
  error?: Error;
}

export interface SummarizerService {
  summarize(
    items: NormalizedItem[],
    rules: SummaryRuleset,
    options?: SummarizeOptions,
  ): Promise<SummaryPoint[]>;
  summarizeBatch?(
    stories: BatchSummaryInput[],
    rules: SummaryRuleset,
    options?: SummarizeOptions,
  ): Promise<BatchSummaryResult[]>;
}

export type TextPart = { type: "text"; text: string };

export type ImagePart = { type: "image_url"; image_url: { url: string } };

export type ContentPart = TextPart | ImagePart;
