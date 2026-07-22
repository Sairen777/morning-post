import { test } from "bun:test";
import { assert, assertEquals, assertExists } from "../assertions.ts";
import { buildApp } from "../../src/server/app.ts";
import { withTestDb } from "../../src/db/testing.ts";
import { findUserByEmail } from "../../src/repositories/user-repository.ts";
import { verifyPassword } from "../../src/auth/password.ts";
import type { Database } from "../../src/db/client.ts";

interface RegisterBody {
  name: string;
  email: string;
  password: string;
}

function registerBody(overrides: Partial<RegisterBody> = {}): RegisterBody {
  return {
    name: "Ada Lovelace",
    email: "ada@example.com",
    password: "analytical-engine-1843",
    ...overrides,
  };
}

async function postRegister(
  database: Database,
  body: unknown,
): Promise<Response> {
  const app = buildApp(database);
  return await app.request("/auth/register", {
    method: "POST",
    headers: { "content-type": "application/json", Origin: "http://127.0.0.1:5173", "x-forwarded-for": crypto.randomUUID() },
    body: JSON.stringify(body),
  });
}

test("POST /auth/register returns 201 with the public user", async () => {
  await withTestDb(async (database) => {
    const body = registerBody();
    const response = await postRegister(database, body);
    assertEquals(response.status, 201);

    const json = await response.json();
    assertExists(json.id);
    assertEquals(json.name, body.name);
    assertEquals(json.email, body.email);
    assertEquals(typeof json.createdAt, "number");
    assertEquals("passwordHash" in json, false);
  });
});

test("POST /auth/register persists an argon2id-hashed user", async () => {
  await withTestDb(async (database) => {
    const body = registerBody({ email: "grace@example.com" });
    const response = await postRegister(database, body);
    assertEquals(response.status, 201);
    await response.body?.cancel();

    const stored = await findUserByEmail(database, body.email);
    assertExists(stored);
    assert(stored.passwordHash.startsWith("$argon2id$"));
    assertEquals(
      await verifyPassword(body.password, stored.passwordHash),
      true,
    );
  });
});

test("POST /auth/register response never leaks the password or hash", async () => {
  await withTestDb(async (database) => {
    const body = registerBody({ email: "secret@example.com" });
    const response = await postRegister(database, body);
    assertEquals(response.status, 201);

    const text = await response.text();
    assert(!text.includes(body.password), "response leaked plaintext password");
    assert(!text.includes("argon2"), "response leaked the password hash");
    assert(!text.includes("passwordHash"), "response leaked the hash field");
  });
});

test("POST /auth/register rejects a duplicate email with 409", async () => {
  await withTestDb(async (database) => {
    const body = registerBody({ email: "dup@example.com" });
    const first = await postRegister(database, body);
    assertEquals(first.status, 201);
    await first.body?.cancel();

    const second = await postRegister(database, registerBody({
      email: "dup@example.com",
      name: "Someone Else",
    }));
    assertEquals(second.status, 409);
    await second.body?.cancel();
  });
});

test("POST /auth/register rejects an invalid email with 422", async () => {
  await withTestDb(async (database) => {
    const response = await postRegister(database, registerBody({ email: "not-an-email" }));
    assertEquals(response.status, 422);
    await response.body?.cancel();
  });
});

test("POST /auth/register rejects a short password with 422", async () => {
  await withTestDb(async (database) => {
    const response = await postRegister(database, registerBody({ password: "short" }));
    assertEquals(response.status, 422);
    await response.body?.cancel();
  });
});

test("POST /auth/register rejects an empty name with 422", async () => {
  await withTestDb(async (database) => {
    const response = await postRegister(database, registerBody({ name: "   " }));
    assertEquals(response.status, 422);
    await response.body?.cancel();
  });
});
