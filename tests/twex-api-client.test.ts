import { test } from "bun:test";

import {
  TwexApiClient,
  TwexApiError,
  type TwexFetch,
} from "../src/connectors/x/twex-api-client.ts";
import type { XCredentials } from "../src/connectors/x/x.types.ts";
import {
  assert,
  assertEquals,
  assertRejects,
  assertStrictEquals,
  assertStringIncludes,
  assertThrows,
} from "./assertions.ts";

const API_KEY = "sk-twex-test-12345";
const AUTH_TOKEN = "auth-token-secret-abc";
const COOKIE = "auth_token=auth-token-secret-abc; ct0=ct0-secret-value";
const BASE_URL = "https://twex.test";
const FROM = 1_700_000_000_000;
const TO = 1_700_000_010_000;

type ClientCredentials = Pick<XCredentials, "apiKey" | "authToken" | "cookie" | "pin">;

function creds(overrides: Partial<ClientCredentials> = {}): ClientCredentials {
  return { apiKey: API_KEY, authToken: AUTH_TOKEN, cookie: COOKIE, ...overrides };
}

interface CapturedRequest {
  url: string;
  method: string;
  redirect: string | undefined;
  authorization: string | undefined;
  contentType: string | undefined;
  body: unknown;
}

function mockFetch(responses: Response[]): {
  captured: CapturedRequest[];
  fetch: TwexFetch;
} {
  const captured: CapturedRequest[] = [];
  let index = 0;
  const fetchMock: TwexFetch = (input, init) => {
    const url = typeof input === "string"
      ? input
      : input instanceof URL
      ? input.href
      : input.url;
    const headers = (init?.headers ?? {}) as Record<string, string>;
    captured.push({
      url,
      method: init?.method ?? "GET",
      redirect: init?.redirect,
      authorization: headers["Authorization"],
      contentType: headers["Content-Type"],
      body: typeof init?.body === "string" ? JSON.parse(init.body) : undefined,
    });
    const response = responses[index];
    if (response === undefined) {
      throw new Error(`unexpected extra request: ${init?.method} ${url}`);
    }
    index += 1;
    return Promise.resolve(response);
  };
  return { captured, fetch: fetchMock };
}

function envelope(code: number, msg: string, data: unknown): unknown {
  return { code, msg, data };
}

function userInfoData(): Record<string, unknown> {
  return {
    userId: "1111111111111111111",
    username: "tester",
    name: "Test User",
    description: "fixture account",
    location: "NYC",
    profileImageUrlHttps: "https://pbs.twimg.com/profile_images/fixture.jpg",
    createdAt: "2019-01-01T00:00:00.000Z",
    verified: false,
    protected: false,
    isBlueVerified: false,
    defaultProfile: false,
    defaultProfileImage: false,
    fastFollowersCount: 0,
    favouritesCount: 1,
    followersCount: 2,
    followingCount: 3,
    hasCustomTimelines: false,
    isTranslator: false,
    listedCount: 0,
    mediaCount: 4,
    normalFollowersCount: 2,
    possiblySensitive: false,
    statusesCount: 5,
  };
}

function listData(
  id: string,
  name: string,
  memberCount = 10,
): Record<string, unknown> {
  return {
    id,
    name,
    description: "fixture list",
    is_private: false,
    member_count: memberCount,
    subscriber_count: 3,
  };
}

function tweetData(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    tweet_id: "987654321",
    text: "short text",
    full_text: "full text of the tweet",
    created_at_datetime: new Date(FROM).toISOString(),
    created_at: null,
    favorite_count: 7,
    reply_count: 2,
    retweet_count: 1,
    view_count: "12345",
    user: { id: "u-1", name: "Alice", screen_name: "alice" },
    ...overrides,
  };
}

function listPage(
  tweets: unknown[],
  hasNextPage: boolean,
  nextCursor: string | null = null,
  code = 200,
  msg = "ok",
): Record<string, unknown> {
  return { code, msg, data: tweets, has_next_page: hasNextPage, next_cursor: nextCursor };
}

function messageData(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "msg-1",
    text: "hello",
    time: new Date(FROM).toISOString(),
    sequence_id: "seq-1",
    sender_id: "u-9",
    ...overrides,
  };
}

function dmHistoryPage(
  messages: unknown[],
  hasMore: boolean,
  code = 200,
  msg = "ok",
): Record<string, unknown> {
  return {
    code,
    msg,
    data: { conversation_id: "conv-abc", has_more: hasMore, messages },
  };
}

test("TwexApiClient rejects missing or empty credentials", () => {
  assertThrows(
    () => new TwexApiClient(null as never),
    "Twex API credentials are required",
  );
  assertThrows(
    () => new TwexApiClient(creds({ apiKey: "" })),
    "Twex API key is required",
  );
  assertThrows(
    () => new TwexApiClient(creds({ authToken: "" })),
    "Twex auth token is required",
  );
  assertThrows(
    () => new TwexApiClient(creds({ cookie: "" })),
    "Twex cookie is required",
  );
});

