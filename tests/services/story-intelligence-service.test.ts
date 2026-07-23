import { test } from "bun:test";
import { assertEquals, assertRejects } from "../assertions.ts";
import { ConnectorId } from "../../src/constants.ts";
import type {
  AnalyzedStoryItem,
  PersistedStoryCandidate,
  StoryItemInput,
  StoryPreferenceRule,
} from "../../src/personalization/story.types.ts";
import {
  fingerprintStoryItem,
  OpenAICompatibleStoryIntelligenceService,
} from "../../src/services/story-intelligence-service.ts";

function item(index: number, overrides: Partial<StoryItemInput["payload"]> = {}): StoryItemInput {
  return {
    itemId: `item-${index}`, feedId: "feed", feedName: "Feed", sourceId: "source",
    payload: { connectorId: ConnectorId.RSS, feedExternalId: "feed", externalId: `${index}`, date: index, title: `Title ${index}`, text: `Text ${index}`, author: null, url: `https://example.com/${index}`, ...overrides },
  };
}

function analysis(input: StoryItemInput, storyKey: string, developmentKey: string, urls: string[] = []): AnalyzedStoryItem {
  return { ...input, fingerprint: `fp-${input.itemId}`, analysis: { language: "en", canonicalUrls: urls, topics: ["Film"], entities: ["Studio"], storyKey, storyTitle: "A Film", developmentKey, developmentType: developmentKey, developmentTitle: developmentKey, mediaDescription: null } };
}

function persisted(id: string, analyzed: AnalyzedStoryItem, type = "news"): PersistedStoryCandidate {
  return {
    id,
    version: 1,
    candidate: {
      canonicalKey: analyzed.analysis.storyKey,
      title: analyzed.analysis.storyTitle,
      topics: analyzed.analysis.topics,
      entities: analyzed.analysis.entities,
      developments: [{
        canonicalKey: analyzed.analysis.developmentKey,
        type,
        title: analyzed.analysis.developmentTitle,
        occurredAt: analyzed.payload.date,
        items: [analyzed],
      }],
    },
  };
}

const prioritize: StoryPreferenceRule = { id: "rule-priority", label: "Film", kind: "topic", disposition: "prioritize", strength: 1 };

function analysisResponse(indexes: number[]): string {
  return JSON.stringify(indexes.map((i) => ({ i, language: "en", canonicalUrls: [`https://example.com/${i}`], topics: ["Film"], entities: ["Studio"], storyKey: `story-${i}`, storyTitle: `Story ${i}`, developmentKey: `development-${i}`, developmentType: "report", developmentTitle: `Development ${i}`, mediaDescription: null })));
}

test("analysis handles hundreds in bounded item batches and fingerprints deterministically", async () => {
  const calls: number[][] = [];
  const service = new OpenAICompatibleStoryIntelligenceService({
    maxItemsPerChunk: 17, maxTextBytesPerChunk: 100_000,
    client: { complete: async (_prompt, content) => { const indexes = content.split("\n").map((line) => JSON.parse(line).i as number); calls.push(indexes); return analysisResponse(indexes); } },
  });
  const inputs = Array.from({ length: 203 }, (_, index) => item(index));
  const results = await service.analyze(inputs);
  assertEquals(results.length, 203);
  assertEquals(calls.every((call) => call.length <= 17), true);
  assertEquals(calls.flat(), Array.from({ length: 203 }, (_, index) => index));
  assertEquals(results[0]!.fingerprint, await fingerprintStoryItem(inputs[0]!));
});

test("analysis bounds low-text media description concurrency and rejects partial output", async () => {
  let active = 0;
  let maximum = 0;
  const service = new OpenAICompatibleStoryIntelligenceService({
    maxConcurrentMediaDescriptions: 2,
    mediaDescriber: { describe: async () => { active++; maximum = Math.max(maximum, active); await Promise.resolve(); active--; return "Visible poster"; } },
    client: { complete: async (_prompt, content) => analysisResponse(content.split("\n").map((line) => JSON.parse(line).i as number)) },
  });
  await service.analyze(Array.from({ length: 7 }, (_, index) => item(index, { text: "", media: { type: "video" } })));
  assertEquals(maximum <= 2, true);
  const partial = new OpenAICompatibleStoryIntelligenceService({ client: { complete: async () => "[]" } });
  await assertRejects(() => partial.analyze([item(1)]), "returned 0 results for 1 inputs");
});

