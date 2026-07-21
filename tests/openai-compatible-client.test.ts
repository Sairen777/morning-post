import {
  assertEquals,
  assertRejects,
  assertStrictEquals,
} from "@std/assert";
import {
  ModelApiError,
  OpenAICompatibleChatClient,
} from "../src/summarizers/openai-compatible-client.ts";

function createClient(): OpenAICompatibleChatClient {
  return new OpenAICompatibleChatClient(
    { model: "test-model", baseUrl: "http://localhost" },
    { retryBaseDelayMs: 0 },
  );
}

function completionResponse(content: string): Response {
  return Response.json({ choices: [{ message: { content } }] });
}

Deno.test("OpenAICompatibleChatClient retries a fetch TypeError and succeeds", async () => {
  const originalFetch = globalThis.fetch;
  let attemptCount = 0;
  globalThis.fetch = () => {
    attemptCount++;
    if (attemptCount === 1) {
      return Promise.reject(new TypeError("connection reset"));
    }
    return Promise.resolve(completionResponse("recovered"));
  };

  try {
    assertEquals(await createClient().complete("system", "content"), "recovered");
    assertEquals(attemptCount, 2);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

Deno.test("OpenAICompatibleChatClient retries a response body TypeError and succeeds", async () => {
  const originalFetch = globalThis.fetch;
  let attemptCount = 0;
  globalThis.fetch = () => {
    attemptCount++;
    if (attemptCount === 1) {
      return Promise.resolve({
        ok: true,
        json: () => Promise.reject(new TypeError("body disconnected")),
      } as Response);
    }
    return Promise.resolve(completionResponse("recovered body"));
  };

  try {
    assertEquals(
      await createClient().complete("system", "content"),
      "recovered body",
    );
    assertEquals(attemptCount, 2);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

Deno.test("OpenAICompatibleChatClient exhausts three transport attempts with the final error", async () => {
  const originalFetch = globalThis.fetch;
  const transportErrors = [
    new TypeError("first disconnect"),
    new TypeError("second disconnect"),
    new TypeError("final disconnect"),
  ];
  let attemptCount = 0;
  globalThis.fetch = () => Promise.reject(transportErrors[attemptCount++]);

  try {
    const thrownError = await assertRejects(() =>
      createClient().complete("system", "content")
    );
    assertStrictEquals(thrownError, transportErrors[2]);
    assertEquals(attemptCount, 3);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

Deno.test("OpenAICompatibleChatClient retries an internal deadline with a fresh deadline", async () => {
  const originalFetch = globalThis.fetch;
  let attemptCount = 0;
  globalThis.fetch = (_input, init) => {
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

  try {
    assertEquals(
      await createClient().complete("system", "content", {
        requestTimeoutMs: 1,
      }),
      "after timeout",
    );
    assertEquals(attemptCount, 2);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

Deno.test("OpenAICompatibleChatClient exhausts three internal deadlines", async () => {
  const originalFetch = globalThis.fetch;
  let attemptCount = 0;
  globalThis.fetch = (_input, init) => {
    attemptCount++;
    return new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener(
        "abort",
        () => reject(init.signal!.reason),
        { once: true },
      );
    });
  };

  try {
    const thrownError = await assertRejects(() =>
      createClient().complete("system", "content", { requestTimeoutMs: 1 })
    );
    assertEquals((thrownError as DOMException).name, "TimeoutError");
    assertEquals(attemptCount, 3);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

Deno.test("OpenAICompatibleChatClient does not retry a parent abort", async () => {
  const originalFetch = globalThis.fetch;
  const controller = new AbortController();
  const parentReason = new DOMException("caller stopped", "AbortError");
  let attemptCount = 0;
  globalThis.fetch = (_input, init) => {
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

  try {
    const thrownError = await assertRejects(() =>
      createClient().complete("system", "content", {
        signal: controller.signal,
        requestTimeoutMs: 50,
      })
    );
    assertStrictEquals(thrownError, parentReason);
    assertEquals(attemptCount, 1);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
for (const status of [429, 503]) {
  Deno.test(`OpenAICompatibleChatClient retries HTTP ${status}`, async () => {
    const originalFetch = globalThis.fetch;
    let attemptCount = 0;
    globalThis.fetch = () => {
      attemptCount++;
      if (attemptCount === 1) {
        return Promise.resolve(new Response("busy", { status }));
      }
      return Promise.resolve(completionResponse("recovered HTTP"));
    };

    try {
      assertEquals(
        await createClient().complete("system", "content"),
        "recovered HTTP",
      );
      assertEquals(attemptCount, 2);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
}

Deno.test("OpenAICompatibleChatClient does not retry a nonretryable HTTP status", async () => {
  const originalFetch = globalThis.fetch;
  let attemptCount = 0;
  globalThis.fetch = () => {
    attemptCount++;
    return Promise.resolve(new Response("bad request", { status: 400 }));
  };

  try {
    const thrownError = await assertRejects(() =>
      createClient().complete("system", "content")
    );
    if (!(thrownError instanceof ModelApiError)) {
      throw new Error("Expected ModelApiError");
    }
    assertEquals(thrownError.status, 400);
    assertEquals(attemptCount, 1);
  } finally {
    globalThis.fetch = originalFetch;
  }
});


Deno.test("OpenAICompatibleChatClient does not retry malformed JSON", async () => {
  const originalFetch = globalThis.fetch;
  let attemptCount = 0;
  globalThis.fetch = () => {
    attemptCount++;
    return Promise.resolve(
      new Response("not JSON", {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );
  };

  try {
    await assertRejects(
      () => createClient().complete("system", "content"),
      SyntaxError,
    );
    assertEquals(attemptCount, 1);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
