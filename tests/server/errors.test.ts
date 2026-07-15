import { assertEquals, assertNotEquals, assertExists } from "@std/assert"
import { Hono } from "@hono/hono";
import {
  AuthError,
  ConflictError,
  NotFoundError,
  PayloadTooLargeError,
  ValidationError,
  errorHandler,
} from "../../src/server/errors.ts";
import { buildApp } from "../../src/server/app.ts";
import { database } from "../../src/db/client.ts";
import { summarizeErrorForOps } from "../../src/server/error-sanitizer.ts";

// --- helpers ---

function testApp(registerRoutes: (app: Hono) => void): Hono {
  const app = new Hono();
  app.onError(errorHandler);
  registerRoutes(app);
  return app;
}

// --- happy path ---

Deno.test("GET /health returns 200 { ok: true }", async () => {
  const app = buildApp(database);

  const response = await app.request("/health", { method: "GET" });
  assertEquals(response.status, 200);
  const body = await response.json();
  assertEquals(body, { ok: true });
});

// --- error scenarios ---

Deno.test("NotFoundError yields 404 with NOT_FOUND code", async () => {
  const app = testApp((a) => {
    a.get("/missing", () => {
      throw new NotFoundError("Resource not found");
    });
  });
  const response = await app.request("/missing");
  assertEquals(response.status, 404);
  const body = await response.json();
  assertEquals(body, { error: { code: "NOT_FOUND", message: "Resource not found" } });
});

Deno.test("ValidationError yields 422 with VALIDATION_ERROR code", async () => {
  const app = testApp((a) => {
    a.get("/invalid", () => {
      throw new ValidationError("Field 'name' is required");
    });
  });
  const response = await app.request("/invalid");
  assertEquals(response.status, 422);
  const body = await response.json();
  assertEquals(body, {
    error: { code: "VALIDATION_ERROR", message: "Field 'name' is required" },
  });
});

Deno.test("AuthError yields 401 with UNAUTHORIZED code", async () => {
  const app = testApp((a) => {
    a.get("/secret", () => {
      throw new AuthError();
    });
  });
  const response = await app.request("/secret");
  assertEquals(response.status, 401);
  const body = await response.json();
  assertEquals(body, { error: { code: "UNAUTHORIZED", message: "Unauthorized" } });
});

Deno.test("ConflictError yields 409 with CONFLICT code", async () => {
  const app = testApp((a) => {
    a.post("/duplicate", () => {
      throw new ConflictError("Already exists");
    });
  });
  const response = await app.request("/duplicate", { method: "POST" });
  assertEquals(response.status, 409);
  const body = await response.json();
  assertEquals(body, { error: { code: "CONFLICT", message: "Already exists" } });
});

Deno.test("unknown error yields 500 with generic message — no stack leak", async () => {
  const app = testApp((a) => {
    a.get("/boom", () => {
      throw new Error("boom — secret details");
    });
  });
  const response = await app.request("/boom");
  assertEquals(response.status, 500);
  const body = await response.json();
  assertEquals(body, {
    error: { code: "INTERNAL_ERROR", message: "Internal server error" },
  });
});

Deno.test("error with cause does not leak internals", async () => {
  const secret = "sk_live_secret_value";
  const app = testApp((a) => {
    a.get("/leak", () => {
      const error = new Error("Something happened");
      error.cause = { apiKey: secret, dbPassword: "super-secret-password" };
      throw error;
    });
  });
  const response = await app.request("/leak");
  assertEquals(response.status, 500);
  const bodyText = await response.text();
  assertNotEquals(bodyText.includes("sk_live"), true);
  assertNotEquals(bodyText.includes("super-secret-password"), true);
  assertNotEquals(bodyText.includes("secret"), true);
});

Deno.test("malformed JSON body returns error, not 500", async () => {
  const app = testApp((a) => {
    a.post("/parse-body", async (context) => {
      // Hono's built-in body parsing throws on malformed JSON
      await context.req.json();
      return context.json({ ok: true });
    });
  });
  const response = await app.request("/parse-body", {
    method: "POST",
    headers: { "content-type": "application/json", Origin: "http://127.0.0.1:5173" },
    body: "{ not valid json @@@@",
  });
  // 400 is the expected status for Hono's JSON parse failure
  assertNotEquals(response.status, 500);
  const body = await response.json();
  assertExists(body.error);
});

