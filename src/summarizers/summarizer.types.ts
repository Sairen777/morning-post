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

export interface SummarizerService {
  summarize(
    items: NormalizedItem[],
    rules: SummaryRuleset,
  ): Promise<SummaryPoint[]>;
}

export type TextPart = { type: "text"; text: string };

export type ImagePart = { type: "image_url"; image_url: { url: string } };

export type ContentPart = TextPart | ImagePart;
