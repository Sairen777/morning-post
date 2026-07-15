import { assert, assertEquals, assertExists, assertRejects } from "@std/assert"
import { withTestDb } from "../../src/db/testing.ts";
import {
  createUser,
  type CreateUserInput,
  findUserByEmail,
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

Deno.test("createUser then findUserById round-trips all fields", async () => {
  await withTestDb(async (database) => {
    const created = await createUser(database, userInput());

    const found = await findUserById(database, created.id);
    assertExists(found);
    assertEquals(found, created);
    assertEquals(found.name, "Ada Lovelace");
    assertEquals(found.email, "ada@example.com");
    assertEquals(found.passwordHash, "$argon2id$fakehash");
    assertEquals(found.systemPrompt, "Summarize tersely.");
    assertEquals(found.defaultLanguage, "en");

    assertEquals(typeof found.createdAt, "number");
    assertEquals(typeof found.updatedAt, "number");
    assert(Number.isInteger(found.createdAt));
    assert(found.createdAt > 1_000_000_000_000); // epoch-ms, well past year 2001
  });
});

Deno.test("createUser stores email lowercased; findUserByEmail is case-insensitive", async () => {
  await withTestDb(async (database) => {
    const created = await createUser(database, userInput({ email: "Foo@X.com" }));
    assertEquals(created.email, "foo@x.com");

    const byUpper = await findUserByEmail(database, "Foo@X.com");
    assertExists(byUpper);
    assertEquals(byUpper.id, created.id);

    const byLower = await findUserByEmail(database, "foo@x.com");
    assertExists(byLower);
    assertEquals(byLower.id, created.id);
  });
});

Deno.test("findUserById / findUserByEmail return null when absent", async () => {
  await withTestDb(async (database) => {
    const byId = await findUserById(database, "00000000-0000-0000-0000-000000000000");
    assertEquals(byId, null);

    const byEmail = await findUserByEmail(database, "nobody@example.com");
    assertEquals(byEmail, null);
  });
});

Deno.test("duplicate email insert throws ConflictError", async () => {
  await withTestDb(async (database) => {
    await createUser(database, userInput({ email: "dup@example.com" }));

    // Different casing must still collide (stored lowercased).
    await assertRejects(
      () => createUser(database, userInput({ email: "DUP@example.com" })),
      ConflictError,
      "email already registered",
    );
  });
});

Deno.test("updateUser of a missing id throws NotFoundError", async () => {
  await withTestDb(async (database) => {
    await assertRejects(
      () =>
        updateUser(database, "00000000-0000-0000-0000-000000000000", {
          name: "Ghost",
        }),
      NotFoundError,
    );
  });
});

Deno.test("partial update leaves other fields intact and bumps updatedAt", async () => {
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

Deno.test("systemPrompt accepts empty string and a multi-KB value", async () => {
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
