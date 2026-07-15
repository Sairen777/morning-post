import { assert, assertEquals } from "@std/assert"
import { buildApp } from "../../src/server/app.ts";
import { withTestDb } from "../../src/db/testing.ts";
import type { Database } from "../../src/db/client.ts";
import type { Hono } from "@hono/hono";

const PASSWORD = "analytical-engine-1843";

interface RegisteredUser {
  id: string;
  email: string;
  systemPrompt: string;
}

function jsonRequest(method: "POST" | "PATCH", body: unknown): RequestInit {
  return {
    method,
    headers: { "content-type": "application/json", Origin: "http://127.0.0.1:5173" },
    body: JSON.stringify(body),
  };
}

function extractCookie(response: Response): string {
  const header = response.headers.get("set-cookie");
  assert(header, "login did not set a session cookie");
  return header.split(";")[0];
}

async function register(app: Hono, email: string): Promise<RegisteredUser> {
  const response = await app.request(
    "/auth/register",
    jsonRequest("POST", { name: "Ada Lovelace", email, password: PASSWORD }),
  );
  assertEquals(response.status, 201);
  const json = await response.json();
  return { id: json.id, email: json.email, systemPrompt: json.systemPrompt };
}

async function login(app: Hono, email: string): Promise<string> {
  const response = await app.request(
    "/auth/login",
    jsonRequest("POST", { email, password: PASSWORD }),
  );
  assertEquals(response.status, 200);
  return extractCookie(response);
}

async function authenticatedApp(
  database: Database,
  email: string,
): Promise<{ app: Hono; cookie: string; user: RegisteredUser }> {
  const app = buildApp(database);
  const user = await register(app, email);
  const cookie = await login(app, email);
  return { app, cookie, user };
}

async function patchProfile(
  app: Hono,
  cookie: string,
  body: unknown,
): Promise<Response> {
  return await app.request("/auth/me", {
    ...jsonRequest("PATCH", body),
    headers: { "content-type": "application/json", cookie, Origin: "http://127.0.0.1:5173" },
  });
}

Deno.test("PATCH /auth/me updates systemPrompt and GET /auth/me reflects it", async () => {
  await withTestDb(async (database: Database) => {
    const { app, cookie, user } = await authenticatedApp(database, "profile-happy@example.com");
    const systemPrompt = "Prefer terse summaries with risks first.";

    const patchResponse = await patchProfile(app, cookie, { systemPrompt });
    assertEquals(patchResponse.status, 200);
    const patchJson = await patchResponse.json();
    assertEquals(patchJson.id, user.id);
    assertEquals(patchJson.systemPrompt, systemPrompt);
    assertEquals("passwordHash" in patchJson, false);

    const getResponse = await app.request("/auth/me", { headers: { cookie } });
    assertEquals(getResponse.status, 200);
    const getJson = await getResponse.json();
    assertEquals(getJson.systemPrompt, systemPrompt);
  });
});

Deno.test("partial profile patch leaves unspecified fields intact", async () => {
  await withTestDb(async (database: Database) => {
    const { app, cookie, user } = await authenticatedApp(database, "profile-partial@example.com");

    const response = await patchProfile(app, cookie, { defaultLanguage: " fr " });
    assertEquals(response.status, 200);
    const json = await response.json();
    assertEquals(json.defaultLanguage, "fr");
    assertEquals(json.systemPrompt, user.systemPrompt);
    assertEquals(json.email, user.email);
    assertEquals(json.name, "Ada Lovelace");
  });
});

Deno.test("unauthenticated PATCH /auth/me is rejected", async () => {
  await withTestDb(async (database: Database) => {
    const app = buildApp(database);

    const response = await app.request("/auth/me", jsonRequest("PATCH", {
      systemPrompt: "No cookie.",
    }));
    assertEquals(response.status, 401);
    await response.body?.cancel();
  });
});

Deno.test("PATCH /auth/me rejects email and passwordHash mutation attempts", async () => {
  await withTestDb(async (database: Database) => {
    const { app, cookie } = await authenticatedApp(database, "profile-sensitive@example.com");

    const emailResponse = await patchProfile(app, cookie, { email: "other@example.com" });
    assertEquals(emailResponse.status, 422);
    await emailResponse.body?.cancel();

    const passwordHashResponse = await patchProfile(app, cookie, { passwordHash: "$argon2id$fake" });
    assertEquals(passwordHashResponse.status, 422);
    await passwordHashResponse.body?.cancel();
  });
});

Deno.test("PATCH /auth/me rejects oversized systemPrompt", async () => {
  await withTestDb(async (database: Database) => {
    const { app, cookie } = await authenticatedApp(database, "profile-oversized@example.com");
    const oversizedPrompt = "x".repeat(8 * 1024 + 1);

    const response = await patchProfile(app, cookie, { systemPrompt: oversizedPrompt });
    assertEquals(response.status, 422);
    await response.body?.cancel();
  });
});

Deno.test("PATCH /auth/me allows an empty systemPrompt and round-trips it", async () => {
  await withTestDb(async (database: Database) => {
    const { app, cookie } = await authenticatedApp(database, "profile-empty@example.com");

    const patchResponse = await patchProfile(app, cookie, { systemPrompt: "" });
    assertEquals(patchResponse.status, 200);
    const patchJson = await patchResponse.json();
    assertEquals(patchJson.systemPrompt, "");

    const getResponse = await app.request("/auth/me", { headers: { cookie } });
    assertEquals(getResponse.status, 200);
    const getJson = await getResponse.json();
    assertEquals(getJson.systemPrompt, "");
  });
});

Deno.test("PATCH /auth/me trims name, language, and model; blank trimmed name is rejected", async () => {
  await withTestDb(async (database: Database) => {
    const { app, cookie } = await authenticatedApp(database, "profile-trim@example.com");

    const trimResponse = await patchProfile(app, cookie, {
      name: "  Ada Byron  ",
      defaultLanguage: " en-US ",
      defaultModel: " gpt-4.1-mini ",
    });
    assertEquals(trimResponse.status, 200);
    const trimJson = await trimResponse.json();
    assertEquals(trimJson.name, "Ada Byron");
    assertEquals(trimJson.defaultLanguage, "en-US");
    assertEquals(trimJson.defaultModel, "gpt-4.1-mini");

    const blankNameResponse = await patchProfile(app, cookie, { name: "   " });
    assertEquals(blankNameResponse.status, 422);
    await blankNameResponse.body?.cancel();
  });
});
