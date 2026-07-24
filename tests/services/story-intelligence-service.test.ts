import { test } from "bun:test";
import { assertEquals, assertRejects, assertThrows } from "../assertions.ts";
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
  resolveStoryAnalysisMaxItems,
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

function analysisLine(input: StoryItemInput, index: number): string {
  return JSON.stringify({
    i: index,
    feed: input.feedName,
    title: input.payload.title,
    text: input.payload.text,
    url: input.payload.url,
    date: input.payload.date,
    mediaDescription: null,
  });
}

function classificationLine(story: PersistedStoryCandidate, index: number): string {
  return JSON.stringify({
    i: index,
    id: story.id,
    title: story.candidate.title,
    topics: story.candidate.topics,
    entities: story.candidate.entities,
    developments: story.candidate.developments.map((development) => ({
      type: development.type,
      title: development.title,
    })),
  });
}

test("story analysis item cap defaults safely, honors a lower generic budget, and accepts explicit overrides", async () => {
  const original = process.env["SUMMARIZER_MAX_ITEMS_PER_CHUNK"];
  const makeService = (maxItemsPerChunk?: number) => {
    const calls: number[] = [];
    const service = new OpenAICompatibleStoryIntelligenceService({
      maxItemsPerChunk,
      maxTextBytesPerChunk: 100_000,
      client: {
        complete: async (_prompt, content) => {
          const indexes = content.split("\n").map((line) => JSON.parse(line).i as number);
          calls.push(indexes.length);
          return analysisResponse(indexes);
        },
      },
    });
    return { service, calls };
  };
  try {
    delete process.env["SUMMARIZER_MAX_ITEMS_PER_CHUNK"];
    const defaults = makeService();
    process.env["SUMMARIZER_MAX_ITEMS_PER_CHUNK"] = "7";
    const lower = makeService();
    const explicit = makeService(12);
    await defaults.service.analyze(Array.from({ length: 23 }, (_, index) => item(index)));
    await lower.service.analyze(Array.from({ length: 15 }, (_, index) => item(index)));
    await explicit.service.analyze(Array.from({ length: 25 }, (_, index) => item(index)));
    assertEquals(defaults.calls, [10, 10, 3]);
    assertEquals(lower.calls, [7, 7, 1]);
    assertEquals(explicit.calls, [12, 12, 1]);
    assertThrows(() => resolveStoryAnalysisMaxItems(0), RangeError, "positive integer");
    assertThrows(() => resolveStoryAnalysisMaxItems(1.5), RangeError, "positive integer");
  } finally {
    if (original === undefined) delete process.env["SUMMARIZER_MAX_ITEMS_PER_CHUNK"];
    else process.env["SUMMARIZER_MAX_ITEMS_PER_CHUNK"] = original;
  }
});

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

test("analysis content byte budget permits an exact framed fit and splits on one-byte overflow", async () => {
  const inputs = [item(0), item(1)];
  const encoder = new TextEncoder();
  const framedBytes = inputs.reduce(
    (total, input, index) => total + encoder.encode(analysisLine(input, index)).length + 1,
    0,
  );
  const analyzeWithBudget = async (maxBytes: number) => {
    const requestSizes: number[] = [];
    const batchSizes: number[] = [];
    const service = new OpenAICompatibleStoryIntelligenceService({
      maxItemsPerChunk: 10,
      maxTextBytesPerChunk: maxBytes,
      client: {
        complete: async (_prompt, content) => {
          requestSizes.push(encoder.encode(content).length);
          const indexes = content.split("\n").map((line) => JSON.parse(line).i as number);
          batchSizes.push(indexes.length);
          return analysisResponse(indexes);
        },
      },
    });
    await service.analyze(inputs);
    return { requestSizes, batchSizes };
  };

  const exact = await analyzeWithBudget(framedBytes);
  assertEquals(exact.requestSizes.every((size) => size <= framedBytes), true);
  assertEquals(exact.batchSizes, [2]);
  const overflow = await analyzeWithBudget(framedBytes - 1);
  assertEquals(overflow.requestSizes.every((size) => size <= framedBytes - 1), true);
  assertEquals(overflow.batchSizes, [1, 1]);
});

