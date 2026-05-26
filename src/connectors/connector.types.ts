import type { ConnectorId } from "../constants.ts";

export interface Connector<TRawData> {
  getRawData(from: number, to: number): Promise<TRawData>;
  getNormalizedData(from: number, to: number): Promise<NormalizedData>;
}

export type NormalizedData = Record<string, NormalizedItem[]>;

export interface NormalizedItem {
  connectorId: ConnectorId;
  sourceId: string;
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