test("getUserInfo requests GET /twitter/{auth_token}/user_info with Bearer auth", async () => {
  const { captured, fetch: fetchMock } = mockFetch([
    Response.json(envelope(200, "ok", userInfoData())),
  ]);
  const client = new TwexApiClient(creds(), { baseUrl: BASE_URL, fetch: fetchMock });

  const user = await client.getUserInfo();

  assertEquals(captured.length, 1);
  assertEquals(captured[0].method, "GET");
  assertEquals(
    captured[0].url,
    `${BASE_URL}/twitter/${encodeURIComponent(AUTH_TOKEN)}/user_info`,
  );
  assertEquals(captured[0].authorization, `Bearer ${API_KEY}`);
  assertEquals(captured[0].contentType, undefined);
  assertEquals(captured[0].body, undefined);
  assertEquals(user.username, "tester");
  assertEquals(user.userId, "1111111111111111111");
});

test("getUserInfo percent-encodes the auth token in the path", async () => {
  const weirdToken = "auth=token/with?chars&";
  const { captured, fetch: fetchMock } = mockFetch([
    Response.json(envelope(200, "ok", userInfoData())),
  ]);
  const client = new TwexApiClient(
    creds({ authToken: weirdToken }),
    { baseUrl: BASE_URL, fetch: fetchMock },
  );

  await client.getUserInfo();

  assertEquals(captured[0].url, `${BASE_URL}/twitter/${encodeURIComponent(weirdToken)}/user_info`);
  assert(!captured[0].url.includes(weirdToken), "raw auth token must not appear in the URL");
});

test("TwexApiClient defaults to the official base URL and strips trailing slashes", async () => {
  const { captured, fetch: fetchMock } = mockFetch([
    Response.json(envelope(200, "ok", userInfoData())),
  ]);
  const client = new TwexApiClient(creds(), { fetch: fetchMock });

  await client.getUserInfo();

  assertEquals(
    captured[0].url,
    `https://api.twexapi.io/twitter/${encodeURIComponent(AUTH_TOKEN)}/user_info`,
  );

  const slashed = mockFetch([Response.json(envelope(200, "ok", userInfoData()))]);
  const slashedClient = new TwexApiClient(creds(), {
    baseUrl: "https://twex.test///",
    fetch: slashed.fetch,
  });
  await slashedClient.getUserInfo();
  assertEquals(
    slashed.captured[0].url,
    `${BASE_URL}/twitter/${encodeURIComponent(AUTH_TOKEN)}/user_info`,
  );
});

test("every Twex request is issued with redirect set to error", async () => {
  const { captured, fetch: fetchMock } = mockFetch([
    Response.json(envelope(200, "ok", userInfoData())),
    Response.json(envelope(200, "ok", [listData("1001", "Alpha")])),
    Response.json(envelope(200, "ok", [])),
    Response.json(listPage([], false)),
    Response.json(dmHistoryPage([], false)),
  ]);
  const client = new TwexApiClient(creds(), { baseUrl: BASE_URL, fetch: fetchMock });

  await client.getUserInfo();
  await client.searchLists("space", 10);
  await client.getConversations();
  await client.getListPostsPage("1001", FROM, TO, null);
  await client.getChatMessagesPage("conv-abc", FROM, TO, null);


  assertEquals(captured.length, 5);
  for (const request of captured) {
    assertEquals(
      request.redirect,
      "error",
      `request ${request.method} ${request.url} must set redirect: error`,
    );
  }
});

test("a redirect response surfaces a fixed secret-safe TwexApiError and no second destination receives the request", async () => {
  const destination = `${BASE_URL}/evil-endpoint`;
  const { captured, fetch: fetchMock } = mockFetch([
    Response.redirect(destination, 301),
  ]);
  const client = new TwexApiClient(creds(), { baseUrl: BASE_URL, fetch: fetchMock });

  const error = await assertRejects(() => client.getUserInfo());

  assert(error instanceof TwexApiError);
  assertEquals(error.status, 301);
  assertEquals(
    error.message,
    "Twex API request failed with HTTP 301",
  );
  assertEquals(captured.length, 1, "the client must not follow the redirect");
  assert(captured[0].redirect === "error", "the redirect must be refused at the fetch layer");
  for (const request of captured) {
    assert(
      !request.url.includes("evil-endpoint"),
      "no request may reach the redirect destination",
    );
  }
  for (const secret of [API_KEY, AUTH_TOKEN, COOKIE]) {
    assert(!error.message.includes(secret), "redirect errors must not leak secrets");
  }
});

