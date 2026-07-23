import { test } from "bun:test";
import { eq } from "drizzle-orm";
import { assertEquals } from "../assertions.ts";
import { withTestDb } from "../../src/db/testing.ts";
import { storyFeedback } from "../../src/db/schema/story-feedback.ts";
import {
  lockOwnedDeliveredStory,
  saveStoryFeedbackIdempotently,
} from "../../src/repositories/story-feedback-repository.ts";
import { createStoryFeedbackFixture } from "../story-feedback-fixture.ts";

test("feedback repository scopes delivered stories and persists the delivered version idempotently", async () => {
  await withTestDb(async (database) => {
    const fixture = await createStoryFeedbackFixture(
      database,
      "feedback-repository@example.com",
      { storyVersion: 9 },
    );
    const stranger = await createStoryFeedbackFixture(
      database,
      "feedback-repository-stranger@example.com",
    );

    assertEquals(
      await lockOwnedDeliveredStory(
        database,
        stranger.user.id,
        fixture.digestStory.id,
        fixture.story.id,
      ),
      null,
    );
    const delivered = await lockOwnedDeliveredStory(
      database,
      fixture.user.id,
      fixture.digestStory.id,
      fixture.story.id,
    );
    assertEquals(delivered?.storyVersion, 9);

    const input = {
      userId: fixture.user.id,
      digestId: fixture.digest.id,
      digestStoryId: fixture.digestStory.id,
      storyId: fixture.story.id,
      storyVersion: delivered!.storyVersion,
      action: "already_known" as const,
      targetKind: "" as const,
      targetLabel: "",
      createdAt: 400,
    };
    const first = await saveStoryFeedbackIdempotently(database, input);
    const replay = await saveStoryFeedbackIdempotently(database, {
      ...input,
      createdAt: 999,
    });
    assertEquals(replay.feedback, first.feedback);
    assertEquals(first.feedback.storyVersion, 9);
    assertEquals(
      (await database.select().from(storyFeedback).where(
        eq(storyFeedback.digestStoryId, fixture.digestStory.id),
      )).length,
      1,
    );
  });
});
