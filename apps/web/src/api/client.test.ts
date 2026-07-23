import { afterEach, describe, expect, it } from "vitest";
import {
  addSubstackPublication,
  ApiClientError,
  connectSubstackSession,
  createInterest,
  deleteDigest,
  deleteInterest,
  disconnectSource,
  getDigestRunDetail,
  getFeed,
  getTelegramLoginStatus,
  listDigestRuns,
  listFeedsForSource,
  listInterests,
  listSubstackPublications,
  startTelegramLogin,
  submitStoryFeedback,
  submitTelegramTwoFactorAuthentication,
  unsubscribeFeed,
  updateCurrentUser,
  updateInterest,
  updateSource,
  updateFeed,
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
          new Response(
            JSON.stringify({
              id: "u1",
              name: "Test",
              email: "t@t.com",
              systemPrompt: "",
              summaryPrompt: "",
              defaultLanguage: null,
              createdAt: 0,
              updatedAt: 0,
            }),
            { status: 200 },
          ),
        );
      }) as typeof fetch;
      await updateCurrentUser({ name: "New Name", defaultLanguage: null });
      expect(fetchCalls[0][0]).toBe("/auth/me");
      const opts = fetchCalls[0][1];
      expect(opts?.method).toBe("PATCH");
      expect(JSON.parse(opts?.body as string)).toEqual({
        name: "New Name",
        defaultLanguage: null,
      });
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