test("TwexApiClient base URL precedence is explicit, then environment, then default", async () => {
  const previous = process.env["TWEXAPI_BASE_URL"];
  try {
    process.env["TWEXAPI_BASE_URL"] = "https://env.example/api";

    const explicit = mockFetch([Response.json(envelope(200, "ok", userInfoData()))]);
    await new TwexApiClient(creds(), {
      baseUrl: "https://override.example/api",
      fetch: explicit.fetch,
    }).getUserInfo();
    assertEquals(
      explicit.captured[0].url,
      `https://override.example/api/twitter/${encodeURIComponent(AUTH_TOKEN)}/user_info`,
    );

    const envOnly = mockFetch([Response.json(envelope(200, "ok", userInfoData()))]);
    await new TwexApiClient(creds(), { fetch: envOnly.fetch }).getUserInfo();
    assertEquals(
      envOnly.captured[0].url,
      `https://env.example/api/twitter/${encodeURIComponent(AUTH_TOKEN)}/user_info`,
    );

    delete process.env["TWEXAPI_BASE_URL"];
    const fallback = mockFetch([Response.json(envelope(200, "ok", userInfoData()))]);
    await new TwexApiClient(creds(), { fetch: fallback.fetch }).getUserInfo();
    assertEquals(
      fallback.captured[0].url,
      `https://api.twexapi.io/twitter/${encodeURIComponent(AUTH_TOKEN)}/user_info`,
    );
  } finally {
    if (previous === undefined) delete process.env["TWEXAPI_BASE_URL"];
    else process.env["TWEXAPI_BASE_URL"] = previous;
  }
});

test("TwexApiClient construction rejects unsafe base URLs before any request", async () => {
  const { captured, fetch: fetchMock } = mockFetch([]);
  for (const bad of [
    "http://twex.example",
    "ftp://twex.example",
    "twex.example",
    "/relative/path",
    "https://user:pass@twex.example",
    "https://twex.example?token=secret",
    "https://twex.example#fragment",
  ]) {
    assertThrows(
      () => new TwexApiClient(creds(), { baseUrl: bad, fetch: fetchMock }),
      Error,
      "Invalid TWEXAPI_BASE_URL",
      `baseUrl ${JSON.stringify(bad)} must be rejected`,
    );
  }
  assertEquals(captured.length, 0, "no request may be issued for a rejected base URL");
});

test("getUserInfo surfaces envelope, HTTP, and shape failures without leaking secrets", async () => {
  const secrets = [API_KEY, AUTH_TOKEN, COOKIE];

  const nullData = mockFetch([Response.json(envelope(200, "ok", null))]);
  const nullError = await assertRejects(() =>
    new TwexApiClient(creds(), { baseUrl: BASE_URL, fetch: nullData.fetch }).getUserInfo()
  );
  assert(nullError instanceof TwexApiError);
  assertStringIncludes(nullError.message, "no user info");
  for (const secret of secrets) {
    assert(!nullError.message.includes(secret), "null-data error must not leak secrets");
  }

  const http = mockFetch([new Response("boom", { status: 500 })]);
  const httpError = await assertRejects(() =>
    new TwexApiClient(creds(), { baseUrl: BASE_URL, fetch: http.fetch }).getUserInfo()
  );
  assert(httpError instanceof TwexApiError);
  assertEquals(httpError.status, 500);
  assertStringIncludes(httpError.message, "HTTP 500");

  const nonJson = mockFetch([new Response("not-json", { status: 200 })]);
  const nonJsonError = await assertRejects(() =>
    new TwexApiClient(creds(), { baseUrl: BASE_URL, fetch: nonJson.fetch }).getUserInfo()
  );
  assert(nonJsonError instanceof TwexApiError);
  assertStringIncludes(nonJsonError.message, "non-JSON response");

  const badEnvelope = mockFetch([Response.json(envelope(401, "invalid token", null))]);
  const envelopeError = await assertRejects(() =>
    new TwexApiClient(creds(), { baseUrl: BASE_URL, fetch: badEnvelope.fetch }).getUserInfo()
  );
  assert(envelopeError instanceof TwexApiError);
  assertEquals(envelopeError.code, 401);
  assertEquals(envelopeError.status, 200);
  assertStringIncludes(envelopeError.message, "envelope code 401");
  assert(
    !envelopeError.message.includes("invalid token"),
    "envelope msg must not be echoed into the error",
  );
  for (const secret of secrets) {
    assert(!envelopeError.message.includes(secret), "envelope error must not leak secrets");
  }

  const badShape = mockFetch([
    Response.json(envelope(200, "ok", { username: "missing-fields" })),
  ]);
  const shapeError = await assertRejects(() =>
    new TwexApiClient(creds(), { baseUrl: BASE_URL, fetch: badShape.fetch }).getUserInfo()
  );
  assert(shapeError instanceof TwexApiError);
  assertStringIncludes(shapeError.message, "schema validation");
});

test("a raw fetch rejection becomes a secret-safe TwexApiError", async () => {
  const failingFetch: TwexFetch = () =>
    Promise.reject(new TypeError("fetch failed: connection refused"));
  const client = new TwexApiClient(creds(), { baseUrl: BASE_URL, fetch: failingFetch });

  const error = await assertRejects(() => client.getUserInfo());

  assert(error instanceof TwexApiError);
  assertEquals(
    error.message,
    "Twex API request failed before receiving a response",
  );
  assertEquals(error.status, undefined);
  assertEquals(error.code, undefined);
  for (const secret of [API_KEY, AUTH_TOKEN, COOKIE]) {
    assert(!error.message.includes(secret), "network failure must not leak secrets");
  }
  assert(
    !error.message.includes("fetch failed"),
    "the underlying network error must not be echoed",
  );
});

