import { test } from "bun:test";
import { assertEquals, assertRejects, assertThrows } from "./assertions.ts";
import {
  SubstackSessionClient,
  SubstackSessionUpstreamError,
  validateSessionCookieValue,
} from "../src/connectors/substack/session-client.ts";

const credentials = { substackSessionId: "s%3Aprimary.signature" };

test("session client validates a session without leaking credentials", async () => {
  const requests: Request[] = [];
  const client = new SubstackSessionClient(credentials, (input, init) => {
    const request = new Request(input, init);
    requests.push(request);
    return Promise.resolve(
      new Response(JSON.stringify({
        userSettings: [{ user_id: 42, type: "reader_mode", value_bool: true }],
        qualifies_for_badge: false,
      })),
    );
  });
  assertEquals(await client.validateSession(), { userId: 42 });
  assertEquals(requests[0].url, "https://substack.com/api/v1/user-settings");
  assertEquals(requests[0].redirect, "manual");
  assertEquals(
    requests[0].headers.get("cookie"),
    "substack.sid=s%3Aprimary.signature",
  );
});

test("session client accepts the documented snake-case settings alias", async () => {
  const client = new SubstackSessionClient(
    credentials,
    () =>
      Promise.resolve(
        new Response(JSON.stringify({
          user_settings: [{ user_id: 43 }],
        })),
      ),
  );
  assertEquals(await client.validateSession(), { userId: 43 });
});

test("session client sends an optional compatibility cookie only to substack.com", async () => {
  const requests: Request[] = [];
  const client = new SubstackSessionClient({
    ...credentials,
    connectSessionId: "s%3Acompat.signature",
  }, (input, init) => {
    requests.push(new Request(input, init));
    return Promise.resolve(
      new Response(JSON.stringify({
        post: {
          id: 7,
          publication_id: 9,
          body_html: "<p>Full body</p>",
        },
      })),
    );
  });
  const post = await client.getPostById(7);
  assertEquals(post?.bodyHtml, "<p>Full body</p>");
  assertEquals(post?.hasPaidSubscription, false);
  assertEquals(requests[0].url, "https://substack.com/api/v1/posts/by-id/7");
  assertEquals(
    requests[0].headers.get("cookie"),
    "substack.sid=s%3Aprimary.signature; connect.sid=s%3Acompat.signature",
  );
});

test("session client reads paid entitlement conservatively from the response envelope", async () => {
  const membershipStates: unknown[] = [
    "free_signup",
    "paid_subscriber",
    "unknown_state",
    undefined,
  ];
  const results = [];
  for (const membershipState of membershipStates) {
    const subscription = membershipState === undefined
      ? {}
      : { membership_state: membershipState };
    const client = new SubstackSessionClient(
      credentials,
      () =>
        Promise.resolve(
          new Response(JSON.stringify({
            post: {
              id: 7,
              publication_id: 9,
              body_html: "<p>Teaser body</p>",
              audience: "only_paid",
            },
            subscription,
          })),
        ),
    );
    results.push((await client.getPostById(7))?.hasPaidSubscription);
  }
  assertEquals(results, [false, true, false, false]);
});

