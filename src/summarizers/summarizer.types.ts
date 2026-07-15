import type { NormalizedItem } from "../connectors/connector.types.ts";

export interface SummaryRuleset {
  systemPrompt: string;
  showAuthors?: boolean;
  includeMedia?: boolean;
}

// Note: sourceUrl refers to the primary/first post when a bullet covers multiple posts.
export interface SummaryPoint {
  text: string;
  sourceUrl: string | null;
  channel?: string;
  date?: string;
}

export interface SummarizeOptions {
  /** AbortSignal for cancellation through retries, backoff, and merge */
  signal?: AbortSignal;
  /** Max text bytes per chunk; default resolved from config (120_000) */
  maxTextBytesPerChunk?: number;
  /** Max items per chunk; default resolved from config (50) */
  maxItemsPerChunk?: number;
  /** Max bytes for a single image payload; larger images are omitted with [IMAGE_OMITTED] */
  maxImageBytes?: number;
}


export interface SummarizerService {
  summarize(
    items: NormalizedItem[],
    rules: SummaryRuleset,
    options?: SummarizeOptions,
  ): Promise<SummaryPoint[]>;
}

export type TextPart = { type: "text"; text: string };

export type ImagePart = { type: "image_url"; image_url: { url: string } };

export type ContentPart = TextPart | ImagePart;
