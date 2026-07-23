import { test } from "bun:test";
import { and, eq } from "drizzle-orm";
import { assertEquals, assertRejects } from "../assertions.ts";
import { withTestDb } from "../../src/db/testing.ts";
import { interestRules } from "../../src/db/schema/interest-rule.ts";
import { storyFeedback } from "../../src/db/schema/story-feedback.ts";
import { users } from "../../src/db/schema/user.ts";
import { NotFoundError, ValidationError } from "../../src/server/errors.ts";
import { submitStoryFeedback } from "../../src/services/story-feedback-service.ts";
import { createStoryFeedbackFixture } from "../story-feedback-fixture.ts";
import { listDigestStories, replaceDigestStories } from "../../src/repositories/story-repository.ts";

async function profileVersion(database: Parameters<typeof submitStoryFeedback>[0], userId: string) {
  return (await database.select({ version: users.interestProfileVersion }).from(users).where(
    eq(users.id, userId),
  ))[0].version;
}

test("relevant feedback attaches the delivered version, infers topics, and is idempotent", async () => {
  await withTestDb(async (database) => {
    const fixture = await createStoryFeedbackFixture(
      database,
      "feedback-service-relevant@example.com",
      { storyVersion: 11 },
    );
    const initialVersion = await profileVersion(database, fixture.user.id);
    const input = {
      userId: fixture.user.id,
      storyId: fixture.story.id,
      digestStoryId: fixture.digestStory.id,
      action: "relevant" as const,
    };

    const first = await submitStoryFeedback(database, input);
    assertEquals(first.feedback.storyVersion, 11);
    assertEquals(first.interestRules.map((rule) => [rule.label, rule.disposition, rule.origin]), [
      ["Climate", "prioritize", "inferred"],
      ["Energy", "prioritize", "inferred"],
    ]);
    assertEquals(await profileVersion(database, fixture.user.id), initialVersion + 1);

    const replay = await submitStoryFeedback(database, input);
    assertEquals(replay.feedback, first.feedback);
    assertEquals(await profileVersion(database, fixture.user.id), initialVersion + 1);
    assertEquals((await database.select().from(storyFeedback).where(
      eq(storyFeedback.userId, fixture.user.id),
    )).length, 1);

    await submitStoryFeedback(database, { ...input, action: "not_relevant" });
    const versionAfterCorrection = await profileVersion(database, fixture.user.id);
    const staleReplay = await submitStoryFeedback(database, input);
    assertEquals(
      staleReplay.interestRules.map((rule) => rule.disposition),
      ["show_less", "show_less"],
    );
    assertEquals(
      await profileVersion(database, fixture.user.id),
      versionAfterCorrection,
    );
  });
});

test("digest regeneration preserves card identity and durable feedback", async () => {
  await withTestDb(async (database) => {
    const fixture = await createStoryFeedbackFixture(
      database,
      "feedback-service-rerun@example.com",
    );
    await submitStoryFeedback(database, {
      userId: fixture.user.id,
      storyId: fixture.story.id,
      digestStoryId: fixture.digestStory.id,
      action: "already_known",
    });

    const replacement = [{
      content: {
        storyId: fixture.story.id,
        storyVersion: fixture.story.version,
        title: fixture.story.title,
        topics: fixture.story.topics,
        entities: fixture.story.entities,
        points: [],
        sources: [],
        relevanceScore: 80,
        matchedInterestRuleIds: [],
      },
      profileVersion: fixture.user.interestProfileVersion,
      generatedAt: 301,
    }];
    const regenerated = await replaceDigestStories(
      database,
      fixture.user.id,
      fixture.digest.id,
      replacement,
    );
    assertEquals(regenerated[0].id, fixture.digestStory.id);
    const [upgraded] = await replaceDigestStories(
      database,
      fixture.user.id,
      fixture.digest.id,
      [{
        ...replacement[0],
        content: {
          ...replacement[0].content,
          storyVersion: fixture.story.version + 1,
        },
      }],
    );
    assertEquals(upgraded.id === fixture.digestStory.id, false);
    await assertRejects(
      () => submitStoryFeedback(database, {
        userId: fixture.user.id,
        storyId: fixture.story.id,
        digestStoryId: fixture.digestStory.id,
        action: "relevant",
      }),
      NotFoundError,
      "delivered story not found",
    );

    await replaceDigestStories(database, fixture.user.id, fixture.digest.id, []);
    assertEquals((await database.select().from(storyFeedback).where(
      eq(storyFeedback.userId, fixture.user.id),
    )).length, 1);

    const readded = await replaceDigestStories(
      database,
      fixture.user.id,
      fixture.digest.id,
      replacement,
    );
    const replay = await submitStoryFeedback(database, {
      userId: fixture.user.id,
      storyId: fixture.story.id,
      digestStoryId: readded[0].id,
      action: "already_known",
    });
    assertEquals((await database.select().from(storyFeedback).where(
      eq(storyFeedback.userId, fixture.user.id),
    )).length, 1);
    assertEquals(replay.feedback.digestStoryId, fixture.digestStory.id);
  });
});