test("session client lists subscribed publications across pages", async () => {
  const requests: Request[] = [];
  const responses = [
    {
      publications: [
        {
          id: 9,
          name: "Unsubscribed",
          subdomain: "unsubscribed",
          custom_domain: null,
        },
        {
          id: 7,
          name: "First",
          subdomain: "first",
          custom_domain: "first.example.com",
        },
        {
          id: 5,
          name: "Second",
          subdomain: "second",
          custom_domain: null,
        },
      ],
      subscriptions: [{ publication_id: 5 }, { publication_id: 7 }],
      nextCursor: "next page/+",
    },
    {
      publications: [
        {
          id: 7,
          name: "Duplicate",
          subdomain: "duplicate",
          custom_domain: null,
        },
        {
          id: 3,
          name: "Third",
          subdomain: "third",
          custom_domain: null,
        },
      ],
      subscriptions: [{ publication_id: 7 }, { publication_id: 3 }],
    },
  ];
  const consoleOutput: unknown[][] = [];
  const originalConsole = {
    debug: console.debug,
    error: console.error,
    info: console.info,
    log: console.log,
    warn: console.warn,
  };
  const captureConsole = (...args: unknown[]) => {
    consoleOutput.push(args);
  };
  console.debug = captureConsole;
  console.error = captureConsole;
  console.info = captureConsole;
  console.log = captureConsole;
  console.warn = captureConsole;
  const client = new SubstackSessionClient(credentials, (input, init) => {
    requests.push(new Request(input, init));
    return Promise.resolve(
      new Response(JSON.stringify(responses[requests.length - 1])),
    );
  });

  let publications;
  try {
    publications = await client.listSubscribedPublications();
  } finally {
    console.debug = originalConsole.debug;
    console.error = originalConsole.error;
    console.info = originalConsole.info;
    console.log = originalConsole.log;
    console.warn = originalConsole.warn;
  }
  assertEquals(publications, [
    {
      id: 7,
      name: "First",
      subdomain: "first",
      customDomain: "first.example.com",
    },
    {
      id: 5,
      name: "Second",
      subdomain: "second",
      customDomain: null,
    },
    {
      id: 3,
      name: "Third",
      subdomain: "third",
      customDomain: null,
    },
  ]);
  assertEquals(
    requests.map((request) => request.url),
    [
      "https://substack.com/api/v1/subscriptions/page_v2",
      "https://substack.com/api/v1/subscriptions/page_v2?cursor=next+page%2F%2B",
    ],
  );
  assertEquals(
    requests.map((request) => request.headers.get("cookie")),
    [
      "substack.sid=s%3Aprimary.signature",
      "substack.sid=s%3Aprimary.signature",
    ],
  );
  assertEquals(
    consoleOutput.some((args) =>
      args.some((value) =>
        String(value).includes(credentials.substackSessionId)
      )
    ),
    false,
  );
  for (const request of requests) {
    assertEquals(request.url.includes(credentials.substackSessionId), false);
    for (const [name, value] of request.headers) {
      if (name !== "cookie") {
        assertEquals(value.includes(credentials.substackSessionId), false);
      }
    }
    assertEquals(
      request.headers.get("cookie"),
      `substack.sid=${credentials.substackSessionId}`,
    );
    assertEquals(
      [...request.headers].filter(([, value]) =>
        value.includes(credentials.substackSessionId)
      ).map(([name]) => name),
      ["cookie"],
    );
  }
});

test("session client accepts empty subscription pages", async () => {
  const client = new SubstackSessionClient(
    credentials,
    () =>
      Promise.resolve(
        new Response(JSON.stringify({ publications: [], subscriptions: [] })),
      ),
  );
  assertEquals(await client.listSubscribedPublications(), []);
});

test("session client rejects repeated subscription page cursors", async () => {
  let requestCount = 0;
  const client = new SubstackSessionClient(credentials, () => {
    requestCount++;
    return Promise.resolve(
      new Response(JSON.stringify({
        publications: [],
        subscriptions: [],
        nextCursor: "repeated",
      })),
    );
  });
  await assertRejects(
    () => client.listSubscribedPublications(),
    SubstackSessionUpstreamError,
    "repeated pagination cursor",
  );
  assertEquals(requestCount, 2);
});

test("session client rejects invalid subscription page containers", async () => {
  for (
    const body of [
      null,
      [],
      {},
      { publications: {}, subscriptions: [] },
      { publications: [], subscriptions: {} },
      { publications: [], subscriptions: [], nextCursor: 1 },
    ]
  ) {
    const client = new SubstackSessionClient(
      credentials,
      () => Promise.resolve(new Response(JSON.stringify(body))),
    );
    await assertRejects(
      () => client.listSubscribedPublications(),
      SubstackSessionUpstreamError,
      "invalid response",
    );
  }
});

test("session client skips malformed subscription and publication leaves", async () => {
  const client = new SubstackSessionClient(
    credentials,
    () =>
      Promise.resolve(
        new Response(JSON.stringify({
          publications: [
            null,
            { id: "1" },
            {
              id: 1,
              name: "Valid",
              subdomain: "valid",
              custom_domain: null,
            },
            {
              id: 2,
              name: 2,
              subdomain: "invalid",
              custom_domain: null,
            },
          ],
          subscriptions: [null, {}, { publication_id: "1" }, {
            publication_id: 1,
          }],
        })),
      ),
  );
  assertEquals(await client.listSubscribedPublications(), [{
    id: 1,
    name: "Valid",
    subdomain: "valid",
    customDomain: null,
  }]);
});

