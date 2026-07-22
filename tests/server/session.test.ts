import { test } from "bun:test";
import { assert, assertEquals } from "../assertions.ts";
import { eq } from "drizzle-orm";
import { buildApp } from "../../src/server/app.ts";
import type { ServerEnvironment } from "../../src/server/app.ts";
import { withTestDb } from "../../src/db/testing.ts";
import { sessions } from "../../src/db/schema/session.ts";
import { createSession, validateSessionToken } from "../../src/auth/session-service.ts";
import type { Database } from "../../src/db/client.ts";
import type { Hono } from "hono";

const PASSWORD = "analytical-engine-1843";

async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(value),
  );
  return Buffer.from(digest).toString("hex");
}

function jsonBody(body: unknown): RequestInit {
  return {
    method: "POST",
    headers: { "content-type": "application/json", Origin: "http://127.0.0.1:5173", "x-forwarded-for": crypto.randomUUID() },
    body: JSON.stringify(body),
  };
}

// Returns the bare `name=value` cookie pair to replay, or null if none was set.
function extractCookie(response: Response): string | null {
  const header = response.headers.get("set-cookie");
  if (!header) {
    return null;
  }
  return header.split(";")[0];
}

interface RegisteredUser {
  id: string;
  email: string;
}

async function register(
  app: Hono<ServerEnvironment>,
  email: string,
): Promise<RegisteredUser> {
  const response = await app.request(
    "/auth/register",
    jsonBody({ name: "Ada Lovelace", email, password: PASSWORD }),
  );
  assertEquals(response.status, 201);
  const json = await response.json();
  return { id: json.id, email };
}

async function login(app: Hono<ServerEnvironment>, email: string, password: string): Promise<Response> {
  return await app.request("/auth/login", jsonBody({ email, password }));
}

test("login sets a session cookie and /auth/me returns the user", async () => {
  await withTestDb(async (database: Database) => {
    const app = buildApp(database);
    const user = await register(app, "happy@example.com");

    const loginResponse = await login(app, user.email, PASSWORD);
    assertEquals(loginResponse.status, 200);
    const loginJson = await loginResponse.json();
    assertEquals(loginJson.id, user.id);

    const cookie = extractCookie(loginResponse);
    assert(cookie, "login did not set a session cookie");
    assert(cookie.startsWith("__Host-session="), "cookie name is not '__Host-session'");

    const setCookie = loginResponse.headers.get("set-cookie") ?? "";
    assert(setCookie.toLowerCase().includes("httponly"), "cookie is not HttpOnly");
    assert(setCookie.toLowerCase().includes("secure"), "cookie is not Secure");
    assert(setCookie.toLowerCase().includes("samesite=lax"), "cookie is not SameSite=Lax");
    assert(setCookie.toLowerCase().includes("path=/"), "cookie is not scoped to /");

    const meResponse = await app.request("/auth/me", {
      headers: { cookie },
    });
    assertEquals(meResponse.status, 200);
    const meJson = await meResponse.json();
    assertEquals(meJson.id, user.id);
    assertEquals(meJson.email, user.email);
    assertEquals("passwordHash" in meJson, false);
  });
});

test("logout revokes the session — the same cookie is then rejected", async () => {
  await withTestDb(async (database: Database) => {
    const app = buildApp(database);
    const user = await register(app, "logout@example.com");
    const loginResponse = await login(app, user.email, PASSWORD);
    const cookie = extractCookie(loginResponse)!;

    const logoutResponse = await app.request("/auth/logout", {
      method: "POST",
      headers: { cookie, Origin: "http://127.0.0.1:5173" },
    });
    assertEquals(logoutResponse.status, 204);

    const meResponse = await app.request("/auth/me", { headers: { cookie, Origin: "http://127.0.0.1:5173" } });
    assertEquals(meResponse.status, 401);
    await meResponse.body?.cancel();
  });
});

test("wrong password and unknown email return an identical 401", async () => {
  await withTestDb(async (database: Database) => {
    const app = buildApp(database);
    await register(app, "real@example.com");

    const wrongPassword = await login(app, "real@example.com", "not-the-password");
    const unknownEmail = await login(app, "ghost@example.com", PASSWORD);

    assertEquals(wrongPassword.status, 401);
    assertEquals(unknownEmail.status, 401);

    const wrongBody = await wrongPassword.text();
    const unknownBody = await unknownEmail.text();
    assertEquals(wrongBody, unknownBody);

    // Neither sets a session cookie.
    assertEquals(extractCookie(wrongPassword), null);
    assertEquals(extractCookie(unknownEmail), null);
  });
});