Deno.test("error handler preserves response status after async error", async () => {
  const app = testApp((a) => {
    a.get("/async-boom", async () => {
      await Promise.resolve();
      throw new NotFoundError("Gone after await");
    });
  });
  const response = await app.request("/async-boom");
  assertEquals(response.status, 404);
  const body = await response.json();
  assertEquals(body.error.code, "NOT_FOUND");
});

Deno.test("catch-all handler sanitizes \\nparams: from error messages", async () => {
  const logged: string[] = [];
  const originalConsoleError = globalThis.console.error;
  globalThis.console.error = (...args: unknown[]) => {
    logged.push(args.join(" "));
  };
  try {
    const app = testApp((a) => {
      a.get("/db-boom", () => {
        throw new Error(
          "DrizzleQueryError: Failed query: SELECT * FROM users WHERE id = $1\nparams: super-secret-hash",
        );
      });
    });
    const response = await app.request("/db-boom");
    assertEquals(response.status, 500);
    const body = await response.json();
    assertEquals(body, {
      error: { code: "INTERNAL_ERROR", message: "Internal server error" },
    });
    const logText = logged.join(" ");
    assertNotEquals(logText.includes("super-secret-hash"), true);
  } finally {
    globalThis.console.error = originalConsoleError;
  }
});

Deno.test("buildApp applies secure response headers before routes", async () => {
  const app = buildApp(database, {}, {
    allowedOrigins: ["http://127.0.0.1:5173"],
    maxRequestBodyBytes: 1_048_576,
  });
  const response = await app.request("/health");
  assertEquals(response.status, 200);
  assertEquals(response.headers.get("x-frame-options"), "DENY");
  assertEquals(response.headers.get("strict-transport-security"), "max-age=31536000; includeSubDomains");
  assertEquals(response.headers.get("x-content-type-options"), "nosniff");
  assertEquals(response.headers.get("content-security-policy"), null);
});

Deno.test("buildApp returns typed 413 for oversized request bodies", async () => {
  const app = buildApp(database, {}, {
    allowedOrigins: ["http://127.0.0.1:5173"],
    maxRequestBodyBytes: 4,
  });
  const response = await app.request("/health", {
    method: "POST",
    headers: { "content-type": "application/json", Origin: "http://127.0.0.1:5173" },
    body: "12345",
  });
  assertEquals(response.status, 413);
  assertEquals(await response.json(), {
    error: { code: "PAYLOAD_TOO_LARGE", message: "Request body too large" },
  });
  assertEquals(new PayloadTooLargeError().statusCode, 413);
});

Deno.test("operational redaction removes API keys, PEM keys, and URL userinfo", async () => {
  const logged: string[] = [];
  const originalConsoleError = globalThis.console.error;
  globalThis.console.error = (...args: unknown[]) => {
    logged.push(args.join(" "));
  };
  const rawApiKey = "sk-live-secret";
  const rawGoogleKey = "AIzaSySecretKey";
  const rawXaiKey = "xai-secret";
  const rawGrokKey = "gsk_secret";
  const rawBearer = "Bearer token-secret";
  const rawPem = "-----BEGIN PRIVATE KEY-----\\nprivate-secret\\n-----END PRIVATE KEY-----";
  try {
    const app = testApp((a) => {
      a.get("/secret-error", () => {
        throw new Error(
          `credentials ${rawApiKey} ${rawGoogleKey} ${rawXaiKey} ${rawGrokKey} ${rawBearer} ${rawPem} https://alice:password@example.com/path`,
        );
      });
    });
    assertEquals((await app.request("/secret-error")).status, 500);
    const logText = logged.join(" ");
    for (const secret of [rawApiKey, rawGoogleKey, rawXaiKey, rawGrokKey, rawBearer, rawPem, "alice:password"]) {
      assertEquals(logText.includes(secret), false);
    }
    assertEquals(summarizeErrorForOps(new Error(`${rawApiKey}\\nparams: db-secret`)).includes(rawApiKey), false);
    assertEquals(summarizeErrorForOps(new Error("x".repeat(501))).length, 500);
  } finally {
    globalThis.console.error = originalConsoleError;
  }
});
