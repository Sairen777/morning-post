import { test } from "bun:test";
import { assertEquals, assertExists } from "../assertions.ts";
import type { Hono } from "hono";
import type { ServerEnvironment } from "../../src/server/app.ts";
import { buildApp } from "../../src/server/app.ts";
import { withTestDb } from "../../src/db/testing.ts";
import type { Database } from "../../src/db/client.ts";
import { createUser } from "../../src/repositories/user-repository.ts";
import { createSession } from "../../src/auth/session-service.ts";

const ORIGIN = "http://127.0.0.1:5173";
const PASSWORD = "analytical-engine-1843";

function request(method: string, body?: unknown, cookie?: string): RequestInit {
  return {
    method,
    headers: {
      "content-type": "application/json",
      Origin: ORIGIN,
      ...(cookie ? { cookie } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  };
}

async function ownerSession(app: Hono<ServerEnvironment>): Promise<string> {
  const setup = await app.request("/auth/setup", request("POST", {
    name: "Ada Lovelace", password: PASSWORD,
  }));
  assertEquals(setup.status, 201);
  const loginResp = await app.request("/auth/login", request("POST", { password: PASSWORD }));
  assertEquals(loginResp.status, 200);
  const setCookie = loginResp.headers.get("set-cookie");
  assertExists(setCookie);
  return setCookie.split(";")[0];
}

async function strangerSession(database: Database, sessionEmail: string): Promise<string> {
  const stranger = await createUser(database, {
    name: "Stranger",
    email: sessionEmail,
    passwordHash: "$argon2id$fakehash",
    systemPrompt: "Summarize tersely.",
  });
  const { token } = await createSession(database, stranger.id);
  return `__Host-session=${token}`;
}

test("interest routes require authentication and preserve ownership", async () => {
  await withTestDb(async (database) => {
    const app = buildApp(database);
    assertEquals((await app.request("/interests")).status, 401);
    const ownerCookie = await ownerSession(app);
    const strangerCookie = await strangerSession(database, "interest-route-stranger@example.com");
    const created = await app.request("/interests", request("POST", {
      label: "Climate", kind: "topic", disposition: "prioritize", strength: 75,
    }, ownerCookie));
    assertEquals(created.status, 201);
    const rule = await created.json();
    assertEquals((await app.request(`/interests/${rule.id}`, request("PATCH", { strength: 5 }, strangerCookie))).status, 404);
    assertEquals((await app.request(`/interests/${rule.id}`, request("DELETE", undefined, strangerCookie))).status, 404);
  });
});

test("interest routes upsert normalized labels, omit expired rules, and dismiss", async () => {
  await withTestDb(async (database) => {
    const app = buildApp(database);
    const cookie = await ownerSession(app);
    const first = await app.request("/interests", request("POST", {
      label: "AI  News", kind: "phrase", disposition: "prioritize",
    }, cookie));
    const firstRule = await first.json();
    const duplicate = await app.request("/interests", request("POST", {
      label: " ai news ", kind: "phrase", disposition: "show_less",
    }, cookie));
    assertEquals((await duplicate.json()).id, firstRule.id);
    assertEquals((await (await app.request("/interests", { headers: { cookie } })).json()).length, 1);

    assertEquals((await app.request(`/interests/${firstRule.id}`, request("DELETE", undefined, cookie))).status, 200);
    assertEquals((await (await app.request("/interests", { headers: { cookie } })).json()).length, 0);
  });
});

test("PATCH /interests/:id reports normalized label collisions as conflict", async () => {
  await withTestDb(async (database) => {
    const app = buildApp(database);
    const cookie = await ownerSession(app);
    await app.request("/interests", request("POST", {
      label: "Databases",
      kind: "topic",
      disposition: "prioritize",
    }, cookie));
    const secondResponse = await app.request("/interests", request("POST", {
      label: "Compilers",
      kind: "topic",
      disposition: "show_less",
    }, cookie));
    const second = await secondResponse.json();
    const collision = await app.request(
      `/interests/${second.id}`,
      request("PATCH", { label: " databases " }, cookie),
    );
    assertEquals(collision.status, 409);
    assertEquals((await collision.json()).error.code, "CONFLICT");
  });
});