test("an expired session is rejected with 401", async () => {
  await withTestDb(async (database: Database) => {
    const app = buildApp(database);
    const user = await register(app, "expired@example.com");

    // Mint a session that expired one second ago.
    const { token } = await createSession(database, user.id, -1000);
    const cookie = `__Host-session=${token}`;

    const meResponse = await app.request("/auth/me", { headers: { cookie, Origin: "http://127.0.0.1:5173" } });
    assertEquals(meResponse.status, 401);
    await meResponse.body?.cancel();
  });
});

test("active use refreshes idle expiry without rotating the bearer token", async () => {
  await withTestDb(async (database: Database) => {
    const app = buildApp(database);
    const user = await register(app, "refresh@example.com");
    const created = await createSession(database, user.id, 2 * 24 * 60 * 60 * 1000);
    const now = created.expiresAt - 1_000;

    const refreshed = await validateSessionToken(database, created.token, now);
    assert(refreshed);
    assertEquals(refreshed.userId, user.id);
    assertEquals(refreshed.token, created.token);
    assertEquals(refreshed.refreshExpiresAt, refreshed.expiresAt);
    assert(refreshed.expiresAt > created.expiresAt);

    const stillStable = await validateSessionToken(database, created.token, now + 1);
    assert(stillStable);
    assertEquals(stillStable.token, created.token);
    assertEquals(stillStable.refreshExpiresAt, null);
  });
});

test("parallel requests carrying the old cookie remain valid", async () => {
  await withTestDb(async (database) => {
    const app = buildApp(database);
    const user = await register(app, "parallel@example.com");
    const created = await createSession(database, user.id);
    const cookie = `__Host-session=${created.token}`;

    const responses = await Promise.all([
      app.request("/auth/me", { headers: { cookie } }),
      app.request("/auth/me", { headers: { cookie } }),
    ]);
    assertEquals(responses.map((response) => response.status), [200, 200]);
    for (const response of responses) {
      const body = await response.json();
      assertEquals(body.id, user.id);
    }
  });
});

test("a tampered/garbage cookie is rejected with 401", async () => {
  await withTestDb(async (database: Database) => {
    const app = buildApp(database);
    const user = await register(app, "tampered@example.com");
    const loginResponse = await login(app, user.email, PASSWORD);
    const cookie = extractCookie(loginResponse)!;

    // Flip the last character of the token to invalidate the hash match.
    const tampered = cookie.slice(0, -1) + (cookie.endsWith("A") ? "B" : "A");

    const meResponse = await app.request("/auth/me", { headers: { cookie: tampered, Origin: "http://127.0.0.1:5173" } });
    assertEquals(meResponse.status, 401);
    await meResponse.body?.cancel();

    const garbageResponse = await app.request("/auth/me", {
      headers: { cookie: "__Host-session=not-a-real-token", Origin: "http://127.0.0.1:5173" },
    });
    assertEquals(garbageResponse.status, 401);
    await garbageResponse.body?.cancel();
  });
});

test("the DB stores only the token hash, never the raw cookie token", async () => {
  await withTestDb(async (database: Database) => {
    const app = buildApp(database);
    const user = await register(app, "hashed@example.com");
    const loginResponse = await login(app, user.email, PASSWORD);
    await loginResponse.body?.cancel();
    const cookie = extractCookie(loginResponse)!;
    const rawToken = cookie.slice("__Host-session=".length);

    const rows = await database
      .select()
      .from(sessions)
      .where(eq(sessions.userId, user.id));
    assertEquals(rows.length, 1);
    const stored = rows[0];

    assert(stored.tokenHash !== rawToken, "raw token was stored as the hash");
    assertEquals(stored.tokenHash, await sha256Hex(rawToken));
  });
});

test("a guarded route with no cookie is rejected with 401", async () => {
  await withTestDb(async (database: Database) => {
    const app = buildApp(database);
    const meResponse = await app.request("/auth/me");
    assertEquals(meResponse.status, 401);
    await meResponse.body?.cancel();
  });
});
