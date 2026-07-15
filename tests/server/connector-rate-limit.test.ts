import { assertEquals } from "@std/assert";
import type { Hono } from "@hono/hono";
import { createRateLimitMiddleware } from "../../src/server/middleware/rate-limit.ts";
import { buildApp } from "../../src/server/app.ts";
import { withTestDb } from "../../src/db/testing.ts";
import type { Database } from "../../src/db/client.ts";
import {
  TelegramLoginSessionManager,
  type TelegramLoginClient,
  type TelegramLoginClientFactory,
} from "../../src/connectors/telegram/login-session.ts";
import { CredentialCipher } from "../../src/crypto/credential-cipher.ts";
import { EnvMasterKeyProvider } from "../../src/crypto/key-provider.ts";

const PASSWORD = "analytical-engine-1843";
const MASTER_KEY_BYTES = new Uint8Array(32).fill(61);
const TWO_FACTOR_AUTHENTICATION_PASSWORD = "correct horse battery staple";

function buildCredentialCipher(): CredentialCipher {
  return new CredentialCipher(new EnvMasterKeyProvider(MASTER_KEY_BYTES));
}

function jsonRequest(method: "POST", body?: unknown): RequestInit {
  return {
    method,
    headers: { "content-type": "application/json", Origin: "http://127.0.0.1:5173" },
    body: body === undefined ? undefined : JSON.stringify(body),
  };
}

function extractCookie(response: Response): string {
  const header = response.headers.get("set-cookie");
  if (header === null) {
    throw new Error("login did not set a session cookie");
  }
  return header.split(";")[0];
}

async function register(app: Hono, email: string): Promise<void> {
  const response = await app.request(
    "/auth/register",
    jsonRequest("POST", { name: "Ada Lovelace", email, password: PASSWORD }),
  );
  assertEquals(response.status, 201);
}

async function login(app: Hono, email: string): Promise<string> {
  const response = await app.request(
    "/auth/login",
    jsonRequest("POST", { email, password: PASSWORD }),
  );
  assertEquals(response.status, 200);
  return extractCookie(response);
}

class FakeTelegramLoginClientFactory implements TelegramLoginClientFactory {
  #mode: "approval" | "two-factor-authentication" = "approval";

  queueClient(mode: "approval" | "two-factor-authentication"): void {
    this.#mode = mode;
  }

  createUnauthenticatedClient(): Promise<TelegramLoginClient> {
    return Promise.resolve(new FakeTelegramLoginClient(this.#mode));
  }

  readApiCredentials() {
    return { apiId: 12345, apiHash: "test-api-hash" };
  }
}

class FakeTelegramLoginClient implements TelegramLoginClient {
  readonly approval = Promise.withResolvers<void>();
  readonly token = crypto.randomUUID().replaceAll("-", "");
  sessionString = `session-${crypto.randomUUID()}`;

  constructor(readonly mode: "approval" | "two-factor-authentication") {}

  readonly session = {
    save: () => this.sessionString,
  };

  async signInUserWithQrCode(
    _credentials: { apiId: number; apiHash: string },
    callbacks: {
      qrCode(code: { token: { toString(encoding: "base64url"): string } }): Promise<void>;
      password(): Promise<string>;
      onError(error: unknown): Promise<boolean>;
    },
  ): Promise<void> {
    await callbacks.qrCode({ token: { toString: () => this.token } });
    if (this.mode === "approval") {
      return;
    }
    const password = await callbacks.password();
    if (password !== TWO_FACTOR_AUTHENTICATION_PASSWORD) {
      await callbacks.onError(new Error("invalid two-factor authentication password"));
      throw new Error("invalid two-factor authentication password");
    }
  }
}

Deno.test("telegram login start and 2fa routes are rate limited", async () => {
  await withTestDb(async (database: Database) => {
    let now = 1_000;
    const clientFactory = new FakeTelegramLoginClientFactory();
    const manager = new TelegramLoginSessionManager({
      database,
      credentialCipher: buildCredentialCipher(),
      clientFactory,
      now: () => now,
    });
    const app = buildApp(database, {
      connectors: {
        telegramLoginSessionManager: manager,
        telegramLoginRateLimiter: createRateLimitMiddleware({
          database,
          bucket: "telegram-start-test",
          limit: 1,
          windowMs: 60_000,
          now: () => now,
        }),
        telegramTwoFactorRateLimiter: createRateLimitMiddleware({
          database,
          bucket: "telegram-2fa-test",
          limit: 1,
          windowMs: 60_000,
          now: () => now,
        }),
      },
    });
    await register(app, "connector-limit@example.com");
    const cookie = await login(app, "connector-limit@example.com");

    clientFactory.queueClient("approval");
    const firstStart = await app.request("/connectors/telegram/login", { method: "POST", headers: { cookie, Origin: "http://127.0.0.1:5173", "x-forwarded-for": "1.1.1.1" } });
    assertEquals(firstStart.status, 201);
    const secondStart = await app.request("/connectors/telegram/login", { method: "POST", headers: { cookie, Origin: "http://127.0.0.1:5173", "x-forwarded-for": "1.1.1.1" } });
    assertEquals(secondStart.status, 429);

    now += 60_001;
    clientFactory.queueClient("two-factor-authentication");
    const startTwoFactor = await app.request("/connectors/telegram/login", { method: "POST", headers: { cookie, Origin: "http://127.0.0.1:5173", "x-forwarded-for": "2.2.2.2" } });
    assertEquals(startTwoFactor.status, 201);
    const startTwoFactorJson = await startTwoFactor.json();
    const loginSessionId = String(startTwoFactorJson.loginSessionId);
    await app.request(`/connectors/telegram/login/${loginSessionId}`, { headers: { cookie } });

    const firstTwoFactor = await app.request(`/connectors/telegram/login/${loginSessionId}/2fa`, {
      ...jsonRequest("POST", { password: TWO_FACTOR_AUTHENTICATION_PASSWORD }),
      headers: { "content-type": "application/json", cookie, Origin: "http://127.0.0.1:5173", "x-forwarded-for": "3.3.3.3" },
    });
    assertEquals(firstTwoFactor.status, 200);
    const secondTwoFactor = await app.request(`/connectors/telegram/login/${loginSessionId}/2fa`, {
      ...jsonRequest("POST", { password: TWO_FACTOR_AUTHENTICATION_PASSWORD }),
      headers: { "content-type": "application/json", cookie, Origin: "http://127.0.0.1:5173", "x-forwarded-for": "3.3.3.3" },
    });
    assertEquals(secondTwoFactor.status, 429);
  });
});
