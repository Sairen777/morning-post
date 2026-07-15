import type { ConnectorId } from "../constants.ts";

export interface Connector<TRawData> {
  getRawData(from: number, to: number, feedExternalIds?: string[], signal?: AbortSignal): Promise<TRawData>;
  getNormalizedData(from: number, to: number, feedExternalIds?: string[], signal?: AbortSignal): Promise<NormalizedData>;
  listAvailableFeeds?(): Promise<AvailableFeed[]>;
}

export interface AvailableFeed {
  externalId: string;
  name: string;
  kind: FeedKind;
}

export type FeedKind = "news" | "discussion";

// The map key is the feed's connector-native id, unique only within a source;
// it is the same value as NormalizedItem.feedExternalId.
export type NormalizedData = Record<string, NormalizedItem[]>;

export interface NormalizedItem {
  connectorId: ConnectorId;
  feedExternalId: string;
  externalId: string;
  date: number;
  title: string | null;
  text: string;
  author: string | null;
  url: string | null;
  media?: Media;
  meta?: Record<string, unknown>;
}

export type Media =
  | { type: "photo"; localPath: string }
  | { type: "album"; localPaths: string[] }
  | { type: "video" }
  | { type: "document"; mimeType: string }
  | { type: "webpage"; url: string };
