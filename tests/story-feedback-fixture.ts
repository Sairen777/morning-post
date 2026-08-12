import type { Database } from "../src/db/client.ts";
import { ConnectorId } from "../src/constants.ts";
import { digests } from "../src/db/schema/digest.ts";
import { sources } from "../src/db/schema/source.ts";
import { digestStories, stories } from "../src/db/schema/story.ts";
import type { StorySource } from "../src/personalization/story.types.ts";
import { createUser } from "../src/repositories/user-repository.ts";

export interface FixtureSourceOptions {
  id: string;
  connectorId?: ConnectorId;
  relevanceWarmup?: boolean;
  warmupNegativeFeedbackCount?: number;
}

export async function createStoryFeedbackFixture(
  database: Database,
  email: string,
  options: {
    storyVersion?: number;
    topics?: string[];
    entities?: string[];
    sources?: FixtureSourceOptions[];
  } = {},
) {
  const user = await createUser(database, {
    name: "Feedback Owner",
    email,
    passwordHash: "$argon2id$fixture",
    systemPrompt: "Be concise",
  });
  const storyVersion = options.storyVersion ?? 7;
  const [story] = await database.insert(stories).values({
    userId: user.id,
    canonicalKey: `story-${email}`,
    title: "Delivered story",
    topics: options.topics ?? ["Climate", "Energy"],
    entities: options.entities ?? ["Example Corp"],
    version: storyVersion,
    firstSeenAt: 100,
    lastUpdatedAt: 200,
  }).returning();
  const [digest] = await database.insert(digests).values({
    userId: user.id,
    periodStartMs: 1,
    periodEndMs: 2,
    status: "complete",
    contentMode: "stories",
    createdAt: 100,
    updatedAt: 100,
  }).returning();
  const storySources: StorySource[] = [];
  const insertedSourceIds = new Set<string>();
  const connectorBySourceId = new Map<string, ConnectorId>();
  const fallbackConnectorIds = [
    ConnectorId.RSS,
    ConnectorId.X,
    ConnectorId.Telegram,
    ConnectorId.Substack,
    ConnectorId.YouTube,
    ConnectorId.Reddit,
  ];
  for (const [sourceIndex, source] of (options.sources ?? []).entries()) {
    const connectorId = source.connectorId ??
      connectorBySourceId.get(source.id) ??
      fallbackConnectorIds[sourceIndex];
    if (connectorId === undefined) {
      throw new Error("Story feedback fixture supports at most six unique sources");
    }
    connectorBySourceId.set(source.id, connectorId);
    if (!insertedSourceIds.has(source.id)) {
      insertedSourceIds.add(source.id);
      await database.insert(sources).values({
        id: source.id,
        userId: user.id,
        connectorId,
        credentials: {
          v: 1,
          wrappedDataKey: "fixture",
          iv: "fixture",
          ciphertext: "fixture",
        },
        enabled: true,
        relevanceFilterMode: "inherit",
        relevanceWarmup: source.relevanceWarmup ?? true,
        relevanceWarmupNegativeFeedbackCount:
          source.warmupNegativeFeedbackCount ?? 0,
        createdAt: 100,
        updatedAt: 100,
      }).run();
    }
    storySources.push({
      itemId: crypto.randomUUID(),
      connectorId,
      sourceId: source.id,
      feedId: crypto.randomUUID(),
      feedName: "Fixture feed",
      title: null,
      url: null,
      publishedAt: 300,
    });
  }
  const [digestStory] = await database.insert(digestStories).values({
    digestId: digest.id,
    storyId: story.id,
    storyVersion,
    profileVersion: user.interestProfileVersion,
    title: story.title,
    topics: options.topics ?? ["Climate", "Energy"],
    entities: options.entities ?? ["Example Corp"],
    points: [],
    sources: storySources,
    relevanceScore: 80,
    matchedInterestRuleIds: [],
    generatedAt: 300,
  }).returning();
  return { user, story, digest, digestStory };
}
