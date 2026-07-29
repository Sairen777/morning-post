import { test } from "bun:test";
import { assert, assertEquals, assertExists, assertThrows } from "../assertions.ts"
import { eq } from "drizzle-orm";
import { withTestDb } from "../../src/db/testing.ts";
import { users } from "../../src/db/schema/user.ts";
import {
  createUser,
  type CreateUserInput,
  findOwner,
  findUserById,
  updateUser,
} from "../../src/repositories/user-repository.ts";
import { ConflictError, NotFoundError } from "../../src/server/errors.ts";

function delay(milliseconds: number): Promise<void> {
  const { promise, resolve } = Promise.withResolvers<void>();
  setTimeout(resolve, milliseconds);
  return promise;
}

function userInput(overrides: Partial<CreateUserInput> = {}): CreateUserInput {
  return {
    name: "Ada Lovelace",
    email: "ada@example.com",
    passwordHash: "$argon2id$fakehash",
    systemPrompt: "Summarize tersely.",
    defaultLanguage: "en",
    ...overrides,
  };
}

test("createUser then findUserById round-trips all fields", async () => {
  await withTestDb(async (database) => {
    const created = await createUser(database, userInput());

    const found = await findUserById(database, created.id);
    assertExists(found);
    assertEquals(found, created);
    assertEquals(found.name, "Ada Lovelace");
    assertEquals(found.email, "ada@example.com");
    assertEquals(found.passwordHash, "$argon2id$fakehash");
    assertEquals(found.systemPrompt, "Summarize tersely.");
    assertEquals(found.summaryPrompt, "");
    assertEquals(found.defaultLanguage, "en");
    assertEquals(found.storyDetailLevel, "balanced");

    assertEquals(typeof found.createdAt, "number");
    assertEquals(typeof found.updatedAt, "number");
    assert(Number.isInteger(found.createdAt));
    assert(found.createdAt > 1_000_000_000_000); // epoch-ms, well past year 2001
  });
});

test("createUser round-trips a null password hash", async () => {
  await withTestDb(async (database) => {
    const created = await createUser(database, userInput({
      email: "passwordless@example.com",
      passwordHash: null,
    }));
    assertEquals(created.passwordHash, null);

    const found = await findUserById(database, created.id);
    assertExists(found);
    assertEquals(found.passwordHash, null);
  });
});

test("createUser retains and normalizes internal fixture email", async () => {
  await withTestDb(async (database) => {
    const created = await createUser(database, userInput({ email: "Foo@X.com" }));
    assertEquals(created.email, "foo@x.com");

    const owner = await findOwner(database);
    assertExists(owner);
    assertEquals(owner.id, created.id);
    assertEquals(owner.email, "foo@x.com");
  });
});

test("findUserById and findOwner return null when absent", async () => {
  await withTestDb(async (database) => {
    const byId = await findUserById(database, "00000000-0000-0000-0000-000000000000");
    assertEquals(byId, null);
    assertEquals(await findOwner(database), null);
  });
});

test("findOwner orders users by createdAt and then id", async () => {
  await withTestDb(async (database) => {
    const first = await createUser(database, userInput({ email: "first@example.com" }));
    const second = await createUser(database, userInput({ email: "second@example.com" }));

    await database
      .update(users)
      .set({ createdAt: 2 })
      .where(eq(users.id, first.id));
    await database
      .update(users)
      .set({ createdAt: 1 })
      .where(eq(users.id, second.id));
    assertEquals((await findOwner(database))?.id, second.id);

    await database
      .update(users)
      .set({ createdAt: 1 })
      .where(eq(users.id, first.id));
    const expectedTieWinner = first.id < second.id ? first.id : second.id;
    assertEquals((await findOwner(database))?.id, expectedTieWinner);
  });
});

test("duplicate email insert throws ConflictError", async () => {
  await withTestDb(async (database) => {
    await createUser(database, userInput({ email: "dup@example.com" }));

    // Different casing must still collide (stored lowercased).
    assertThrows(() => createUser(database, userInput({ email: "DUP@example.com" })), ConflictError,
    "email already registered",);
  });
});

test("updateUser of a missing id throws NotFoundError", async () => {
  await withTestDb(async (database) => {
    assertThrows(() => updateUser(database, "00000000-0000-0000-0000-000000000000", {
      name: "Ghost",
    }), NotFoundError,);
  });
});

test("partial update leaves other fields intact and bumps updatedAt", async () => {
  await withTestDb(async (database) => {
    const created = await createUser(database, userInput());

    await delay(5);
    const updated = await updateUser(database, created.id, {
      defaultLanguage: "fr",
    });

    // Only the targeted field changed.
    assertEquals(updated.defaultLanguage, "fr");
    assertEquals(updated.name, created.name);
    assertEquals(updated.email, created.email);
    assertEquals(updated.passwordHash, created.passwordHash);
    assertEquals(updated.systemPrompt, created.systemPrompt);

    // updatedAt advanced; createdAt untouched.
    assertEquals(updated.createdAt, created.createdAt);
    assert(
      updated.updatedAt > created.updatedAt,
      `expected updatedAt to increase (${created.updatedAt} -> ${updated.updatedAt})`,
    );
  });
});

test("story detail level persists through create and update", async () => {
  await withTestDb(async (database) => {
    const created = await createUser(database, userInput({
      email: "detail@example.com",
      storyDetailLevel: "thorough",
    }));
    assertEquals(created.storyDetailLevel, "thorough");

    const updated = await updateUser(database, created.id, {
      storyDetailLevel: "headlines",
    });
    assertEquals(updated.storyDetailLevel, "headlines");

    const reloaded = await findUserById(database, created.id);
    assertExists(reloaded);
    assertEquals(reloaded.storyDetailLevel, "headlines");
  });
});

test("systemPrompt accepts empty string and a multi-KB value", async () => {
  await withTestDb(async (database) => {
    const empty = await createUser(
      database,
      userInput({ email: "empty@example.com", systemPrompt: "" }),
    );
    assertEquals(empty.systemPrompt, "");

    const large = "x".repeat(8192);
    const big = await createUser(
      database,
      userInput({ email: "big@example.com", systemPrompt: large }),
    );
    assertEquals(big.systemPrompt.length, 8192);

    const reloaded = await findUserById(database, big.id);
    assertExists(reloaded);
    assertEquals(reloaded.systemPrompt, large);
  });
});