test("feedback exposes and infers only valid delivered labels", async () => {
  await withTestDb(async (database) => {
    const fixture = await createStoryFeedbackFixture(
      database,
      "feedback-service-target@example.com",
      { topics: ["Valid topic", "x".repeat(201)] },
    );
    assertEquals(
      (await listDigestStories(database, fixture.user.id, fixture.digest.id))[0].topics,
      ["Valid topic"],
    );
    const relevant = await submitStoryFeedback(database, {
      userId: fixture.user.id,
      storyId: fixture.story.id,
      digestStoryId: fixture.digestStory.id,
      action: "relevant",
    });
    assertEquals(relevant.interestRules.map((rule) => rule.label), ["Valid topic"]);
    await assertRejects(
      () => submitStoryFeedback(database, {
        userId: fixture.user.id,
        storyId: fixture.story.id,
        digestStoryId: fixture.digestStory.id,
        action: "follow_topic",
        target: { kind: "topic", label: "Invented" },
      }),
      ValidationError,
      "not present",
    );
    assertEquals((await database.select().from(storyFeedback)).length, 1);
  });
});

test("inference preserves dismissed tombstones and only explicit mute feedback creates mute", async () => {
  await withTestDb(async (database) => {
    const fixture = await createStoryFeedbackFixture(
      database,
      "feedback-service-semantics@example.com",
    );
    await database.insert(interestRules).values({
      userId: fixture.user.id,
      label: "Climate",
      normalizedLabel: "climate",
      kind: "topic",
      disposition: "show_less",
      origin: "inferred",
      state: "dismissed",
      strength: 50,
      expiresAt: null,
      createdAt: 1,
      updatedAt: 1,
    });
    const initialVersion = await profileVersion(database, fixture.user.id);

    await submitStoryFeedback(database, {
      userId: fixture.user.id,
      storyId: fixture.story.id,
      digestStoryId: fixture.digestStory.id,
      action: "not_relevant",
    });
    const afterInference = await database.select().from(interestRules).where(
      eq(interestRules.userId, fixture.user.id),
    );
    const climate = afterInference.find((rule) => rule.normalizedLabel === "climate")!;
    const energy = afterInference.find((rule) => rule.normalizedLabel === "energy")!;
    assertEquals([climate.state, climate.disposition], ["dismissed", "show_less"]);
    assertEquals([energy.origin, energy.disposition], ["inferred", "show_less"]);
    assertEquals(afterInference.some((rule) => rule.disposition === "mute"), false);
    assertEquals(await profileVersion(database, fixture.user.id), initialVersion + 1);

    const muted = await submitStoryFeedback(database, {
      userId: fixture.user.id,
      storyId: fixture.story.id,
      digestStoryId: fixture.digestStory.id,
      action: "mute_topic",
      target: { kind: "entity", label: "example corp" },
    });
    const mute = muted.interestRules.find((rule) => rule.disposition === "mute")!;
    assertEquals([mute.label, mute.kind, mute.origin, mute.state], [
      "Example Corp",
      "entity",
      "explicit",
      "active",
    ]);
    assertEquals(await profileVersion(database, fixture.user.id), initialVersion + 2);

    const replay = await submitStoryFeedback(database, {
      userId: fixture.user.id,
      storyId: fixture.story.id,
      digestStoryId: fixture.digestStory.id,
      action: "mute_topic",
      target: { kind: "entity", label: "Example Corp" },
    });
    assertEquals(replay.feedback.id, muted.feedback.id);
    assertEquals(await profileVersion(database, fixture.user.id), initialVersion + 2);
    assertEquals((await database.select().from(interestRules).where(and(
      eq(interestRules.userId, fixture.user.id),
      eq(interestRules.disposition, "mute"),
    ))).length, 1);
  });
});
