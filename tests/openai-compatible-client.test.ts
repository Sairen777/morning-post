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
import type {
  FetchFunction,
  ModelAttemptTelemetry,
} from "../src/summarizers/openai-compatible-client.ts";

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
  assertEquals(
    await createClient(mockFetch).complete("system", "content"),
    "recovered",
  );
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
  const mockFetch: FetchFunction = () =>
    Promise.reject(transportErrors[attemptCount++]);
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
    createClient(mockFetch).complete("system", "content", {
      requestTimeoutMs: 1,
    })
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

test("malformed completion roots emit one failed attempt before the safe error", async () => {
  for (const body of [null, [], "scalar", 42, true, {}]) {
    const telemetry: ModelAttemptTelemetry[] = [];
    const error = await assertRejects(
      () =>
        createClient(() => Promise.resolve(Response.json(body))).complete(
          "system",
          "content",
          {
            onAttempt: (attempt) => {
              telemetry.push(attempt);
            },
          },
        ),
      ModelApiError,
      "Model API: malformed completion",
    );
    assertEquals((error as ModelApiError).status, 0);
    assertEquals(telemetry.length, 1);
    assertEquals(
      { attempt: telemetry[0].attempt, status: telemetry[0].status },
      { attempt: 1, status: "failure" },
    );
  }
});

test("missing choices emit one failed attempt before the safe error", async () => {
  const telemetry: ModelAttemptTelemetry[] = [];
  await assertRejects(
    () =>
      createClient(() => Promise.resolve(Response.json({ usage: {} })))
        .complete("system", "content", {
          onAttempt: (attempt) => {
            telemetry.push(attempt);
          },
        }),
    ModelApiError,
    "Model API: malformed completion",
  );
  assertEquals(telemetry.length, 1);
  assertEquals(telemetry[0].status, "failure");
});

test("malformed completion retains valid provider usage on the failed attempt", async () => {
  const telemetry: ModelAttemptTelemetry[] = [];
  await assertRejects(
    () =>
      createClient(() =>
        Promise.resolve(Response.json({
          usage: { prompt_tokens: 9, completion_tokens: 4, total_tokens: 13 },
        }))
      ).complete("system", "content", {
        onAttempt: (attempt) => {
          telemetry.push(attempt);
        },
      }),
    ModelApiError,
    "Model API: malformed completion",
  );
  assertEquals(telemetry, [{
    attempt: 1,
    durationMs: telemetry[0].durationMs,
    status: "failure",
    usage: { promptTokens: 9, completionTokens: 4, totalTokens: 13 },
  }]);
});

test("attempt telemetry covers retries, usage, and duration without content", async () => {
  let calls = 0;
  const telemetry: ModelAttemptTelemetry[] = [];
  const client = createClient(() => {
    calls++;
    if (calls === 1) {
      return Promise.resolve(new Response("busy", { status: 503 }));
    }
    return Promise.resolve(Response.json({
      choices: [{ message: { content: "secret output" } }],
      usage: { prompt_tokens: 11, completion_tokens: 7, total_tokens: 18 },
    }));
  });
  assertEquals(
    await client.complete("secret prompt", "secret content", {
      onAttempt: (attempt) => {
        telemetry.push(attempt);
      },
    }),
    "secret output",
  );
  assertEquals(telemetry, [
    { attempt: 1, durationMs: telemetry[0].durationMs, status: "retry" },
    {
      attempt: 2,
      durationMs: telemetry[1].durationMs,
      status: "success",
      usage: { promptTokens: 11, completionTokens: 7, totalTokens: 18 },
    },
  ]);
  assertEquals(
    telemetry.every((attempt) =>
      typeof attempt.durationMs === "number" &&
      (attempt.durationMs as number) >= 0
    ),
    true,
  );
  assertEquals(JSON.stringify(telemetry).includes("secret"), false);
});

test("attempt telemetry omits absent and malformed usage", async () => {
  for (
    const usage of [
      undefined,
      { prompt_tokens: -1, completion_tokens: 2, total_tokens: 1 },
      { prompt_tokens: 1, completion_tokens: "2", total_tokens: 3 },
      { prompt_tokens: 1.5, completion_tokens: 2, total_tokens: 3.5 },
      { prompt_tokens: 1, completion_tokens: 2, total_tokens: 4 },
      {
        prompt_tokens: Number.MAX_SAFE_INTEGER,
        completion_tokens: 1,
        total_tokens: Number.MAX_SAFE_INTEGER + 1,
      },
    ]
  ) {
    const telemetry: ModelAttemptTelemetry[] = [];
    await createClient(() =>
      Promise.resolve(Response.json({
        choices: [{ message: { content: "ok" } }],
        ...(usage !== undefined && { usage }),
      }))
    ).complete("system", "content", {
      onAttempt: (attempt) => {
        telemetry.push(attempt);
      },
    });
    assertEquals(telemetry[0].usage, undefined);
  }
});

test("attempt telemetry reports terminal transport and HTTP failures", async () => {
  const transport: ModelAttemptTelemetry[] = [];
  await assertRejects(() =>
    createClient(() => Promise.reject(new TypeError("offline"))).complete(
      "system",
      "content",
      {
        onAttempt: (attempt) => {
          transport.push(attempt);
        },
      },
    )
  );
  assertEquals(transport.map(({ attempt, status }) => ({ attempt, status })), [
    { attempt: 1, status: "retry" },
    { attempt: 2, status: "retry" },
    { attempt: 3, status: "failure" },
  ]);
  const http: ModelAttemptTelemetry[] = [];
  await assertRejects(() =>
    createClient(() => Promise.resolve(new Response("bad", { status: 400 })))
      .complete("system", "content", {
        onAttempt: (attempt) => {
          http.push(attempt);
        },
      })
  );
  assertEquals(http.map(({ attempt, status }) => ({ attempt, status })), [
    { attempt: 1, status: "failure" },
  ]);
});

test("attempt callback exceptions and rejections are isolated", async () => {
  assertEquals(
    await createClient(() => Promise.resolve(completionResponse("ok")))
      .complete(
        "system",
        "content",
        {
          onAttempt: () => {
            throw new Error("telemetry unavailable");
          },
        },
      ),
    "ok",
  );
  assertEquals(
    await createClient(() => Promise.resolve(completionResponse("ok")))
      .complete(
        "system",
        "content",
        { onAttempt: () => Promise.reject(new Error("telemetry unavailable")) },
      ),
    "ok",
  );
});
