import { test } from "bun:test";
import {
  assert,
  assertEquals,
  assertExists,
  assertRejects,
} from "../assertions.ts";
import type { SQL } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";
import { verifyPassword } from "../../src/auth/password.ts";
import type { Database } from "../../src/db/client.ts";
import { withTestDb } from "../../src/db/testing.ts";
import { findOwner } from "../../src/repositories/user-repository.ts";
import { buildApp } from "../../src/server/app.ts";
import { ConflictError } from "../../src/server/errors.ts";
import {
  OWNER_EMAIL,
  setupOwner,
} from "../../src/services/owner-setup-service.ts";

const PASSWORD = "analytical-engine-1843";

interface SetupBody {
  name: string;
  password: string;
}

function setupBody(overrides: Partial<SetupBody> = {}): SetupBody {
  return {
    name: "Ada Lovelace",
    password: PASSWORD,
    ...overrides,
  };
}

function jsonRequest(body: unknown): RequestInit {
  return {
    method: "POST",
    headers: {
      "content-type": "application/json",
      Origin: "http://127.0.0.1:5173",
      "x-forwarded-for": crypto.randomUUID(),
    },
    body: JSON.stringify(body),
  };
}

async function postSetup(database: Database, body: unknown): Promise<Response> {
  return await buildApp(database).request("/auth/setup", jsonRequest(body));
}

async function postLogin(database: Database, body: unknown): Promise<Response> {
  return await buildApp(database).request("/auth/login", jsonRequest(body));
}

test("GET /auth/setup reports setup state before and after owner creation", async () => {
  await withTestDb(async (database) => {
    const app = buildApp(database);
    const before = await app.request("/auth/setup");
    assertEquals(before.status, 200);
    assertEquals(await before.json(), { setupRequired: true });

    const setup = await app.request("/auth/setup", jsonRequest(setupBody()));
    assertEquals(setup.status, 201);
    await setup.body?.cancel();

    const after = await app.request("/auth/setup");
    assertEquals(after.status, 200);
    assertEquals(await after.json(), { setupRequired: false });
  });
});

test("POST /auth/setup creates the reserved owner with an Argon2id password hash", async () => {
  await withTestDb(async (database) => {
    const response = await postSetup(database, setupBody({ name: "  Ada Lovelace  " }));
    assertEquals(response.status, 201);
    const json = await response.json();
    assertExists(json.id);
    assertEquals(json.name, "Ada Lovelace");

    const owner = await findOwner(database);
    assertExists(owner);
    assertEquals(owner.id, json.id);
    assertEquals(owner.email, OWNER_EMAIL);
    assert(owner.passwordHash.startsWith("$argon2id$"));
    assertEquals(await verifyPassword(PASSWORD, owner.passwordHash), true);
  });
});

test("setup response is authenticated and no public auth response exposes email or password data", async () => {
  await withTestDb(async (database) => {
    const app = buildApp(database);
    const setup = await app.request("/auth/setup", jsonRequest(setupBody()));
    assertEquals(setup.status, 201);
    const setupJson = await setup.json();
    assertEquals("email" in setupJson, false);
    assertEquals("passwordHash" in setupJson, false);

    const setCookie = setup.headers.get("set-cookie");
    assertExists(setCookie);
    const cookie = setCookie.split(";", 1)[0];
    assertExists(cookie);

    const me = await app.request("/auth/me", {
      headers: { Cookie: cookie },
    });
    assertEquals(me.status, 200);
    const meJson = await me.json();
    assertEquals(meJson.id, setupJson.id);
    assertEquals("email" in meJson, false);
    assertEquals("passwordHash" in meJson, false);

    const login = await app.request("/auth/login", jsonRequest({ password: PASSWORD }));
    assertEquals(login.status, 200);
    assertExists(login.headers.get("set-cookie"));
    const loginJson = await login.json();
    assertEquals(loginJson.id, setupJson.id);
    assertEquals("email" in loginJson, false);
    assertEquals("passwordHash" in loginJson, false);
  });
});

