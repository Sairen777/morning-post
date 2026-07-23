import { test } from "bun:test";
import { eq } from "drizzle-orm";
import { assertEquals, assertRejects } from "../assertions.ts";
import { withTestDb } from "../../src/db/testing.ts";
import { users } from "../../src/db/schema/user.ts";
import { createUser } from "../../src/repositories/user-repository.ts";
import {
  dismissOwnedInterestRule,
  listActiveInterestRules,
  saveExplicitInterestRule,
  updateOwnedInterestRule,
} from "../../src/repositories/interest-rule-repository.ts";
import { NotFoundError } from "../../src/server/errors.ts";

async function user(database: Parameters<typeof createUser>[0], email: string) {
  return await createUser(database, {
    name: "Interest Owner", email, passwordHash: "$argon2id$fakehash",
    systemPrompt: "Summarize.", defaultLanguage: "en",
  });
}

test("interest repository upserts, filters expiry, dismisses, and increments profile version", async () => {
  await withTestDb(async (database) => {
    const owner = await user(database, "interest-repository@example.com");
    const initialVersion = owner.interestProfileVersion;
    const first = await saveExplicitInterestRule(database, {
      userId: owner.id, label: "Machine Learning", normalizedLabel: "machine learning",
      kind: "topic", disposition: "prioritize", strength: 80,
    });
    const revived = await saveExplicitInterestRule(database, {
      userId: owner.id, label: " machine  learning ", normalizedLabel: "machine learning",
      kind: "topic", disposition: "show_less", strength: 25, expiresAt: Date.now() - 1,
    });
    assertEquals(revived.id, first.id);
    assertEquals(await listActiveInterestRules(database, owner.id), []);

    await updateOwnedInterestRule(database, first.id, owner.id, { expiresAt: null });
    assertEquals((await listActiveInterestRules(database, owner.id)).length, 1);
    const dismissed = await dismissOwnedInterestRule(database, first.id, owner.id);
    assertEquals(dismissed.state, "dismissed");
    assertEquals(await listActiveInterestRules(database, owner.id), []);

    const rows = await database.select({ version: users.interestProfileVersion }).from(users)
      .where(eq(users.id, owner.id));
    assertEquals(rows[0]?.version, initialVersion + 4);
  });
});

test("interest repository mutations are user scoped", async () => {
  await withTestDb(async (database) => {
    const owner = await user(database, "interest-owner@example.com");
    const stranger = await user(database, "interest-stranger@example.com");
    const rule = await saveExplicitInterestRule(database, {
      userId: owner.id, label: "Databases", normalizedLabel: "databases",
      kind: "topic", disposition: "prioritize", strength: 100,
    });
    await assertRejects(
      () => updateOwnedInterestRule(database, rule.id, stranger.id, { strength: 1 }),
      NotFoundError,
    );
    await assertRejects(
      () => dismissOwnedInterestRule(database, rule.id, stranger.id),
      NotFoundError,
    );
  });
});