test("an AbortError raised by fetch passes through unwrapped", async () => {
  const original = new DOMException("The operation was aborted", "AbortError");
  const abortingFetch: TwexFetch = () => Promise.reject(original);
  const client = new TwexApiClient(creds(), { baseUrl: BASE_URL, fetch: abortingFetch });

  const error = await assertRejects(() => client.getUserInfo());

  assertStrictEquals(error, original);
});

test("an AbortError raised while reading the body stays the original AbortError", async () => {
  const original = new DOMException("The operation was aborted", "AbortError");
  const fakeResponse = {
    ok: true,
    json: () => Promise.reject(original),
  } as unknown as Response;
  const { fetch: fetchMock } = mockFetch([fakeResponse]);
  const client = new TwexApiClient(creds(), { baseUrl: BASE_URL, fetch: fetchMock });

  const error = await assertRejects(() => client.getUserInfo());

  assertStrictEquals(error, original);
});

test("a generic body-read failure with an aborted signal yields the abort reason", async () => {
  const controller = new AbortController();
  const fakeResponse = {
    ok: true,
    json: () => {
      controller.abort();
      return Promise.reject(new Error("body stream corrupted"));
    },
  } as unknown as Response;
  const { fetch: fetchMock } = mockFetch([fakeResponse]);
  const client = new TwexApiClient(creds(), { baseUrl: BASE_URL, fetch: fetchMock });

  const error = await assertRejects(() => client.getUserInfo(controller.signal));

  assert(error instanceof DOMException);
  assertEquals(error.name, "AbortError");
  assert(
    !(error instanceof TwexApiError),
    "the abort reason must not be wrapped as a provider error",
  );
});

test("searchLists POSTs the query and target count and maps list models", async () => {
  const { captured, fetch: fetchMock } = mockFetch([
    Response.json(envelope(200, "ok", [listData("123456789", "Space News", 42)])),
  ]);
  const client = new TwexApiClient(creds(), { baseUrl: BASE_URL, fetch: fetchMock });

  const lists = await client.searchLists("space", 100);

  assertEquals(captured.length, 1);
  assertEquals(captured[0].method, "POST");
  assertEquals(captured[0].url, `${BASE_URL}/twitter/list/search`);
  assertEquals(captured[0].authorization, `Bearer ${API_KEY}`);
  assertEquals(captured[0].contentType, "application/json");
  assertEquals(captured[0].body, { query: "space", target_count: 100 });
  assertEquals(lists, [{
    id: "123456789",
    name: "Space News",
    description: "fixture list",
    is_private: false,
    member_count: 42,
    subscriber_count: 3,
  }]);
});

test("searchLists validates the query and target count before any request", async () => {
  const { captured, fetch: fetchMock } = mockFetch([]);
  const client = new TwexApiClient(creds(), { baseUrl: BASE_URL, fetch: fetchMock });

  await assertRejects(() => client.searchLists("", 10), "non-empty query");
  await assertRejects(() => client.searchLists("q", 0), "positive target count");
  await assertRejects(() => client.searchLists("q", 2.5), "positive target count");
  assertEquals(captured.length, 0);
});

test("getConversations sends the full cookie, never the bare auth token", async () => {
  const conversations = [
    { conversation_id: "conv-group-1", type: "group", is_muted: false, participants: ["u1", "u2"] },
    { conversation_id: "conv-direct-1", type: "direct", is_muted: false, participants: ["u1"] },
  ];
  const { captured, fetch: fetchMock } = mockFetch([
    Response.json(envelope(200, "ok", conversations)),
  ]);
  const client = new TwexApiClient(creds(), { baseUrl: BASE_URL, fetch: fetchMock });

  const result = await client.getConversations();

  assertEquals(captured.length, 1);
  assertEquals(captured[0].method, "POST");
  assertEquals(captured[0].url, `${BASE_URL}/v3/twitter/conversations`);
  assertEquals(captured[0].body, { cookie: COOKIE, count: 200, all: true });
  assert(
    captured[0].body !== null &&
      typeof captured[0].body === "object" &&
      "cookie" in captured[0].body &&
      captured[0].body.cookie !== AUTH_TOKEN &&
      !Object.hasOwn(captured[0].body, "authToken"),
    "conversations must use the full cookie without an authToken field",
  );
  assertEquals(result, conversations);
});

test("getConversations rejects conversation types outside direct and group", async () => {
  const { fetch: fetchMock } = mockFetch([
    Response.json(envelope(200, "ok", [{
      conversation_id: "c1",
      type: "fanout",
      is_muted: false,
      participants: [],
    }])),
  ]);
  const client = new TwexApiClient(creds(), { baseUrl: BASE_URL, fetch: fetchMock });

  const error = await assertRejects(() => client.getConversations());
  assert(error instanceof TwexApiError);
  assertStringIncludes(error.message, "schema validation");
});

