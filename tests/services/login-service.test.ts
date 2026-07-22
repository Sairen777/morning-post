import { test } from "bun:test";
import { assertEquals } from "../assertions.ts"
import { withTestDb } from "../../src/db/testing.ts";
import { hashPassword } from "../../src/auth/password.ts";
import { createUser, updateUser } from "../../src/repositories/user-repository.ts";
import { authenticateUser } from "../../src/services/login-service.ts";
import type { Database } from "../../src/db/client.ts";
import { DUMMY_PASSWORD_HASH } from "../../src/services/login-service.ts";

const PASSWORD = "analytical-engine-1843";

async function createStoredUser(database: Database, email: string) {
  return await createUser(database, {
    name: "Ada Lovelace",
    email,
    passwordHash: await hashPassword(PASSWORD),
    systemPrompt: "Summarize tersely.",
  });
}

test("authenticateUser returns the user for the correct email and password", async () => {
  await withTestDb(async (database) => {
    const createdUser = await createStoredUser(database, "ada@example.com");

    const authenticatedUser = await authenticateUser(database, {
      email: "ada@example.com",
      password: PASSWORD,
    });

    assertEquals(authenticatedUser, createdUser);
  });
});

test("authenticateUser returns null for a correct email and wrong password", async () => {
  await withTestDb(async (database) => {
    await createStoredUser(database, "ada@example.com");

    const authenticatedUser = await authenticateUser(database, {
      email: "ada@example.com",
      password: "wrong-password",
    });

    assertEquals(authenticatedUser, null);
  });
});

test("authenticateUser returns null for a missing email", async () => {
  await withTestDb(async (database) => {
    const authenticatedUser = await authenticateUser(database, {
      email: "missing@example.com",
      password: PASSWORD,
    });

    assertEquals(authenticatedUser, null);
  });
});

test("authenticateUser returns null when the stored password hash is invalid", async () => {
  await withTestDb(async (database) => {
    const createdUser = await createStoredUser(database, "ada@example.com");
    await updateUser(database, createdUser.id, {
      passwordHash: "not-a-valid-argon2-hash",
    });

    const authenticatedUser = await authenticateUser(database, {
      email: "ada@example.com",
      password: PASSWORD,
    });

    assertEquals(authenticatedUser, null);
  });
});

test("DUMMY_PASSWORD_HASH is a precomputed Argon2id string", () => {
  assertEquals(DUMMY_PASSWORD_HASH.startsWith("$argon2id$"), true);
});
