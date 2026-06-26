export interface PublicUser {
  id: string;
  name: string;
  email: string;
  systemPrompt: string;
  defaultLanguage: string;
  defaultModel: string;
  createdAt: number;
  updatedAt: number;
}

export interface PublicSource {
  id: string;
  userId: string;
  connectorId: string;
  position: number;
  enabled: boolean;
  createdAt: number;
  updatedAt: number;
}

export type FeedKind = "news" | "discussion";

export interface AvailableFeed {
  externalId: string;
  name: string;
  kind: FeedKind;
}

export interface PublicFeed {
  id: string;
  sourceId: string;
  externalId: string;
  name: string;
  kind: FeedKind;
  customPrompt: string | null;
  position: number;
  enabled: boolean;
  deletedAt: number | null;
  lastFetchedPeriodEndMs: number | null;
  createdAt: number;
  updatedAt: number;
}

export type DigestStatus = "pending" | "complete" | "failed";

export interface PublicDigest {
  id: string;
  userId: string;
  periodStartMs: number;
  periodEndMs: number;
  status: DigestStatus;
  createdAt: number;
  updatedAt: number;
}

export interface SummaryPoint {
  text: string;
  sourceUrl: string | null;
  channel?: string;
  date?: number;
}

export interface DigestSection {
  sourceId: string;
  connectorId: string;
  feedId: string;
  feedName: string;
  feedRemoved: boolean;
  points: SummaryPoint[];
}

export interface DigestSourceGroup {
  sourceId: string;
  connectorId: string;
  sections: DigestSection[];
}

export interface DigestView {
  digest: PublicDigest;
  sections: DigestSection[];
  groups: DigestSourceGroup[];
}

export interface ApiErrorBody {
  error: {
    code: string;
    message: string;
  };
}