test("getListPostsPage fetches one page and maps tweets", async () => {
  const { captured, fetch: fetchMock } = mockFetch([
    Response.json(listPage([tweetData()], false)),
  ]);
  const client = new TwexApiClient(creds(), { baseUrl: BASE_URL, fetch: fetchMock });

  const page = await client.getListPostsPage("1001", FROM, TO, null);

  assertEquals(captured.length, 1);
  assertEquals(captured[0].method, "POST");
  assertEquals(captured[0].url, `${BASE_URL}/twitter/list/tweets/page`);
  assertEquals(captured[0].authorization, `Bearer ${API_KEY}`);
  assertEquals(captured[0].body, { list_id: "1001", next_cursor: null });
  assertEquals(page, {
    items: [{
      kind: "post",
      externalId: "987654321",
      platformId: "u-1",
      date: FROM,
      text: "full text of the tweet",
      author: "alice",
      url: "https://x.com/alice/status/987654321",
      replyCount: 2,
      repostCount: 1,
      likeCount: 7,
      viewCount: 12345,
    }],
    nextCursor: null,
    complete: true,
  });
});

test("getListPostsPage sends the provided cursor and returns resumable progress", async () => {
  const { captured, fetch: fetchMock } = mockFetch([
    Response.json(listPage([
      tweetData({
        tweet_id: "t1",
        created_at_datetime: new Date(TO - 1000).toISOString(),
      }),
    ], true, "c1")),
  ]);
  const client = new TwexApiClient(creds(), { baseUrl: BASE_URL, fetch: fetchMock });

  const page = await client.getListPostsPage("1001", FROM, TO, "previous");

  assertEquals(captured.length, 1, "a page method must make exactly one request");
  assertEquals(captured[0].body, { list_id: "1001", next_cursor: "previous" });
  assertEquals(page.items.map((post) => post.externalId), ["t1"]);
  assertEquals(page.nextCursor, "c1");
  assertEquals(page.complete, false);
});

test("getListPostsPage retains out-of-window tweets and completes only at the lower bound", async () => {
  const { captured, fetch: fetchMock } = mockFetch([
    Response.json(listPage([
      tweetData({
        tweet_id: "future",
        created_at_datetime: new Date(TO + 1).toISOString(),
      }),
      tweetData({
        tweet_id: "at-start",
        created_at_datetime: new Date(FROM).toISOString(),
      }),
      tweetData({
        tweet_id: "older",
        created_at_datetime: new Date(FROM - 1).toISOString(),
      }),
    ], true, "ignored-after-boundary")),
  ]);
  const client = new TwexApiClient(creds(), { baseUrl: BASE_URL, fetch: fetchMock });

  const page = await client.getListPostsPage("1001", FROM, TO, null);

  assertEquals(captured.length, 1, "the lower boundary must not trigger a hidden second request");
  assertEquals(page.items.map((post) => post.externalId), ["future", "at-start", "older"]);
  assertEquals(page.nextCursor, null);
  assertEquals(page.complete, true);
});

test("getListPostsPage retains after-to tweets without treating them as a boundary", async () => {
  const { captured, fetch: fetchMock } = mockFetch([
    Response.json(listPage([
      tweetData({
        tweet_id: "future",
        created_at_datetime: new Date(TO + 1).toISOString(),
      }),
    ], true, "c-future")),
  ]);
  const client = new TwexApiClient(creds(), { baseUrl: BASE_URL, fetch: fetchMock });

  const page = await client.getListPostsPage("1001", FROM, TO, null);

  assertEquals(captured.length, 1);
  assertEquals(page.items.map((post) => post.externalId), ["future"]);
  assertEquals(page.nextCursor, "c-future");
  assertEquals(page.complete, false);
});

test("getListPostsPage returns items with a null cursor when an incomplete page has no cursor", async () => {
  for (const missingCursor of [null, ""]) {
    const { captured, fetch: fetchMock } = mockFetch([
      Response.json(listPage([tweetData()], true, missingCursor)),
    ]);
    const client = new TwexApiClient(creds(), { baseUrl: BASE_URL, fetch: fetchMock });

    const page = await client.getListPostsPage("1001", FROM, TO, null);

    assertEquals(page.items.map((post) => post.externalId), ["987654321"]);
    assertEquals(page.nextCursor, null);
    assertEquals(page.complete, false);
    assertEquals(captured.length, 1);
  }
});

test("getListPostsPage skips undated tweets and falls back to created_at", async () => {
  const { fetch: fetchMock } = mockFetch([
    Response.json(listPage([
      tweetData({ tweet_id: "no-date", created_at_datetime: null, created_at: null }),
      tweetData({
        tweet_id: "fallback",
        created_at_datetime: null,
        created_at: new Date(FROM).toISOString(),
      }),
    ], false)),
  ]);
  const client = new TwexApiClient(creds(), { baseUrl: BASE_URL, fetch: fetchMock });

  const page = await client.getListPostsPage("1001", FROM, TO, null);

  assertEquals(page.items.map((post) => post.externalId), ["fallback"]);
  assertEquals(page.items[0]?.date, FROM);
  assertEquals(page.complete, true);
});

