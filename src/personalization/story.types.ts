import type { ConnectorId } from "../constants.ts";
import type { NormalizedItem } from "../connectors/connector.types.ts";
import type { SummaryPoint } from "../summarizers/summarizer.types.ts";

export interface ItemAnalysisContent {
  language: string | null;
  canonicalUrls: string[];
  topics: string[];
  entities: string[];
  storyKey: string;
  storyTitle: string;
  developmentKey: string;
  developmentType: string;
  developmentTitle: string;
  mediaDescription: string | null;
}

export interface StoryItemInput {
  itemId: string;
  feedId: string;
  feedName: string;
  sourceId: string;
  payload: NormalizedItem;
}

export interface AnalyzedStoryItem {
  itemId: string;
  feedId: string;
  feedName: string;
  sourceId: string;
  fingerprint: string;
  payload: NormalizedItem;
  analysis: ItemAnalysisContent;
}

export interface ResolvedStoryDevelopment {
  canonicalKey: string;
  type: string;
  title: string;
  occurredAt: number;
  items: AnalyzedStoryItem[];
}

export interface ResolvedStoryCandidate {
  canonicalKey: string;
  title: string;
  topics: string[];
  entities: string[];
  developments: ResolvedStoryDevelopment[];
}

export interface StoryReference {
  id: string;
  canonicalKey: string;
  title: string;
  topics: string[];
  entities: string[];
  lastUpdatedAt: number;
}

export interface PersistedStoryCandidate {
  id: string;
  version: number;
  candidate: ResolvedStoryCandidate;
}

export interface StoryPreferenceRule {
  id: string;
  label: string;
  kind: "topic" | "entity" | "phrase" | "story_type";
  disposition: "prioritize" | "show_less" | "mute";
  strength: number;
}

export interface StoryIntelligenceOptions {
  signal?: AbortSignal;
  requestTimeoutMs?: number;
  preferencePrompt?: string;
}

export interface StoryIntelligenceService {
  analyze(
    items: StoryItemInput[],
    options?: StoryIntelligenceOptions,
  ): Promise<AnalyzedStoryItem[]>;
  resolve(
    items: AnalyzedStoryItem[],
    recentStories?: StoryReference[],
    options?: StoryIntelligenceOptions,
  ): Promise<ResolvedStoryCandidate[]>;
  classify(
    stories: PersistedStoryCandidate[],
    rules: StoryPreferenceRule[],
    threshold: number,
    options?: StoryIntelligenceOptions,
  ): Promise<StoryRelevanceDecision[]>;
}

export interface StorySource {
  itemId: string;
  connectorId: ConnectorId;
  sourceId: string;
  feedId: string;
  feedName: string;
  title: string | null;
  url: string | null;
  publishedAt: number;
}

export interface DigestStoryContent {
  storyId: string;
  storyVersion: number;
  title: string;
  topics: string[];
  entities: string[];
  points: SummaryPoint[];
  sources: StorySource[];
  relevanceScore: number;
  matchedInterestRuleIds: string[];
}

export interface StoryRelevanceDecision {
  storyId: string;
  relevant: boolean;
  score: number;
  matchedInterestRuleIds: string[];
  blockedByInterestRuleIds: string[];
  reason: string;
}