test("session client propagates subscription request aborts", async () => {
  const controller = new AbortController();
  const abortError = new DOMException("cancelled", "AbortError");
  const client = new SubstackSessionClient(credentials, (_input, init) => {
    controller.abort();
    assertEquals(init?.signal, controller.signal);
    return Promise.reject(abortError);
  });
  const error = await assertRejects(
    () => client.listSubscribedPublications(controller.signal),
    DOMException,
    "cancelled",
  );
  assertEquals(error, abortError);
});

test("session client maps response body stream failures to upstream errors", async () => {
  const bodyError = new Error("private stream failure");
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      controller.error(bodyError);
    },
  });
  const client = new SubstackSessionClient(
    credentials,
    () => Promise.resolve(new Response(body)),
  );

  const error = await assertRejects(
    () => client.listSubscribedPublications(),
    SubstackSessionUpstreamError,
    "Substack response body could not be read",
  );
  assertEquals(error.message.includes(bodyError.message), false);
});

test("session client maps oversized response bodies to upstream errors", async () => {
  const body = new Uint8Array(5 * 1024 * 1024 + 1);
  const client = new SubstackSessionClient(
    credentials,
    () => Promise.resolve(new Response(body)),
  );

  await assertRejects(
    () => client.listSubscribedPublications(),
    SubstackSessionUpstreamError,
    "Substack response body could not be read",
  );
});

test("session client preserves abort reasons during response reading", async () => {
  const controller = new AbortController();
  const abortReason = new Error("stop response reading");
  const body = new ReadableStream<Uint8Array>({
    start(streamController) {
      streamController.enqueue(new TextEncoder().encode('{"publications":'));
    },
    pull() {
      controller.abort(abortReason);
      return new Promise<void>(() => {});
    },
  });
  const client = new SubstackSessionClient(
    credentials,
    () => Promise.resolve(new Response(body)),
  );

  const error = await assertRejects(
    () => client.listSubscribedPublications(controller.signal),
    Error,
    abortReason.message,
  );
  assertEquals(error, abortReason);
});

test("session client rejects redirects and expired sessions safely", async () => {
  const secret = "s%3Asecret.signature";
  const secretCredentials = { substackSessionId: secret };
  const redirected = new SubstackSessionClient(
    secretCredentials,
    () =>
      Promise.resolve(
        new Response(null, {
          status: 302,
          headers: { location: "https://attacker.example/steal" },
        }),
      ),
  );
  await assertRejects(
    () => redirected.validateSession(),
    Error,
    "unexpected redirect",
  );

  const expired = new SubstackSessionClient(
    secretCredentials,
    () =>
      Promise.resolve(new Response("private upstream body", { status: 401 })),
  );
  const error = await assertRejects(
    () => expired.validateSession(),
    Error,
    "Substack session expired; reconnect required",
  );
  assertEquals(error.message.includes(secret), false);
  assertEquals(error.message.includes("private upstream body"), false);
});

test("session client distinguishes upstream failures from expired sessions", async () => {
  const client = new SubstackSessionClient(
    credentials,
    () => Promise.resolve(new Response(null, { status: 403 })),
  );
  await assertRejects(
    () => client.validateSession(),
    SubstackSessionUpstreamError,
    "Substack request failed with status 403",
  );
});

test("session client maps unavailable posts to null", async () => {
  for (const status of [403, 404]) {
    const client = new SubstackSessionClient(
      credentials,
      () => Promise.resolve(new Response(null, { status })),
    );
    assertEquals(await client.getPostById(7), null);
  }
});

test("session client rejects malformed credentials and responses", async () => {
  for (
    const value of [
      "",
      "space value",
      'quoted"value',
      "semi;colon",
      "line\nbreak",
      "x".repeat(4097),
    ]
  ) {
    assertThrows(() => validateSessionCookieValue(value));
  }
  assertEquals(
    validateSessionCookieValue("s%3Avalid.signature"),
    "s%3Avalid.signature",
  );
  const client = new SubstackSessionClient(
    credentials,
    () => Promise.resolve(new Response(JSON.stringify({ post: { id: "7" } }))),
  );
  await assertRejects(() => client.getPostById(7), Error, "invalid response");
  await assertRejects(() => client.getPostById(0), Error, "positive integer");
});