test("getListPostsPage maps missing users and non-numeric view counts safely", async () => {
  const { fetch: fetchMock } = mockFetch([
    Response.json(listPage([
      tweetData({ tweet_id: "views", view_count: "abc", user: null }),
    ], false)),
  ]);
  const client = new TwexApiClient(creds(), { baseUrl: BASE_URL, fetch: fetchMock });

  const page = await client.getListPostsPage("1001", FROM, TO, null);

  assertEquals(page.items, [{
    kind: "post",
    externalId: "views",
    platformId: null,
    date: FROM,
    text: "full text of the tweet",
    author: null,
    url: "https://x.com/i/web/status/views",
    replyCount: 2,
    repostCount: 1,
    likeCount: 7,
    viewCount: null,
  }]);
});

test("getChatMessagesPage posts one all-mode request with the full cookie and default PIN", async () => {
  const { captured, fetch: fetchMock } = mockFetch([
    Response.json(dmHistoryPage([messageData()], false)),
  ]);
  const client = new TwexApiClient(creds(), { baseUrl: BASE_URL, fetch: fetchMock });

  const page = await client.getChatMessagesPage("conv-abc", FROM, TO, null);

  assertEquals(captured.length, 1);
  assertEquals(captured[0].method, "POST");
  assertEquals(captured[0].url, `${BASE_URL}/v3/twitter/dm-history`);
  assertEquals(captured[0].body, {
    recipient: "conv-abc",
    cookie: COOKIE,
    pin: "1234",
    count: 200,
    all: true,
  });
  assert(
    captured[0].body !== null &&
      typeof captured[0].body === "object" &&
      "cookie" in captured[0].body &&
      captured[0].body.cookie !== AUTH_TOKEN &&
      !Object.hasOwn(captured[0].body, "authToken"),
    "DM history must use the full cookie without an authToken field",
  );
  assertEquals(page, {
    items: [{
      kind: "chat_message",
      externalId: "msg-1",
      platformId: "u-9",
      date: FROM,
      text: "hello",
      author: "u-9",
      url: null,
      reactions: [],
    }],
    nextCursor: null,
    complete: true,
  });
});

test("getChatMessagesPage passes an explicit PIN and before cursor", async () => {
  const { captured, fetch: fetchMock } = mockFetch([
    Response.json(dmHistoryPage([messageData()], false)),
  ]);
  const client = new TwexApiClient(creds({ pin: "7777" }), {
    baseUrl: BASE_URL,
    fetch: fetchMock,
  });

  await client.getChatMessagesPage("conv-abc", FROM, TO, "s-before");

  assertEquals(captured.length, 1);
  assertEquals((captured[0].body as Record<string, unknown>)["pin"], "7777");
  assertEquals((captured[0].body as Record<string, unknown>)["before"], "s-before");
  assertEquals((captured[0].body as Record<string, unknown>)["all"], true);
});

test("getChatMessagesPage retains out-of-window messages and completes only at the lower bound", async () => {
  const { captured, fetch: fetchMock } = mockFetch([
    Response.json(dmHistoryPage([
      messageData({ id: "m-new", time: new Date(TO + 1).toISOString(), sequence_id: "s1" }),
      messageData({ id: "m-old", time: new Date(FROM - 1).toISOString(), sequence_id: "s2" }),
    ], true)),
  ]);
  const client = new TwexApiClient(creds(), { baseUrl: BASE_URL, fetch: fetchMock });

  const page = await client.getChatMessagesPage("conv-abc", FROM, TO, null);

  assertEquals(captured.length, 1, "all-mode must not issue a hidden second request");
  assertEquals(page.items.map((message) => message.externalId), ["m-new", "m-old"]);
  assertEquals(page.nextCursor, null);
  assertEquals(page.complete, true);
});

test("getChatMessagesPage retains after-to messages without treating them as a boundary", async () => {
  const { captured, fetch: fetchMock } = mockFetch([
    Response.json(dmHistoryPage([
      messageData({ id: "m-future", time: new Date(TO + 1).toISOString(), sequence_id: "s1" }),
    ], true)),
  ]);
  const client = new TwexApiClient(creds(), { baseUrl: BASE_URL, fetch: fetchMock });

  const page = await client.getChatMessagesPage("conv-abc", FROM, TO, null);

  assertEquals(captured.length, 1, "all-mode must not issue a hidden second request");
  assertEquals(page.items.map((message) => message.externalId), ["m-future"]);
  assertEquals(page.nextCursor, "s1");
  assertEquals(page.complete, false);
});

