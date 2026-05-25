export interface INormalizedItem {
  // TODO: use enum Connector
  connectorId: string;
  sourceId: string;
  date: Date;
  title: string | null;
  text: string;
  author?: string | null;
  url: string | null;
  // TODO: if media is a common type then it should be declared on a higher level
  media?: import("../connectors/connector.types.ts").IMedia;
  // TODO: abstract item to summarize shouldnt have telegram specified items like this
  isGroup?: boolean;
}

export interface ISummaryRuleset {
  language?: string;
  focus?: string;
  format?: string;
  maxLength?: number;
  // TODO: this also looks like it belong to telegram rather than abstract ruleset
  mode?: "news" | "discussion";
}

// Note: sourceUrl refers to the primary/first post when a bullet covers multiple posts.
export interface ISummaryPoint<T> {
  text: string;
  sourceUrl: string | null;
  date: string;
  // TODO: metadata is connector-specific data, like channel for telegram
  metadata: T;
}

export interface ISummarizer<T> {
  summarize(
    items: INormalizedItem[],
    rules: ISummaryRuleset,
  ): Promise<ISummaryPoint<T>[]>;
}