test("analysis content partitioning counts Unicode as UTF-8 bytes", async () => {
  const inputs = [
    item(0, { title: "😀 first" }),
    item(1, { title: "😀 second" }),
  ];
  const encoded = inputs.map((input, index) => analysisLine(input, index));
  const codeUnitBudget = encoded.reduce((total, line) => total + line.length + 1, 0);
  const encoder = new TextEncoder();
  assertEquals(encoded.reduce((total, line) => total + encoder.encode(line).length + 1, 0) > codeUnitBudget, true);
  const requestSizes: number[] = [];
  const batchSizes: number[] = [];
  const service = new OpenAICompatibleStoryIntelligenceService({
    maxItemsPerChunk: 10,
    maxTextBytesPerChunk: codeUnitBudget,
    client: {
      complete: async (_prompt, content) => {
        requestSizes.push(encoder.encode(content).length);
        const indexes = content.split("\n").map((line) => JSON.parse(line).i as number);
        batchSizes.push(indexes.length);
        return analysisResponse(indexes);
      },
    },
  });
  await service.analyze(inputs);
  assertEquals(requestSizes.every((size) => size <= codeUnitBudget), true);
  assertEquals(batchSizes, [1, 1]);
});

test("analysis describes low-text media serially by default", async () => {
  let active = 0;
  let maximum = 0;
  const service = new OpenAICompatibleStoryIntelligenceService({
    mediaDescriber: { describe: async () => { active++; maximum = Math.max(maximum, active); await Promise.resolve(); active--; return "Visible poster"; } },
    client: { complete: async (_prompt, content) => analysisResponse(content.split("\n").map((line) => JSON.parse(line).i as number)) },
  });
  await service.analyze(Array.from({ length: 3 }, (_, index) => item(index, { text: "", media: { type: "video" } })));
  assertEquals(maximum, 1);
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
  assertEquals(maximum, 2);
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

test("analysis derives an omitted story title from the trimmed source title", async () => {
  const service = new OpenAICompatibleStoryIntelligenceService({
    client: {
      complete: async () => JSON.stringify([{
        i: 0, language: "en", canonicalUrls: [], topics: [], entities: [],
        storyKey: "model-story", developmentKey: "development",
        developmentType: "report", developmentTitle: "Development", mediaDescription: null,
      }]),
    },
  });
  const [result] = await service.analyze([item(0, { title: "  Source Story Title  " })]);
  assertEquals(result!.analysis.storyTitle, "Source Story Title");
});

test("analysis derives an omitted story title from the normalized story key when the source title is empty", async () => {
  const service = new OpenAICompatibleStoryIntelligenceService({
    client: {
      complete: async () => JSON.stringify([{
        i: 0, language: "en", canonicalUrls: [], topics: [], entities: [],
        storyKey: "  Model Story Key  ", developmentKey: "development",
        developmentType: "report", developmentTitle: "Development", mediaDescription: null,
      }]),
    },
  });
  const [result] = await service.analyze([item(0, { title: "   " })]);
  assertEquals(result!.analysis.storyTitle, "model-story-key");
});

test("analysis accepts provider metadata omissions and canalUrls typo with deterministic trusted fallbacks", async () => {
  const service = new OpenAICompatibleStoryIntelligenceService({
    mediaDescriber: {
      describe: async () => "Trusted media description",
    },
    client: {
      complete: async () => JSON.stringify([{
        i: 0,
        canalUrls: ["https://model.example/untrusted"],
        storyKey: "  Model Story  ",
        developmentKey: "  First Report  ",
      }]),
    },
  });
  const [result] = await service.analyze([item(0, {
    title: "  Trusted Source Title  ",
    text: "",
    media: { type: "photo", localPath: "/tmp/provider-shape.jpg" },
  })]);

  assertEquals(result!.analysis, {
    language: null,
    canonicalUrls: ["https://example.com/0"],
    topics: [],
    entities: [],
    storyKey: "model-story",
    storyTitle: "Trusted Source Title",
    developmentKey: "first-report",
    developmentType: "first-report",
    developmentTitle: "Trusted Source Title",
    mediaDescription: "Trusted media description",
  });
});

test("analysis keeps optional metadata typed while rejecting unknown keys and invalid or missing identity", async () => {
  const analyzeRecord = (record: Record<string, unknown>) =>
    new OpenAICompatibleStoryIntelligenceService({
      client: { complete: async () => JSON.stringify([record]) },
    }).analyze([item(0)]);

  await assertRejects(() => analyzeRecord({
    i: 0,
    storyKey: "story",
    developmentKey: "development",
    unrelated: true,
  }));
  await assertRejects(() => analyzeRecord({
    i: 0,
    storyKey: "story",
  }));
  await assertRejects(() => analyzeRecord({
    i: 0,
    storyKey: "---",
    developmentKey: "development",
  }), "must contain a letter or number");
  await assertRejects(() => analyzeRecord({
    i: 0,
    storyKey: "story",
    developmentKey: "development",
    topics: "Film",
  }));
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

test("resolution clusters exact keys and syndicated URLs without model calls while retaining stable developments", async () => {
  const service = new OpenAICompatibleStoryIntelligenceService({ client: { complete: async () => { throw new Error("resolution must not call the model"); } } });
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

test("resolution reuses an exact recent key but does not merge near-matching stories", async () => {
  const service = new OpenAICompatibleStoryIntelligenceService({
    client: { complete: async () => { throw new Error("resolution must not call the model"); } },
  });
  const resolved = await service.resolve([
    analysis(item(0), "Stable Aurora", "teaser"),
    analysis(item(1), "stable-aurora", "poster"),
    analysis(item(2), "Stable Aurora Sequel", "trailer"),
  ], [{
    id: "existing-story", canonicalKey: "STABLE AURORA", title: "Aurora announced",
    topics: ["Film"], entities: ["Aurora"], lastUpdatedAt: 100,
  }]);
  assertEquals(resolved.length, 2);
  assertEquals(resolved[0]!.canonicalKey, "STABLE AURORA");
  assertEquals(resolved[0]!.developments.map((value) => value.type), ["poster", "teaser"]);
  assertEquals(resolved[1]!.canonicalKey, "stable-aurora-sequel");
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
    client: { complete: async (_prompt, content) => JSON.stringify(content.split("\n").slice(1).map((line) => ({ i: JSON.parse(line).i, score, matchedRuleIds: [prioritize.id], reason: "absolute score" }))) },
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
  assertEquals(observedPrompt.includes("Prefer practical engineering launches"), false);
  assertEquals(observedInput.match(/Prefer practical engineering launches/g)?.length, 1);
});

test("classification partitions 120 candidates as 50, 50, and 20 with shared context once per request", async () => {
  const stories = Array.from({ length: 120 }, (_, index) =>
    persisted(`${index}`, analysis(item(index), `story-${index}`, "report"))
  );
  const batchSizes: number[] = [];
  const service = new OpenAICompatibleStoryIntelligenceService({
    maxItemsPerChunk: 3,
    maxTextBytesPerChunk: 1_000_000,
    client: {
      complete: async (_prompt, content) => {
        const lines = content.split("\n");
        const context = JSON.parse(lines[0]!);
        assertEquals(context.activeRules, [prioritize]);
        assertEquals(context.preferencePrompt, "reader profile");
        const candidates = lines.slice(1).map((line) => JSON.parse(line));
        batchSizes.push(candidates.length);
        return JSON.stringify(candidates.reverse().map(({ i }) => ({
          i, score: i % 101, matchedRuleIds: [prioritize.id], reason: `Story ${i}`,
        })));
      },
    },
  });
  const decisions = await service.classify(stories, [prioritize], 50, {
    preferencePrompt: "reader profile",
  });
  assertEquals(batchSizes, [50, 50, 20]);
  assertEquals(decisions.map((decision) => decision.storyId), stories.map((story) => story.id));
  assertEquals(decisions.map((decision) => decision.score), Array.from({ length: 120 }, (_, index) => index % 101));
});

test("classification request byte budget permits an exact fit and splits on one-byte overflow", async () => {
  const stories = [
    persisted("first", analysis(item(0), "first", "report")),
    persisted("second", analysis(item(1), "second", "report")),
  ];
  const sharedContext = JSON.stringify({ activeRules: [prioritize], preferencePrompt: null });
  const encoder = new TextEncoder();
  const exactBytes = encoder.encode(
    `${sharedContext}\n${classificationLine(stories[0]!, 0)}\n${classificationLine(stories[1]!, 1)}`,
  ).length;
  const classifyWithBudget = async (maxBytes: number) => {
    const requestSizes: number[] = [];
    const batchSizes: number[] = [];
    const service = new OpenAICompatibleStoryIntelligenceService({
      maxTextBytesPerChunk: maxBytes,
      client: {
        complete: async (_prompt, content) => {
          requestSizes.push(encoder.encode(content).length);
          const indexes = content.split("\n").slice(1).map((line) => JSON.parse(line).i as number);
          batchSizes.push(indexes.length);
          return JSON.stringify(indexes.map((i) => ({ i, score: 80, matchedRuleIds: [], reason: "fit" })));
        },
      },
    });
    await service.classify(stories, [prioritize], 50);
    return { requestSizes, batchSizes };
  };
  const exact = await classifyWithBudget(exactBytes);
  assertEquals(exact.requestSizes, [exactBytes]);
  assertEquals(exact.batchSizes, [2]);
  const overflow = await classifyWithBudget(exactBytes - 1);
  assertEquals(overflow.requestSizes.every((size) => size <= exactBytes - 1), true);
  assertEquals(overflow.batchSizes, [1, 1]);
});

test("classification rejects shared context that leaves no candidate bytes before calling the client", async () => {
  const preferencePrompt = "reader context";
  const sharedContext = JSON.stringify({ activeRules: [], preferencePrompt });
  let calls = 0;
  const service = new OpenAICompatibleStoryIntelligenceService({
    maxTextBytesPerChunk: new TextEncoder().encode(sharedContext).length + 1,
    client: {
      complete: async () => {
        calls++;
        return "[]";
      },
    },
  });
  await assertRejects(
    () => service.classify([persisted("one", analysis(item(0), "one", "report"))], [], 50, { preferencePrompt }),
    RangeError,
    "context exceeds the request byte budget",
  );
  assertEquals(calls, 0);
});

test("classification partitions by UTF-8 bytes rather than Unicode code units", async () => {
  const stories = [
    persisted("😀-one", analysis(item(0), "first", "report")),
    persisted("😀-two", analysis(item(1), "second", "report")),
  ];
  stories[0]!.candidate.title = "Launch 😀";
  stories[1]!.candidate.title = "Launch 😀";
  const sharedContext = JSON.stringify({ activeRules: [prioritize], preferencePrompt: null });
  const combined = `${sharedContext}\n${classificationLine(stories[0]!, 0)}\n${classificationLine(stories[1]!, 1)}`;
  const maxBytes = combined.length;
  const encoder = new TextEncoder();
  assertEquals(encoder.encode(combined).length > maxBytes, true);
  const requestSizes: number[] = [];
  const batchSizes: number[] = [];
  const service = new OpenAICompatibleStoryIntelligenceService({
    maxTextBytesPerChunk: maxBytes,
    client: {
      complete: async (_prompt, content) => {
        requestSizes.push(encoder.encode(content).length);
        const indexes = content.split("\n").slice(1).map((line) => JSON.parse(line).i as number);
        batchSizes.push(indexes.length);
        return JSON.stringify(indexes.map((i) => ({ i, score: 80, matchedRuleIds: [], reason: "unicode" })));
      },
    },
  });
  await service.classify(stories, [prioritize], 50);
  assertEquals(batchSizes, [1, 1]);
  assertEquals(requestSizes.every((size) => size <= maxBytes), true);
});

test("classification rejects partial indexes and unknown rule IDs", async () => {
  const stories = [persisted("one", analysis(item(0), "one", "report"))];
  const partial = new OpenAICompatibleStoryIntelligenceService({ client: { complete: async () => "[]" } });
  await assertRejects(() => partial.classify(stories, [prioritize], 50), "returned 0 results for 1 inputs");
  const unknown = new OpenAICompatibleStoryIntelligenceService({ client: { complete: async () => JSON.stringify([{ i: 0, score: 80, matchedRuleIds: ["unknown"], reason: "bad" }]) } });
  await assertRejects(() => unknown.classify(stories, [prioritize], 50), "unknown rule IDs");
});