test("getChatMessagesPage returns a cursor instead of looping when all-mode has more history", async () => {
  const { captured, fetch: fetchMock } = mockFetch([
    Response.json(dmHistoryPage([
      messageData({ id: "m1", time: new Date(FROM + 1000).toISOString(), sequence_id: "s1" }),
      messageData({ id: "m2", time: new Date(FROM + 2000).toISOString(), sequence_id: "s2" }),
    ], true)),
  ]);
  const client = new TwexApiClient(creds(), { baseUrl: BASE_URL, fetch: fetchMock });

  const page = await client.getChatMessagesPage("conv-abc", FROM, TO, null);

  assertEquals(captured.length, 1, "has_more must never cause a second provider request");
  assertEquals(page.items.map((message) => message.externalId), ["m1", "m2"]);
  assertEquals(page.nextCursor, "s1");
  assertEquals(page.complete, false);
});

test("getChatMessagesPage treats a null data payload as the end of history", async () => {
  const { captured, fetch: fetchMock } = mockFetch([
    Response.json(envelope(200, "ok", null)),
  ]);
  const client = new TwexApiClient(creds(), { baseUrl: BASE_URL, fetch: fetchMock });

  const page = await client.getChatMessagesPage("conv-abc", FROM, TO, null);

  assertEquals(captured.length, 1);
  assertEquals(page, { items: [], nextCursor: null, complete: true });
});

test("getChatMessagesPage returns items with a null cursor when more history has no sequence cursor", async () => {
  for (const sequenceId of [null, ""]) {
    const { captured, fetch: fetchMock } = mockFetch([
      Response.json(dmHistoryPage([
        messageData({ id: "m1", sequence_id: sequenceId, sender_id: "u" }),
      ], true)),
    ]);
    const client = new TwexApiClient(creds(), { baseUrl: BASE_URL, fetch: fetchMock });

    const page = await client.getChatMessagesPage("conv-abc", FROM, TO, null);

    assertEquals(page.items.map((message) => message.externalId), ["m1"]);
    assertEquals(page.nextCursor, null);
    assertEquals(page.complete, false);
    assertEquals(captured.length, 1);
  }
});

test("getChatMessagesPage accepts an exact conversation id match", async () => {
  const { captured, fetch: fetchMock } = mockFetch([
    Response.json(dmHistoryPage([messageData()], false)),
  ]);
  const client = new TwexApiClient(creds(), { baseUrl: BASE_URL, fetch: fetchMock });

  const page = await client.getChatMessagesPage("conv-abc", FROM, TO, null);

  assertEquals(captured.length, 1);
  assertEquals(page.items.map((message) => message.externalId), ["msg-1"]);
  assertEquals(page.nextCursor, null);
  assertEquals(page.complete, true);
  assertEquals(page.terminalReason, undefined);
});

test("getChatMessagesPage returns a terminal page on a mismatched conversation id", async () => {
  const { captured, fetch: fetchMock } = mockFetch([
    Response.json({
      code: 200,
      msg: "ok",
      data: {
        conversation_id: "conv-OTHER",
        has_more: false,
        messages: [messageData()],
      },
    }),
  ]);
  const client = new TwexApiClient(creds(), { baseUrl: BASE_URL, fetch: fetchMock });

  const page = await client.getChatMessagesPage("conv-abc", FROM, TO, null);

  assertEquals(captured.length, 1, "a mismatched conversation must not trigger a second request");
  assertEquals(page.items, [], "foreign messages must never be mapped or returned");
  assertEquals(page.nextCursor, null);
  assertEquals(page.complete, false);
  assertEquals(page.terminalReason, "mismatched_conversation");
});

test("TwexApiClient rejects invalid retrieval windows before any request", async () => {
  const { captured, fetch: fetchMock } = mockFetch([]);
  const client = new TwexApiClient(creds(), { baseUrl: BASE_URL, fetch: fetchMock });

  await assertRejects(
    () => client.getListPostsPage("1001", TO, FROM, null),
    "Twex retrieval window",
  );
  await assertRejects(
    () => client.getListPostsPage("1001", Number.NaN, TO, null),
    "finite epoch milliseconds",
  );
  await assertRejects(
    () => client.getChatMessagesPage("c1", TO, FROM, null),
    "Twex retrieval window",
  );
  assertEquals(captured.length, 0);
});

test("getListPostsPage and getChatMessagesPage propagate aborts without wrapping", async () => {
  const preAborted = new AbortController();
  preAborted.abort();
  const { captured, fetch: fetchMock } = mockFetch([]);
  const client = new TwexApiClient(creds(), { baseUrl: BASE_URL, fetch: fetchMock });

  const listError = await assertRejects(() =>
    client.getListPostsPage("1001", FROM, TO, null, preAborted.signal)
  );
  assert(listError instanceof DOMException);
  assertEquals(listError.name, "AbortError");

  const chatError = await assertRejects(() =>
    client.getChatMessagesPage("conv-abc", FROM, TO, null, preAborted.signal)
  );
  assert(chatError instanceof DOMException);
  assertEquals(chatError.name, "AbortError");
  assertEquals(captured.length, 0, "no request may be issued for an already aborted call");

  const midController = new AbortController();
  let callCount = 0;
  const abortingFetch: TwexFetch = (_input) => {
    callCount += 1;
    midController.abort();
    return Promise.reject(new DOMException("The operation was aborted", "AbortError"));
  };
  const midClient = new TwexApiClient(creds(), {
    baseUrl: BASE_URL,
    fetch: abortingFetch,
  });

  const midError = await assertRejects(() =>
    midClient.getListPostsPage("1001", FROM, TO, null, midController.signal)
  );
  assert(midError instanceof DOMException);
  assertEquals(midError.name, "AbortError");
  assertEquals(callCount, 1);
});

