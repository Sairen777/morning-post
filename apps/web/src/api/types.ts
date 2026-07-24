export type RelevanceFilterMode = "personalized" | "include_all";
export type RelevanceFilterOverride = "inherit" | RelevanceFilterMode;

export interface PublicUser {
  id: string;
  name: string;
  email: string;
  systemPrompt: string;
  summaryPrompt: string;
  defaultLanguage: string | null;
  defaultRelevanceFilterMode: RelevanceFilterMode;
  relevanceThreshold: number;
  maximumStoriesPerDigest: number | null;
  interestProfileVersion: number;
  createdAt: number;
  updatedAt: number;
}

export interface PublicSource {
  id: string;
  userId: string;
  connectorId: string;
  position: number | null;
  enabled: boolean;
  showPaidPostTitles: boolean;
  relevanceFilterMode: RelevanceFilterOverride;
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
  relevanceFilterMode: RelevanceFilterOverride;
  deletedAt: number | null;
  lastFetchedPeriodEndMs: number | null;
  createdAt: number;
  updatedAt: number;
}

export type InterestRuleKind = "topic" | "entity" | "phrase" | "story_type";
export type InterestRuleDisposition = "prioritize" | "show_less" | "mute";
export type InterestRuleOrigin = "explicit" | "inferred";

export interface PublicInterestRule {
  id: string;
  label: string;
  kind: InterestRuleKind;
  disposition: InterestRuleDisposition;
  origin: InterestRuleOrigin;
  state: "active" | "dismissed";
  strength: number;
  expiresAt: number | null;
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
  /**
   * Historical digest rows predate content modes, so older API fixtures may
   * omit this field. A missing mode is rendered as a legacy digest.
   */
  contentMode?: "legacy" | "stories";
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
  contentAccess: "full" | "preview" | "paid";
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

export interface DigestStorySource {
  itemId: string;
  connectorId: ConnectorId;
  sourceId: string;
  feedId: string;
  feedName: string;
  title: string | null;
  url: string | null;
  publishedAt: number;
}

export interface DigestStory {
  /** Delivered-card identifier used to validate feedback ownership. */
  id: string;
  digestId: string;
  storyId: string;
  storyVersion: number;
  profileVersion: number;
  title: string;
  topics: string[];
  entities: string[];
  points: SummaryPoint[];
  sources: DigestStorySource[];
  relevanceScore: number;
  matchedInterestRuleIds: string[];
  generatedAt: number;
}

export type StoryFeedbackStoryAction =
  | "relevant"
  | "not_relevant"
  | "already_known"
  | "too_repetitive";

export type StoryFeedbackTargetAction =
  | "follow_topic"
  | "show_less_topic"
  | "mute_topic";

export type StoryFeedbackAction =
  | StoryFeedbackStoryAction
  | StoryFeedbackTargetAction;

export interface StoryFeedbackTarget {
  kind: "topic" | "entity";
  label: string;
}

export type StoryFeedbackInput =
  | {
    digestStoryId: string;
    action: StoryFeedbackStoryAction;
    target?: never;
  }
  | {
    digestStoryId: string;
    action: StoryFeedbackTargetAction;
    target: StoryFeedbackTarget;
  };

export interface StoryFeedbackRecord {
  id: string;
  digestStoryId: string;
  storyId: string;
  storyVersion: number;
  action: StoryFeedbackAction;
  target?: StoryFeedbackTarget;
  createdAt: number;
}

export interface StoryFeedbackResponse {
  feedback: StoryFeedbackRecord;
  interestRules: PublicInterestRule[];
}

export interface PaidPost {
  newsletterName: string;
  title: string;
  sourceUrl: string | null;
  publishedAt: number;
}

export interface DigestView {
  digest: PublicDigest;
  /** Story-mode payload; absent from historical legacy responses. */
  stories?: DigestStory[];
  sections: DigestSection[];
  groups: DigestSourceGroup[];
  paidPosts: PaidPost[];
  failureReason: string | null;
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