describe("updateSource", () => {
  it("sends the paid-title preference in a PATCH body", async () => {
    const originalFetch = globalThis.fetch;
    try {
      const fetchCalls: Array<[string, RequestInit?]> = [];
      globalThis.fetch = ((url: string, opts?: RequestInit) => {
        fetchCalls.push([url, opts]);
        return Promise.resolve(
          new Response(
            JSON.stringify({
              id: "source-1",
              userId: "user-1",
              connectorId: "Substack",
              position: null,
              enabled: true,
              showPaidPostTitles: true,
              connected: true,
              createdAt: 0,
              updatedAt: 0,
            }),
            { status: 200 },
          ),
        );
      }) as typeof fetch;

      await updateSource("source-1", { showPaidPostTitles: true });

      expect(fetchCalls[0][0]).toBe("/sources/source-1");
      expect(fetchCalls[0][1]?.method).toBe("PATCH");
      expect(JSON.parse(fetchCalls[0][1]?.body as string)).toEqual({
        showPaidPostTitles: true,
      });
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

describe("interest CRUD", () => {
  it("uses typed list, create, update, and dismiss endpoints", async () => {
    const originalFetch = globalThis.fetch;
    const calls: Array<[string, RequestInit?]> = [];
    try {
      globalThis.fetch = ((url: string, opts?: RequestInit) => {
        calls.push([url, opts]);
        const rule = {
          id: "rule-1",
          label: "Machine learning",
          kind: "topic",
          disposition: "mute",
          origin: "explicit",
          state: "active",
          strength: 60,
          expiresAt: null,
          createdAt: 0,
          updatedAt: 0,
        };
        return Promise.resolve(new Response(
          JSON.stringify(calls.length === 1 ? [] : rule),
          { status: calls.length === 2 ? 201 : 200 },
        ));
      }) as typeof fetch;
      await listInterests();
      await createInterest({
        label: "Machine learning",
        kind: "topic",
        disposition: "mute",
        expiresAt: null,
      });
      await updateInterest("rule-1", { disposition: "show_less" });
      await deleteInterest("rule-1");
      expect(calls.map(([url]) => url)).toEqual([
        "/interests",
        "/interests",
        "/interests/rule-1",
        "/interests/rule-1",
      ]);
      expect(JSON.parse(calls[1][1]?.body as string)).toEqual({
        label: "Machine learning",
        kind: "topic",
        disposition: "mute",
        expiresAt: null,
      });
      expect(calls[3][1]?.method).toBe("DELETE");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

describe("submitStoryFeedback", () => {
  it("posts story and targeted feedback with the delivered story row id", async () => {
    const originalFetch = globalThis.fetch;
    const calls: Array<[string, RequestInit?]> = [];
    try {
      globalThis.fetch = ((url: string, options?: RequestInit) => {
        calls.push([url, options]);
        return Promise.resolve(new Response(JSON.stringify({
          feedback: {
            id: `feedback-${calls.length}`,
            digestStoryId: "delivered-story-1",
            storyId: "story-1",
            storyVersion: 3,
            action: calls.length === 1 ? "relevant" : "mute_topic",
            createdAt: 1_700_000_000_000,
          },
          interestRules: [],
        }), { status: 200 }));
      }) as typeof fetch;

      await submitStoryFeedback("story/1", {
        digestStoryId: "delivered-story-1",
        action: "relevant",
      });
      await submitStoryFeedback("story/1", {
        digestStoryId: "delivered-story-1",
        action: "mute_topic",
        target: { kind: "entity", label: "Example Corp" },
      });

      expect(calls.map(([url]) => url)).toEqual([
        "/stories/story%2F1/feedback",
        "/stories/story%2F1/feedback",
      ]);
      expect(calls.map(([, options]) => options?.method)).toEqual([
        "POST",
        "POST",
      ]);
      expect(JSON.parse(calls[0][1]?.body as string)).toEqual({
        digestStoryId: "delivered-story-1",
        action: "relevant",
      });
      expect(JSON.parse(calls[1][1]?.body as string)).toEqual({
        digestStoryId: "delivered-story-1",
        action: "mute_topic",
        target: { kind: "entity", label: "Example Corp" },
      });
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

describe("profile and feed policy payloads", () => {
  it("sends global filtering settings and feed overrides", async () => {
    const originalFetch = globalThis.fetch;
    const calls: Array<[string, RequestInit?]> = [];
    try {
      globalThis.fetch = ((url: string, opts?: RequestInit) => {
        calls.push([url, opts]);
        return Promise.resolve(new Response(JSON.stringify({}), { status: 200 }));
      }) as typeof fetch;
      await updateCurrentUser({
        summaryPrompt: "Use concise bullets.",
        defaultRelevanceFilterMode: "include_all",
        relevanceThreshold: 75,
        maximumStoriesPerDigest: 12,
      });
      await updateSource("source-1", { relevanceFilterMode: "personalized" });
      await updateFeed("feed-1", { relevanceFilterMode: "include_all" });
      expect(JSON.parse(calls[0][1]?.body as string)).toEqual({
        summaryPrompt: "Use concise bullets.",
        defaultRelevanceFilterMode: "include_all",
        relevanceThreshold: 75,
        maximumStoriesPerDigest: 12,
      });
      expect(JSON.parse(calls[2][1]?.body as string)).toEqual({
        relevanceFilterMode: "include_all",
      });
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
          new Response(
            JSON.stringify({
              loginSessionId: "s1",
              qrUrl: "tg://qr",
              expiresAt: 1000,
            }),
            { status: 200 },
          ),
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
          new Response(JSON.stringify({ status: "pending", expiresAt: 1000 }), {
            status: 200,
          }),
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
          new Response(
            JSON.stringify({ status: "complete", expiresAt: 1000 }),
            { status: 200 },
          ),
        );
      }) as typeof fetch;
      await submitTelegramTwoFactorAuthentication("s1", { password: "secret" });
      expect(fetchCalls[0][0]).toBe("/connectors/telegram/login/s1/2fa");
      expect(fetchCalls[0][1]?.method).toBe("POST");
      expect(JSON.parse(fetchCalls[0][1]?.body as string)).toEqual({
        password: "secret",
      });
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
          new Response(
            JSON.stringify({
              source: { id: "s1", connected: false },
              revokeTelegramSession: true,
              message: "OK",
            }),
            { status: 200 },
          ),
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
          new Response(
            JSON.stringify({
              id: "f1",
              sourceId: "s1",
              externalId: "e1",
              name: "Feed",
              kind: "news",
              customPrompt: null,
              position: null,
              enabled: true,
              deletedAt: null,
              lastFetchedPeriodEndMs: null,
              createdAt: 0,
              updatedAt: 0,
            }),
            { status: 200 },
          ),
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
          new Response(
            JSON.stringify({ id: "f1", sourceId: "s1", deletedAt: 1 }),
            { status: 200 },
          ),
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
          new Response(JSON.stringify({ run: { id: "r1" }, feeds: [] }), {
            status: 200,
          }),
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
      const sample = {
        id: "d1",
        userId: "u1",
        periodStartMs: 1,
        periodEndMs: 2,
        status: "complete",
        createdAt: 3,
        updatedAt: 4,
      };
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

describe("Substack connector API", () => {
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("posts the structured session credentials without accepting a raw Cookie header", async () => {
    const calls: Array<[string, RequestInit?]> = [];
    globalThis.fetch = ((url: string, options?: RequestInit) => {
      calls.push([url, options]);
      return Promise.resolve(
        new Response(
          JSON.stringify({
            source: {
              id: "source-1",
              connectorId: "Substack",
              connected: true,
            },
          }),
          { status: 200 },
        ),
      );
    }) as typeof fetch;

    const result = await connectSubstackSession({
      substackSessionId: "sid-value",
      connectSessionId: "connect-value",
    });

    expect(calls[0][0]).toBe("/connectors/substack/session");
    expect(calls[0][1]?.method).toBe("POST");
    expect(JSON.parse(calls[0][1]?.body as string)).toEqual({
      substackSessionId: "sid-value",
      connectSessionId: "connect-value",
    });
    expect(calls[0][1]?.headers).not.toHaveProperty("Cookie");
    expect(result.source.id).toBe("source-1");
  });

  it("posts a publication URL and returns source plus feed", async () => {
    const calls: Array<[string, RequestInit?]> = [];
    globalThis.fetch = ((url: string, options?: RequestInit) => {
      calls.push([url, options]);
      return Promise.resolve(
        new Response(
          JSON.stringify({
            source: {
              id: "source-1",
              connectorId: "Substack",
              connected: true,
            },
            feed: {
              id: "feed-1",
              sourceId: "source-1",
              externalId: "https://example.com",
            },
          }),
          { status: 201 },
        ),
      );
    }) as typeof fetch;

    const result = await addSubstackPublication({
      publicationUrl: "https://example.com/articles/hello",
    });

    expect(calls[0][0]).toBe("/connectors/substack/publications");
    expect(calls[0][1]?.method).toBe("POST");
    expect(JSON.parse(calls[0][1]?.body as string)).toEqual({
      publicationUrl: "https://example.com/articles/hello",
    });
    expect(result.feed.id).toBe("feed-1");
  });
  it("gets followed Substack publications as a direct AvailableFeed array", async () => {
    const calls: Array<[string, RequestInit?]> = [];
    globalThis.fetch = ((url: string, options?: RequestInit) => {
      calls.push([url, options]);
      return Promise.resolve(
        new Response(
          JSON.stringify([
            {
              externalId: "https://example.substack.com",
              name: "Example",
              kind: "news",
            },
          ]),
          { status: 200 },
        ),
      );
    }) as typeof fetch;

    const result = await listSubstackPublications();

    expect(calls[0][0]).toBe("/connectors/substack/publications");
    expect(calls[0][1]?.method).toBeUndefined();
    expect(result).toEqual([
      {
        externalId: "https://example.substack.com",
        name: "Example",
        kind: "news",
      },
    ]);
  });
});