test("POST /auth/login accepts only a password and uses the fixed failure message", async () => {
  await withTestDb(async (database) => {
    const setup = await postSetup(database, setupBody());
    assertEquals(setup.status, 201);
    await setup.body?.cancel();

    const success = await postLogin(database, { password: PASSWORD });
    assertEquals(success.status, 200);
    await success.body?.cancel();

    const wrong = await postLogin(database, { password: "wrong-password" });
    assertEquals(wrong.status, 401);
    assertEquals((await wrong.json()).error.message, "invalid password");

    const legacyEmailBody = await postLogin(database, {
      email: "ada@example.com",
      password: PASSWORD,
    });
    assertEquals(legacyEmailBody.status, 422);
    await legacyEmailBody.body?.cancel();
  });
});

test("POST /auth/setup validates name and password without accepting email", async () => {
  await withTestDb(async (database) => {
    const emptyName = await postSetup(database, setupBody({ name: "   " }));
    assertEquals(emptyName.status, 422);
    await emptyName.body?.cancel();

    const shortPassword = await postSetup(database, setupBody({ password: "short" }));
    assertEquals(shortPassword.status, 422);
    await shortPassword.body?.cancel();

    const legacyEmailBody = await postSetup(database, {
      ...setupBody(),
      email: "ada@example.com",
    });
    assertEquals(legacyEmailBody.status, 422);
    await legacyEmailBody.body?.cancel();
  });
});

test("POST /auth/setup returns 409 once an owner exists", async () => {
  await withTestDb(async (database) => {
    const first = await postSetup(database, setupBody());
    assertEquals(first.status, 201);
    await first.body?.cancel();

    const second = await postSetup(database, setupBody({
      name: "Grace Hopper",
      password: "compiler-pioneer-1906",
    }));
    assertEquals(second.status, 409);
    await second.body?.cancel();
  });
});

test("setup locks the users table and rechecks ownership before insert", async () => {
  const events: string[] = [];
  const existingOwner = {
    id: "00000000-0000-0000-0000-000000000001",
    name: "Existing Owner",
    email: "existing@example.com",
    passwordHash: "$argon2id$fixture",
    systemPrompt: "Summarize tersely.",
    summaryPrompt: "",
    defaultLanguage: null,
    defaultRelevanceFilterMode: "personalized",
    relevanceThreshold: 60,
    maximumStoriesPerDigest: null,
    interestProfileVersion: 1,
    createdAt: 1,
    updatedAt: 1,
  };
  const transaction = {
    execute: async (query: SQL) => {
      const compiled = new PgDialect().sqlToQuery(query);
      assertEquals(
        compiled.sql,
        'lock table "users" in share row exclusive mode',
      );
      events.push("table-lock");
    },
    select: () => ({
      from: () => ({
        orderBy: () => ({
          limit: async () => {
            events.push("locked-recheck");
            return [existingOwner];
          },
        }),
      }),
    }),
  };
  const database = {
    select: () => ({
      from: () => ({
        orderBy: () => ({
          limit: async () => {
            events.push("initial-check");
            return [];
          },
        }),
      }),
    }),
    transaction: async (
      callback: (tx: Database) => Promise<unknown>,
    ) => await callback(transaction as unknown as Database),
  } as unknown as Database;

  await assertRejects(
    () => setupOwner(database, setupBody()),
    ConflictError,
    "owner already exists",
  );
  assertEquals(events, ["initial-check", "table-lock", "locked-recheck"]);
});

test("POST /auth/register no longer exists", async () => {
  await withTestDb(async (database) => {
    const app = buildApp(database);
    const setup = await app.request("/auth/setup", jsonRequest(setupBody()));
    assertEquals(setup.status, 201);
    const setCookie = setup.headers.get("set-cookie");
    assertExists(setCookie);
    const cookie = setCookie.split(";", 1)[0];
    assertExists(cookie);
    await setup.body?.cancel();

    const response = await app.request("/auth/register", {
      ...jsonRequest({
        name: "Ada Lovelace",
        email: "ada@example.com",
        password: PASSWORD,
      }),
      headers: {
        "content-type": "application/json",
        Origin: "http://127.0.0.1:5173",
        Cookie: cookie,
      },
    });
    assertEquals(response.status, 404);
    await response.body?.cancel();
  });
});
