import { describe, it, expect } from "vitest";
import {
  ApiClientError,
  updateCurrentUser,
  startTelegramLogin,
  getTelegramLoginStatus,
  submitTelegramTwoFactorAuthentication,
  disconnectSource,
  listFeedsForSource,
  getFeed,
  unsubscribeFeed,
  listDigestRuns,
  getDigestRunDetail,
  deleteDigest,
} from "../api/client";

describe("ApiClientError", () => {
  it("exposes status, code, and message", () => {
    const error = new ApiClientError(422, "VALIDATION_ERROR", "Bad input");
    expect(error.status).toBe(422);
    expect(error.code).toBe("VALIDATION_ERROR");
    expect(error.message).toBe("Bad input");
    expect(error.name).toBe("ApiClientError");
  });
});

describe("updateCurrentUser", () => {
  it("sends PATCH /auth/me with JSON body", async () => {
    const originalFetch = globalThis.fetch;
    try {
      const fetchCalls: Array<[string, RequestInit?]> = [];
      globalThis.fetch = ((url: string, opts?: RequestInit) => {
        fetchCalls.push([url, opts]);
        return Promise.resolve(
          new Response(JSON.stringify({ id: "u1", name: "Test", email: "t@t.com", systemPrompt: "", defaultLanguage: null, createdAt: 0, updatedAt: 0 }), { status: 200 }),
        );
      }) as typeof fetch;
      await updateCurrentUser({ name: "New Name", defaultLanguage: null });
      expect(fetchCalls[0][0]).toBe("/auth/me");
      const opts = fetchCalls[0][1];
      expect(opts?.method).toBe("PATCH");
      expect(JSON.parse(opts?.body as string)).toEqual({ name: "New Name", defaultLanguage: null });
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

describe("startTelegramLogin", () => {
  it("sends POST /connectors/telegram/login without body", async () => {
    const originalFetch = globalThis.fetch;
    try {
      const fetchCalls: Array<[string, RequestInit?]> = [];
      globalThis.fetch = ((url: string, opts?: RequestInit) => {
        fetchCalls.push([url, opts]);
        return Promise.resolve(
          new Response(JSON.stringify({ loginSessionId: "s1", qrUrl: "tg://qr", expiresAt: 1000 }), { status: 200 }),
        );
      }) as typeof fetch;
      await startTelegramLogin();
      expect(fetchCalls[0][0]).toBe("/connectors/telegram/login");
      expect(fetchCalls[0][1]?.method).toBe("POST");
      expect(fetchCalls[0][1]?.body).toBeUndefined();
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

describe("getTelegramLoginStatus", () => {
  it("sends GET /connectors/telegram/login/:id", async () => {
    const originalFetch = globalThis.fetch;
    try {
      const fetchCalls: Array<[string, RequestInit?]> = [];
      globalThis.fetch = ((url: string, opts?: RequestInit) => {
        fetchCalls.push([url, opts]);
        return Promise.resolve(
          new Response(JSON.stringify({ status: "pending", expiresAt: 1000 }), { status: 200 }),
        );
      }) as typeof fetch;
      await getTelegramLoginStatus("s1");
      expect(fetchCalls[0][0]).toBe("/connectors/telegram/login/s1");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

describe("submitTelegramTwoFactorAuthentication", () => {
  it("sends POST /connectors/telegram/login/:id/2fa with password", async () => {
    const originalFetch = globalThis.fetch;
    try {
      const fetchCalls: Array<[string, RequestInit?]> = [];
      globalThis.fetch = ((url: string, opts?: RequestInit) => {
        fetchCalls.push([url, opts]);
        return Promise.resolve(
          new Response(JSON.stringify({ status: "complete", expiresAt: 1000 }), { status: 200 }),
        );
      }) as typeof fetch;
      await submitTelegramTwoFactorAuthentication("s1", { password: "secret" });
      expect(fetchCalls[0][0]).toBe("/connectors/telegram/login/s1/2fa");
      expect(fetchCalls[0][1]?.method).toBe("POST");
      expect(JSON.parse(fetchCalls[0][1]?.body as string)).toEqual({ password: "secret" });
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

describe("disconnectSource", () => {
  it("sends DELETE /sources/:id and returns DisconnectSourceResponse", async () => {
    const originalFetch = globalThis.fetch;
    try {
      const fetchCalls: Array<[string, RequestInit?]> = [];
      globalThis.fetch = ((url: string, opts?: RequestInit) => {
        fetchCalls.push([url, opts]);
        return Promise.resolve(
          new Response(JSON.stringify({ source: { id: "s1", connected: false }, revokeTelegramSession: true, message: "OK" }), { status: 200 }),
        );
      }) as typeof fetch;
      const result = await disconnectSource("s1");
      expect(fetchCalls[0][0]).toBe("/sources/s1");
      expect(fetchCalls[0][1]?.method).toBe("DELETE");
      expect(result.revokeTelegramSession).toBe(true);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

describe("listFeedsForSource", () => {
  it("sends GET /sources/:sourceId/feeds", async () => {
    const originalFetch = globalThis.fetch;
    try {
      const fetchCalls: Array<[string, RequestInit?]> = [];
      globalThis.fetch = ((url: string, opts?: RequestInit) => {
        fetchCalls.push([url, opts]);
        return Promise.resolve(new Response("[]", { status: 200 }));
      }) as typeof fetch;
      await listFeedsForSource("s1");
      expect(fetchCalls[0][0]).toBe("/sources/s1/feeds");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

describe("getFeed", () => {
  it("sends GET /feeds/:id", async () => {
    const originalFetch = globalThis.fetch;
    try {
      const fetchCalls: Array<[string, RequestInit?]> = [];
      globalThis.fetch = ((url: string, opts?: RequestInit) => {
        fetchCalls.push([url, opts]);
        return Promise.resolve(
          new Response(JSON.stringify({ id: "f1", sourceId: "s1", externalId: "e1", name: "Feed", kind: "news", customPrompt: null, position: null, enabled: true, deletedAt: null, lastFetchedPeriodEndMs: null, createdAt: 0, updatedAt: 0 }), { status: 200 }),
        );
      }) as typeof fetch;
      const result = await getFeed("f1");
      expect(fetchCalls[0][0]).toBe("/feeds/f1");
      expect(result.id).toBe("f1");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

describe("unsubscribeFeed", () => {
  it("sends DELETE /feeds/:id", async () => {
    const originalFetch = globalThis.fetch;
    try {
      const fetchCalls: Array<[string, RequestInit?]> = [];
      globalThis.fetch = ((url: string, opts?: RequestInit) => {
        fetchCalls.push([url, opts]);
        return Promise.resolve(
          new Response(JSON.stringify({ id: "f1", sourceId: "s1", deletedAt: 1 }), { status: 200 }),
        );
      }) as typeof fetch;
      await unsubscribeFeed("f1");
      expect(fetchCalls[0][0]).toBe("/feeds/f1");
      expect(fetchCalls[0][1]?.method).toBe("DELETE");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

describe("listDigestRuns", () => {
  it("sends GET /digests/runs", async () => {
    const originalFetch = globalThis.fetch;
    try {
      const fetchCalls: Array<[string, RequestInit?]> = [];
      globalThis.fetch = ((url: string, opts?: RequestInit) => {
        fetchCalls.push([url, opts]);
        return Promise.resolve(new Response("[]", { status: 200 }));
      }) as typeof fetch;
      await listDigestRuns();
      expect(fetchCalls[0][0]).toBe("/digests/runs");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

describe("getDigestRunDetail", () => {
  it("sends GET /digests/runs/:id", async () => {
    const originalFetch = globalThis.fetch;
    try {
      const fetchCalls: Array<[string, RequestInit?]> = [];
      globalThis.fetch = ((url: string, opts?: RequestInit) => {
        fetchCalls.push([url, opts]);
        return Promise.resolve(
          new Response(JSON.stringify({ run: { id: "r1" }, feeds: [] }), { status: 200 }),
        );
      }) as typeof fetch;
      const result = await getDigestRunDetail("r1");
      expect(fetchCalls[0][0]).toBe("/digests/runs/r1");
      expect(result.run.id).toBe("r1");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

describe("deleteDigest", () => {
  it("sends DELETE /digests/:id and returns the deleted digest", async () => {
    const originalFetch = globalThis.fetch;
    try {
      const fetchCalls: Array<[string, RequestInit?]> = [];
      const sample = { id: "d1", userId: "u1", periodStartMs: 1, periodEndMs: 2, status: "complete", createdAt: 3, updatedAt: 4 };
      globalThis.fetch = ((url: string, opts?: RequestInit) => {
        fetchCalls.push([url, opts]);
        return Promise.resolve(
          new Response(JSON.stringify(sample), { status: 200 }),
        );
      }) as typeof fetch;
      const result = await deleteDigest("d1");
      expect(fetchCalls[0][0]).toBe("/digests/d1");
      expect(fetchCalls[0][1]?.method).toBe("DELETE");
      expect(result.id).toBe("d1");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
