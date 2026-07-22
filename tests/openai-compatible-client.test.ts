import { test } from "bun:test";
import {
  assertEquals,
  assertRejects,
  assertStrictEquals,
} from "./assertions.ts";
import {
  ModelApiError,
  OpenAICompatibleChatClient,
} from "../src/summarizers/openai-compatible-client.ts";
import type { FetchFunction } from "../src/summarizers/openai-compatible-client.ts";

function createClient(fetch?: FetchFunction): OpenAICompatibleChatClient {
  return new OpenAICompatibleChatClient(
    { model: "test-model", baseUrl: "http://localhost" },
    { retryBaseDelayMs: 0, fetch },
  );
}

function completionResponse(content: string): Response {
  return Response.json({ choices: [{ message: { content } }] });
}

test("OpenAICompatibleChatClient retries a fetch TypeError and succeeds", async () => {
  let attemptCount = 0;
  const mockFetch: FetchFunction = () => {
    attemptCount++;
    if (attemptCount === 1) {
      return Promise.reject(new TypeError("connection reset"));
    }
    return Promise.resolve(completionResponse("recovered"));
  };
  assertEquals(await createClient(mockFetch).complete("system", "content"), "recovered");
  assertEquals(attemptCount, 2);
});

test("OpenAICompatibleChatClient retries a response body TypeError and succeeds", async () => {
  let attemptCount = 0;
  const mockFetch: FetchFunction = () => {
    attemptCount++;
    if (attemptCount === 1) {
      return Promise.resolve({
        ok: true,
        json: () => Promise.reject(new TypeError("body disconnected")),
      } as Response);
    }
    return Promise.resolve(completionResponse("recovered body"));
  };
  assertEquals(
    await createClient(mockFetch).complete("system", "content"),
    "recovered body",
  );
  assertEquals(attemptCount, 2);
});

test("OpenAICompatibleChatClient exhausts three transport attempts with the final error", async () => {
  const transportErrors = [
    new TypeError("first disconnect"),
    new TypeError("second disconnect"),
    new TypeError("final disconnect"),
  ];
  let attemptCount = 0;
  const mockFetch: FetchFunction = () => Promise.reject(transportErrors[attemptCount++]);
  const thrownError = await assertRejects(() =>
    createClient(mockFetch).complete("system", "content")
  );
  assertStrictEquals(thrownError, transportErrors[2]);
  assertEquals(attemptCount, 3);
});

test("OpenAICompatibleChatClient retries an internal deadline with a fresh deadline", async () => {
  let attemptCount = 0;
  const mockFetch: FetchFunction = (_input, init) => {
    attemptCount++;
    if (attemptCount > 1) {
      return Promise.resolve(completionResponse("after timeout"));
    }
    return new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener(
        "abort",
        () => reject(init.signal!.reason),
        { once: true },
      );
    });
  };
  assertEquals(
    await createClient(mockFetch).complete("system", "content", {
      requestTimeoutMs: 1,
    }),
    "after timeout",
  );
  assertEquals(attemptCount, 2);
});

test("OpenAICompatibleChatClient exhausts three internal deadlines", async () => {
  let attemptCount = 0;
  const mockFetch: FetchFunction = (_input, init) => {
    attemptCount++;
    return new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener(
        "abort",
        () => reject(init.signal!.reason),
        { once: true },
      );
    });
  };
  const thrownError = await assertRejects(() =>
    createClient(mockFetch).complete("system", "content", { requestTimeoutMs: 1 })
  );
  assertEquals((thrownError as DOMException).name, "TimeoutError");
  assertEquals(attemptCount, 3);
});

test("OpenAICompatibleChatClient does not retry a parent abort", async () => {
  const controller = new AbortController();
  const parentReason = new DOMException("caller stopped", "AbortError");
  let attemptCount = 0;
  const mockFetch: FetchFunction = (_input, init) => {
    attemptCount++;
    return new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener(
        "abort",
        () => reject(new TypeError("fetch interrupted")),
        { once: true },
      );
      controller.abort(parentReason);
    });
  };
  const thrownError = await assertRejects(() =>
    createClient(mockFetch).complete("system", "content", {
      signal: controller.signal,
      requestTimeoutMs: 50,
    })
  );
  assertStrictEquals(thrownError, parentReason);
  assertEquals(attemptCount, 1);
});

for (const status of [429, 503]) {
  test(`OpenAICompatibleChatClient retries HTTP ${status}`, async () => {
    let attemptCount = 0;
    const mockFetch: FetchFunction = () => {
      attemptCount++;
      if (attemptCount === 1) {
        return Promise.resolve(new Response("busy", { status }));
      }
      return Promise.resolve(completionResponse("recovered HTTP"));
    };
    assertEquals(
      await createClient(mockFetch).complete("system", "content"),
      "recovered HTTP",
    );
    assertEquals(attemptCount, 2);
  });
}

test("OpenAICompatibleChatClient does not retry a nonretryable HTTP status", async () => {
  let attemptCount = 0;
  const mockFetch: FetchFunction = () => {
    attemptCount++;
    return Promise.resolve(new Response("bad request", { status: 400 }));
  };
  const thrownError = await assertRejects(() =>
    createClient(mockFetch).complete("system", "content")
  );
  if (!(thrownError instanceof ModelApiError)) {
    throw new Error("Expected ModelApiError");
  }
  assertEquals(thrownError.status, 400);
  assertEquals(attemptCount, 1);
});

test("OpenAICompatibleChatClient does not retry malformed JSON", async () => {
  let attemptCount = 0;
  const mockFetch: FetchFunction = () => {
    attemptCount++;
    return Promise.resolve(
      new Response("not JSON", {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );
  };
  await assertRejects(
    () => createClient(mockFetch).complete("system", "content"),
    SyntaxError,
  );
  assertEquals(attemptCount, 1);
});
