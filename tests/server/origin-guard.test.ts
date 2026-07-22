import { test } from "bun:test";
import { assertEquals } from "../assertions.ts";
import { Hono } from "hono";
import { SESSION_COOKIE } from "../../src/auth/session-service.ts";
import { errorHandler } from "../../src/server/errors.ts";
import { createOriginGuard } from "../../src/server/middleware/origin-guard.ts";

const ALLOWED_ORIGIN = "http://127.0.0.1:5173";
const COOKIE = `${SESSION_COOKIE}=test-session`;

function testApp(): Hono {
  const app = new Hono();
  app.onError(errorHandler);
  app.use("*", createOriginGuard([ALLOWED_ORIGIN]));
  app.all("*", (context) => context.text("ok"));
  return app;
}

async function request(
  app: Hono,
  method: string,
  headers: Record<string, string> = {},
): Promise<Response> {
  return await app.request("/mutation", {
    method,
    headers: { "content-type": "application/json", cookie: COOKIE, ...headers },
  });
}

test("origin guard accepts cookie-authenticated JSON POST/PATCH/DELETE from exact Origin", async () => {
  const app = testApp();
  for (const method of ["POST", "PATCH", "DELETE"]) {
    const response = await request(app, method, { Origin: ALLOWED_ORIGIN });
    assertEquals(response.status, 200);
  }
});

test("origin guard accepts the exact Referer origin when Origin is absent", async () => {
  const app = testApp();
  const response = await request(app, "POST", {
    Referer: `${ALLOWED_ORIGIN}/settings/profile?tab=security`,
  });
  assertEquals(response.status, 200);
});

test("origin guard rejects mismatched Origin and Referer values", async () => {
  const app = testApp();
  const cases: Record<string, string>[] = [
    { Origin: "https://evil.example" },
    { Referer: "https://evil.example/form" },
    { Referer: "not a URL" },
  ];
  for (const method of ["POST", "PATCH", "DELETE"]) {
    for (const headers of cases) {
      const response = await request(app, method, headers);
      assertEquals(response.status, 401);
      assertEquals((await response.json()).error.message, "Invalid request origin");
    }
  }
});

test("origin guard rejects a cookie-authenticated mutation with no Origin or Referer", async () => {
  for (const method of ["POST", "PATCH", "DELETE"]) {
    const response = await request(testApp(), method);
    assertEquals(response.status, 401);
    assertEquals((await response.json()).error.message, "Invalid request origin");
  }
});

test("origin guard bypasses safe methods even with a cookie and no origin headers", async () => {
  const app = testApp();
  for (const method of ["GET", "HEAD", "OPTIONS"]) {
    const response = await request(app, method);
    assertEquals(response.status, 200);
  }
});

test("origin guard bypasses mutations without a session cookie", async () => {
  const app = testApp();
  const response = await app.request("/mutation", { method: "POST" });
  assertEquals(response.status, 200);
});
