import type { IMedia } from "../connectors/connector.types.ts";

export interface NormalizedItem {
  // TODO: use enum Connector
  connectorId: string;
  sourceId: string;
  date: Date;
  title: string | null;
  text: string;
  author?: string | null;
  url: string | null;
  // TODO: if media is a common type then it should be declared on a higher level
  media?: IMedia;
  // TODO: abstract item to summarize shouldnt have telegram specified items like this
  isGroup?: boolean;
}

export interface SummaryRuleset {
  language?: string;
  focus?: string;
  format?: string;
  maxLength?: number;
  // TODO: this also looks like it belong to telegram rather than abstract ruleset
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
  summarize(
    items: NormalizedItem[],
    rules: SummaryRuleset,
  ): Promise<SummaryPoint[]>;
}
