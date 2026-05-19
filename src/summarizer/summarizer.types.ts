export interface NormalizedItem {
  connectorId: string;
  sourceId: string;
  date: Date;
  title: string | null;
  text: string;
  author?: string | null;
  url: string | null;
  media?: import("../connectors/connector.types.ts").IMedia;
  isGroup?: boolean;
}

export interface SummaryRuleset {
  language?: string;
  focus?: string;
  format?: string;
  maxLength?: number;
  mode?: "news" | "discussion";
}

// Note: sourceUrl refers to the primary/first post when a bullet covers multiple posts.
export interface SummaryPoint {
  text: string;
  sourceUrl: string | null;
  channel?: string;
  date?: string;
}

export interface SummarizerService {
  summarize(items: NormalizedItem[], rules: SummaryRuleset): Promise<SummaryPoint[]>;
}