test("paid page methods keep decoded items when the signal aborts after a successful response", async () => {
  const listController = new AbortController();
  let listRequests = 0;
  const listFetch: TwexFetch = (_input) => {
    listRequests += 1;
    listController.abort();
    return Promise.resolve(Response.json(listPage([tweetData()], false)));
  };
  const listClient = new TwexApiClient(creds(), { baseUrl: BASE_URL, fetch: listFetch });

  const listResult = await listClient.getListPostsPage(
    "1001", FROM, TO, null, listController.signal,
  );

  assertEquals(listRequests, 1);
  assertEquals(listResult.items.map((post) => post.externalId), ["987654321"]);
  assertEquals(listResult.nextCursor, null);
  assertEquals(listResult.complete, true);

  const dmController = new AbortController();
  const dmFetch: TwexFetch = (_input) => {
    dmController.abort();
    return Promise.resolve(Response.json(dmHistoryPage([messageData()], false)));
  };
  const dmClient = new TwexApiClient(creds(), { baseUrl: BASE_URL, fetch: dmFetch });

  const dmResult = await dmClient.getChatMessagesPage(
    "conv-abc", FROM, TO, null, dmController.signal,
  );

  assertEquals(dmResult.items.map((message) => message.externalId), ["msg-1"]);
  assertEquals(dmResult.nextCursor, null);
  assertEquals(dmResult.complete, true);
});

test("paid page methods keep decoded items when the signal aborts during JSON completion", async () => {
  const listController = new AbortController();
  const listResponse = {
    ok: true,
    json: () => {
      listController.abort();
      return Promise.resolve(listPage([tweetData()], false));
    },
  } as unknown as Response;
  const { fetch: listFetch } = mockFetch([listResponse]);
  const listClient = new TwexApiClient(creds(), { baseUrl: BASE_URL, fetch: listFetch });

  const listResult = await listClient.getListPostsPage(
    "1001", FROM, TO, null, listController.signal,
  );

  assertEquals(listResult.items.map((post) => post.externalId), ["987654321"]);
  assertEquals(listResult.complete, true);

  const dmController = new AbortController();
  const dmResponse = {
    ok: true,
    json: () => {
      dmController.abort();
      return Promise.resolve(dmHistoryPage([messageData()], false));
    },
  } as unknown as Response;
  const { fetch: dmFetch } = mockFetch([dmResponse]);
  const dmClient = new TwexApiClient(creds(), { baseUrl: BASE_URL, fetch: dmFetch });

  const dmResult = await dmClient.getChatMessagesPage(
    "conv-abc", FROM, TO, null, dmController.signal,
  );

  assertEquals(dmResult.items.map((message) => message.externalId), ["msg-1"]);
  assertEquals(dmResult.complete, true);
});

test("paid page methods still propagate a body-read AbortError when no decoded body exists", async () => {
  const original = new DOMException("The operation was aborted", "AbortError");
  const listController = new AbortController();
  const listResponse = {
    ok: true,
    json: () => {
      listController.abort(original);
      return Promise.reject(original);
    },
  } as unknown as Response;
  const { fetch: listFetch } = mockFetch([listResponse]);
  const listClient = new TwexApiClient(creds(), { baseUrl: BASE_URL, fetch: listFetch });

  const listError = await assertRejects(() =>
    listClient.getListPostsPage("1001", FROM, TO, null, listController.signal)
  );
  assertStrictEquals(listError, original);

  const dmController = new AbortController();
  const dmResponse = {
    ok: true,
    json: () => {
      dmController.abort(original);
      return Promise.reject(original);
    },
  } as unknown as Response;
  const { fetch: dmFetch } = mockFetch([dmResponse]);
  const dmClient = new TwexApiClient(creds(), { baseUrl: BASE_URL, fetch: dmFetch });

  const dmError = await assertRejects(() =>
    dmClient.getChatMessagesPage("conv-abc", FROM, TO, null, dmController.signal)
  );
  assertStrictEquals(dmError, original);
});

test("non-content requests still abort after a successful response", async () => {
  const controller = new AbortController();
  const abortingFetch: TwexFetch = (_input) => {
    controller.abort();
    return Promise.resolve(Response.json(envelope(200, "ok", userInfoData())));
  };
  const client = new TwexApiClient(creds(), { baseUrl: BASE_URL, fetch: abortingFetch });

  const error = await assertRejects(() => client.getUserInfo(controller.signal));

  assert(error instanceof DOMException);
  assertEquals(error.name, "AbortError");
});