test("default media path uses the model-backed summarizer and preserves its description", async () => {
  let mediaCalls = 0;
  const service = new OpenAICompatibleStoryIntelligenceService({
    mediaSummarizer: {
      summarize: async (items, rules) => {
        mediaCalls++;
        assertEquals(items.length, 1);
        assertEquals(rules.includeMedia, true);
        return [{ text: "Poster OCR reads: 4 October.", sourceUrl: null }];
      },
    },
    client: {
      complete: async (_prompt, content) =>
        analysisResponse(content.split("\n").map((line) => JSON.parse(line).i as number)),
    },
  });
  const [result] = await service.analyze([
    item(0, { text: "", media: { type: "photo", localPath: "/tmp/poster.jpg" } }),
  ]);
  assertEquals(mediaCalls, 1);
  assertEquals(result!.analysis.mediaDescription, "Poster OCR reads: 4 October.");
});

test("analysis strictly rejects malformed fields and duplicate indexes", async () => {
  const malformed = new OpenAICompatibleStoryIntelligenceService({ client: { complete: async () => JSON.stringify([{ i: 0, extra: true }]) } });
  await assertRejects(() => malformed.analyze([item(0)]));
  const duplicate = new OpenAICompatibleStoryIntelligenceService({ client: { complete: async () => analysisResponse([0, 0]) } });
  await assertRejects(() => duplicate.analyze([item(0), item(1)]), "duplicate, missing, or unknown indexes");
});

test("analysis rejects identity keys that normalize to empty", async () => {
  const service = new OpenAICompatibleStoryIntelligenceService({
    client: {
      complete: async () => JSON.stringify([{
        i: 0, language: "en", canonicalUrls: [], topics: [], entities: [],
        storyKey: "---", storyTitle: "Story", developmentKey: "...",
        developmentType: "!!!", developmentTitle: "Development", mediaDescription: null,
      }]),
    },
  });
  await assertRejects(() => service.analyze([item(0)]), "must contain a letter or number");
});

test("model-invented shared URLs are not trusted as resolution identity edges", async () => {
  const left = analysis(item(0), "left-story", "left", ["https://invented.example/shared"]);
  const right = analysis(item(1), "right-story", "right", ["https://invented.example/shared"]);
  left.analysis.topics = ["Science"];
  left.analysis.entities = ["Alpha"];
  right.analysis.topics = ["Sports"];
  right.analysis.entities = ["Beta"];
  const service = new OpenAICompatibleStoryIntelligenceService({
    client: { complete: async () => { throw new Error("unrelated groups need no adjudication"); } },
  });
  assertEquals((await service.resolve([left, right])).length, 2);
});

test("resolution clusters exact syndicated URLs while retaining stable developments", async () => {
  const service = new OpenAICompatibleStoryIntelligenceService({ client: { complete: async (_prompt, content) => JSON.stringify(content.split("\n").map((line) => ({ i: JSON.parse(line).i, sameStory: false }))) } });
  const shared = "https://wire.example/story";
  const resolved = await service.resolve([
    analysis(item(0, { url: shared }), "Film Launch Teaser", "teaser", [shared]),
    analysis(item(1, { url: shared }), "Film Launch Poster", "poster", [shared]),
    analysis(item(2, { url: shared }), "Film Launch Trailer", "trailer", [shared]),
    analysis(item(3), "Different Story", "report"),
  ]);
  assertEquals(resolved.length, 2);
  assertEquals(resolved[0]!.developments.map((value) => value.canonicalKey), ["film-launch-teaser:poster", "film-launch-teaser:teaser", "film-launch-teaser:trailer"]);
  assertEquals(resolved[1]!.canonicalKey, "different-story");
});

test("global resolution joins cross-batch developments and reuses a recent canonical key", async () => {
  const service = new OpenAICompatibleStoryIntelligenceService({
    maxItemsPerChunk: 1,
    maxTextBytesPerChunk: 100_000,
    client: {
      complete: async (prompt, content) => {
        const records = content.split("\n").map((line) => JSON.parse(line));
        if (prompt.includes("Adjudicate whether")) {
          return JSON.stringify(records.map(({ i }) => ({ i, sameStory: true })));
        }
        return JSON.stringify(records.map(({ i }) => ({
          i, language: "en", canonicalUrls: [], topics: ["Film"], entities: ["Aurora"],
          storyKey: `changed-key-${i}`, storyTitle: `Aurora ${i === 0 ? "teaser" : i === 1 ? "poster" : "trailer"}`,
          developmentKey: i === 0 ? "teaser" : i === 1 ? "poster" : "trailer",
          developmentType: i === 0 ? "teaser" : i === 1 ? "poster" : "trailer",
          developmentTitle: `Aurora development ${i}`, mediaDescription: null,
        })));
      },
    },
  });
  const analyzed = await service.analyze([item(0), item(1), item(2)]);
  const resolved = await service.resolve(analyzed, [{
    id: "existing-story", canonicalKey: "stable-aurora", title: "Aurora announced",
    topics: ["Film"], entities: ["Aurora"], lastUpdatedAt: 100,
  }]);
  assertEquals(resolved.length, 1);
  assertEquals(resolved[0]!.canonicalKey, "stable-aurora");
  assertEquals(resolved[0]!.developments.map((value) => value.type), ["poster", "teaser", "trailer"]);
});

