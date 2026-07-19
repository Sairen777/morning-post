export interface PublicUser {
  id: string;
  name: string;
  email: string;
  systemPrompt: string;
  defaultLanguage: string | null;
  createdAt: number;
  updatedAt: number;
}

export interface PublicSource {
  id: string;
  userId: string;
  connectorId: string;
  position: number | null;
  enabled: boolean;
  connected: boolean;
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
  position: number | null;
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
  contentAccess: "full" | "preview";
  points: SummaryPoint[];
}

export interface ArticleSummaryContent {
  kind: "articles";
  articles: ArticleSummary[];
}

export type SummaryContent = AggregateSummaryContent | ArticleSummaryContent;

export interface DigestSection {
  sourceId: string;
  connectorId: string;
  feedId: string;
  feedName: string;
  feedRemoved: boolean;
  content: SummaryContent;
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

export type ConnectorId =
  | "Telegram"
  | "Substack"
  | "YouTube"
  | "Reddit"
  | "X"
  | "RSS";

export interface SubstackSessionInput {
  substackSessionId: string;
  connectSessionId?: string;
}

export interface SubstackSessionResponse {
  source: PublicSource;
}

export interface SubstackPublicationInput {
  publicationUrl: string;
}

export interface SubstackPublicationResponse {
  source: PublicSource;
  feed: PublicFeed;
}

export type TelegramLoginStatus =
  | "pending"
  | "needs_2fa"
  | "complete"
  | "error"
  | "expired";

export interface TelegramLoginStart {
  loginSessionId: string;
  qrUrl: string;
  expiresAt: number;
}

export interface TelegramLoginSessionStatus {
  status: TelegramLoginStatus;
  qrUrl?: string;
  errorMessage?: string;
  expiresAt: number;
}

export interface DisconnectSourceResponse {
  source: PublicSource;
  revokeTelegramSession: boolean;
  message: string;
}

export type DigestRunTrigger = "manual" | "scheduled";

export type DigestRunStatus = "running" | "complete" | "partial" | "failed";

export type DigestRunFeedStage = "connector" | "ingestion" | "summarization";

export type DigestRunFeedStatus = "running" | "complete" | "skipped" | "failed";

export interface PublicDigestRun {
  id: string;
  digestId: string | null;
  userId: string;
  trigger: DigestRunTrigger;
  periodStartMs: number;
  periodEndMs: number;
  status: DigestRunStatus;
  startedAt: number;
  finishedAt: number | null;
  errorMessage: string | null;
}

export interface PublicDigestRunFeed {
  id: string;
  runId: string;
  sourceId: string | null;
  feedId: string | null;
  connectorId: string;
  feedExternalId: string | null;
  feedName: string | null;
  stage: DigestRunFeedStage;
  status: DigestRunFeedStatus;
  itemCount: number | null;
  startedAt: number;
  finishedAt: number | null;
  errorMessage: string | null;
}

export interface DigestRunDetail {
  run: PublicDigestRun;
  feeds: PublicDigestRunFeed[];
}

export interface CursorPage<T> {
  data: T[];
  nextCursor?: string;
}
