import { test } from "bun:test";
import { assertEquals, assertRejects } from "../assertions.ts";
import { withTestDb } from "../../src/db/testing.ts";
import { createUser } from "../../src/repositories/user-repository.ts";
import {
  createInterest,
  dismissInterest,
  listInterests,
  normalizeInterestLabel,
} from "../../src/services/interest-service.ts";

async function createOwner(database: Parameters<typeof createUser>[0]) {
  return await createUser(database, {
    name: "Interest Owner", email: "interest-service@example.com",
    passwordHash: "$argon2id$fakehash", systemPrompt: "Summarize.", defaultLanguage: "en",
  });
}

test("interest service normalizes equivalent labels and revives dismissed rules", async () => {
  await withTestDb(async (database) => {
    const owner = await createOwner(database);
    assertEquals(normalizeInterestLabel("  ＡI\t News  "), "ai news");
    const first = await createInterest(database, {
      userId: owner.id, label: "ＡI  News", kind: "topic", disposition: "prioritize",
    });
    await dismissInterest(database, first.id, owner.id);
    const revived = await createInterest(database, {
      userId: owner.id, label: " ai news ", kind: "topic", disposition: "show_less",
    });
    assertEquals(revived.id, first.id);
    assertEquals(revived.state, "active");
    assertEquals((await listInterests(database, owner.id)).length, 1);
  });
});

test("interest service rejects inferred client rules", async () => {
  await withTestDb(async (database) => {
    const owner = await createOwner(database);
    await assertRejects(() => createInterest(database, {
      userId: owner.id,
      label: "Politics",
      kind: "topic",
      disposition: "mute",
      origin: "inferred",
    } as never));
  });
});