test("global resolution rejects partial pair adjudication", async () => {
  const service = new OpenAICompatibleStoryIntelligenceService({
    client: { complete: async () => "[]" },
  });
  await assertRejects(() => service.resolve([
    analysis(item(0), "changed-one", "teaser"),
    analysis(item(1), "changed-two", "trailer"),
  ]), "returned 0 results for 1 inputs");
});

test("classification includes all without scoring rules and hard mutes override", async () => {
  const source = analysis(item(0, { text: "Secret launch details" }), "film", "trailer");
  const stories = [persisted("one", source, "trailer"), persisted("two", analysis(item(1), "other", "report"))];
  const mute: StoryPreferenceRule = { id: "mute", label: "secret launch", kind: "phrase", disposition: "mute", strength: 1 };
  const service = new OpenAICompatibleStoryIntelligenceService({ client: { complete: async () => { throw new Error("model must not run"); } } });
  assertEquals((await service.classify(stories, [], 90)).map((value) => value.relevant), [true, true]);
  const decisions = await service.classify(stories, [mute], 90);
  assertEquals(decisions.map((value) => value.relevant), [false, true]);
  assertEquals(decisions[0]!.blockedByInterestRuleIds, ["mute"]);
});

test("classification permits zero or all results and thresholds absolute scores without top-K", async () => {
  const stories = Array.from({ length: 25 }, (_, index) => persisted(`${index}`, analysis(item(index), `story-${index}`, "report")));
  let score = 49;
  const service = new OpenAICompatibleStoryIntelligenceService({
    maxItemsPerChunk: 6, maxTextBytesPerChunk: 100_000,
    client: { complete: async (_prompt, content) => JSON.stringify(content.split("\n").map((line) => ({ i: JSON.parse(line).i, score, matchedRuleIds: [prioritize.id], reason: "absolute score" }))) },
  });
  assertEquals((await service.classify(stories, [prioritize], 50)).filter((value) => value.relevant).length, 0);
  score = 50;
  assertEquals((await service.classify(stories, [prioritize], 50)).filter((value) => value.relevant).length, 25);
});

test("classification applies free-text preference context without inventing a rule match", async () => {
  let observedPrompt = "";
  let observedInput = "";
  const story = persisted("one", analysis(item(0), "one", "report"));
  const service = new OpenAICompatibleStoryIntelligenceService({
    client: {
      complete: async (prompt, content) => {
        observedPrompt = prompt;
        observedInput = content;
        return JSON.stringify([{ i: 0, score: 75, matchedRuleIds: [], reason: "Matches reader context." }]);
      },
    },
  });
  const [decision] = await service.classify([story], [], 70, {
    preferencePrompt: "Prefer practical engineering launches",
  });
  assertEquals(decision!.relevant, true);
  assertEquals(decision!.matchedInterestRuleIds, []);
  assertEquals(observedPrompt.includes("Prefer practical engineering launches"), true);
  assertEquals(observedInput.includes("Prefer practical engineering launches"), true);
});

test("classification rejects partial indexes and unknown rule IDs", async () => {
  const stories = [persisted("one", analysis(item(0), "one", "report"))];
  const partial = new OpenAICompatibleStoryIntelligenceService({ client: { complete: async () => "[]" } });
  await assertRejects(() => partial.classify(stories, [prioritize], 50), "returned 0 results for 1 inputs");
  const unknown = new OpenAICompatibleStoryIntelligenceService({ client: { complete: async () => JSON.stringify([{ i: 0, score: 80, matchedRuleIds: ["unknown"], reason: "bad" }]) } });
  await assertRejects(() => unknown.classify(stories, [prioritize], 50), "unknown rule IDs");
});
