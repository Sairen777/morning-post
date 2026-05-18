export interface NormalizedItem {
  connectorId: string;
  sourceId: string;
  date: Date;
  title: string | null;
  text: string;
  url: string | null;
  media?: import("../connectors/connector.types.ts").IMedia;
}

export interface SummaryRuleset {
  language?: string;
  focus?: string;
  format?: string;
  maxLength?: number;
}

export interface SummarizerService {
  summarize(items: NormalizedItem[], rules: SummaryRuleset): Promise<string>;
}
