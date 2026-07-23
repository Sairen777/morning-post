import type { Database } from "../src/db/client.ts";
import { digests } from "../src/db/schema/digest.ts";
import { digestStories, stories } from "../src/db/schema/story.ts";
import { createUser } from "../src/repositories/user-repository.ts";

export async function createStoryFeedbackFixture(
  database: Database,
  email: string,
  options: {
    storyVersion?: number;
    topics?: string[];
    entities?: string[];
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
  const [digestStory] = await database.insert(digestStories).values({
    digestId: digest.id,
    storyId: story.id,
    storyVersion,
    profileVersion: user.interestProfileVersion,
    title: story.title,
    topics: options.topics ?? ["Climate", "Energy"],
    entities: options.entities ?? ["Example Corp"],
    points: [],
    sources: [],
    relevanceScore: 80,
    matchedInterestRuleIds: [],
    generatedAt: 300,
  }).returning();
  return { user, story, digest, digestStory };
}
