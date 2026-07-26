import { test } from "bun:test";
import { assertEquals, assertExists } from "../assertions.ts";
import { eq } from "drizzle-orm";
import { hashPassword } from "../../src/auth/password.ts";
import type { Database } from "../../src/db/client.ts";
import { withTestDb } from "../../src/db/testing.ts";
import { users } from "../../src/db/schema/user.ts";
import {
  createUser,
  findOwner,
} from "../../src/repositories/user-repository.ts";
import {
  authenticateOwner,
  DUMMY_PASSWORD_HASH,
} from "../../src/services/login-service.ts";

const PASSWORD = "analytical-engine-1843";

async function createStoredUser(
  database: Database,
  email: string,
  password = PASSWORD,
) {
  return await createUser(database, {
    name: "Ada Lovelace",
    email,
    passwordHash: await hashPassword(password),
    systemPrompt: "Summarize tersely.",
  });
}

test("authenticateOwner returns the owner for the correct password", async () => {
  await withTestDb(async (database) => {
    const createdOwner = await createStoredUser(database, "owner@example.com");

    const authenticatedUser = await authenticateOwner(database, {
      password: PASSWORD,
    });

    assertEquals(authenticatedUser, createdOwner);
  });
});

test("authenticateOwner returns null for the owner's wrong password", async () => {
  await withTestDb(async (database) => {
    await createStoredUser(database, "owner@example.com");

    const authenticatedUser = await authenticateOwner(database, {
      password: "wrong-password",
    });

    assertEquals(authenticatedUser, null);
  });
});

test("authenticateOwner returns null when no owner exists", async () => {
  await withTestDb(async (database) => {
    const authenticatedUser = await authenticateOwner(database, {
      password: PASSWORD,
    });

    assertEquals(authenticatedUser, null);
  });
});

test("authenticateOwner never authenticates a non-owner row", async () => {
  await withTestDb(async (database) => {
    const first = await createStoredUser(
      database,
      "first@example.com",
      "first-owner-password",
    );
    const second = await createStoredUser(
      database,
      "second@example.com",
      "second-user-password",
    );
    const owner = await findOwner(database);
    assertExists(owner);

    const ownerPassword = owner.id === first.id
      ? "first-owner-password"
      : "second-user-password";
    const nonOwnerPassword = owner.id === first.id
      ? "second-user-password"
      : "first-owner-password";

    assertEquals(
      await authenticateOwner(database, { password: ownerPassword }),
      owner,
    );
    assertEquals(
      await authenticateOwner(database, { password: nonOwnerPassword }),
      null,
    );
    assertEquals(owner.id === first.id || owner.id === second.id, true);
  });
});

test("authenticateOwner returns null when the owner's password hash is invalid", async () => {
  await withTestDb(async (database) => {
    const createdOwner = await createStoredUser(database, "owner@example.com");
    await database
      .update(users)
      .set({ passwordHash: "not-a-valid-argon2-hash" })
      .where(eq(users.id, createdOwner.id));

    const authenticatedUser = await authenticateOwner(database, {
      password: PASSWORD,
    });

    assertEquals(authenticatedUser, null);
  });
});

test("DUMMY_PASSWORD_HASH is a precomputed Argon2id string", () => {
  assertEquals(DUMMY_PASSWORD_HASH.startsWith("$argon2id$"), true);
});
