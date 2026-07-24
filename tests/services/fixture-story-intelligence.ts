import type { AnalyzedStoryItem, PersistedStoryCandidate, StoryIntelligenceOptions, StoryIntelligenceService, StoryItemInput, StoryPreferenceRule } from "../../src/personalization/story.types.ts";
import { fingerprintStoryAnalysisMember, groupStoryAnalysisUnits, partitionStoryAnalysisUnits } from "../../src/services/story-intelligence-service.ts";

export class FixtureStoryIntelligence implements StoryIntelligenceService {
  async analyze(items: StoryItemInput[], options: StoryIntelligenceOptions = {}): Promise<AnalyzedStoryItem[]> {
    const units = options.analysisUnitSizes === undefined
      ? groupStoryAnalysisUnits(items)
      : partitionStoryAnalysisUnits(items, options.analysisUnitSizes);
    const memberFingerprints = await Promise.all(units.flatMap((unit) =>
      unit.items.map((_, memberIndex) =>
        fingerprintStoryAnalysisMember(unit, memberIndex)
      )
    ));
    let fingerprintIndex = 0;
    const fingerprintByInputIndex = new Map<number, string>();
    units.forEach((unit) => unit.memberIndexes.forEach((inputIndex) => {
      fingerprintByInputIndex.set(inputIndex, memberFingerprints[fingerprintIndex++]!);
    }));
    return await Promise.all(items.map(async (item, index) => ({
      ...item,
      fingerprint: fingerprintByInputIndex.get(index)!,
      analysis: { language: "en", canonicalUrls: item.payload.url ? [item.payload.url] : [], topics: ["news"], entities: [], storyKey: "fixture-story", storyTitle: "Fixture Story", developmentKey: item.payload.externalId, developmentType: "report", developmentTitle: item.payload.title ?? "Report", mediaDescription: null, evidence: [] },
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
