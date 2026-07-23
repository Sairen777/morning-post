import type { AnalyzedStoryItem, PersistedStoryCandidate, StoryIntelligenceService, StoryItemInput, StoryPreferenceRule } from "../../src/personalization/story.types.ts";
import { fingerprintStoryItem } from "../../src/services/story-intelligence-service.ts";

export class FixtureStoryIntelligence implements StoryIntelligenceService {
  async analyze(items: StoryItemInput[]): Promise<AnalyzedStoryItem[]> {
    return await Promise.all(items.map(async (item) => ({
      ...item,
      fingerprint: await fingerprintStoryItem(item),
      analysis: { language: "en", canonicalUrls: item.payload.url ? [item.payload.url] : [], topics: ["news"], entities: [], storyKey: "fixture-story", storyTitle: "Fixture Story", developmentKey: item.payload.externalId, developmentType: "report", developmentTitle: item.payload.title ?? "Report", mediaDescription: null },
    })));
  }
  async resolve(items: AnalyzedStoryItem[]) {
    if (items.length === 0) return [];
    return [{ canonicalKey: "fixture-story", title: "Fixture Story", topics: ["news"], entities: [], developments: items.map((item) => ({ canonicalKey: `${item.feedId}:${item.payload.externalId}`, type: "report", title: item.payload.title ?? "Report", occurredAt: item.payload.date, items: [item] })) }];
  }
  async classify(stories: PersistedStoryCandidate[], _rules: StoryPreferenceRule[], _threshold: number) {
    return stories.map((story) => ({ storyId: story.id, relevant: true, score: 90, matchedInterestRuleIds: [], blockedByInterestRuleIds: [], reason: "fixture" }));
  }
}

export const fixtureStoryIntelligence = new FixtureStoryIntelligence();
