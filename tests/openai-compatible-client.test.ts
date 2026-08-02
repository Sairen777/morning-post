import { test } from "bun:test";
import {
  assert,
  assertEquals,
  assertRejects,
  assertStrictEquals,
  assertStringIncludes,
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

test("OpenAICompatibleChatClient completes a basic OpenAI-compatible request", async () => {
  let capturedBody: string | undefined;
  const client = createClient((_input, init) => {
    capturedBody = typeof init?.body === "string" ? init.body : undefined;
    return Promise.resolve(Response.json({
      choices: [{
        finish_reason: "stop",
        message: { content: '[{"t":"basic summary","i":0}]' },
      }],
    }));
  });
  const result = await client.complete("system rules", "[0] source", {
    maxOutputTokens: 4_000,
    maxAttempts: 2,
    jsonOutput: true,
  });
  assertEquals(result, '[{"t":"basic summary","i":0}]');
  const request: unknown = JSON.parse(capturedBody ?? "");
  assert(
    request !== null &&
      typeof request === "object" &&
      "model" in request &&
      request.model === "test-model" &&
      "max_tokens" in request &&
      request.max_tokens === 4_000 &&
      "response_format" in request,
    "basic completion request must retain model and structured-output limits",
  );
});

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

test("OpenAICompatibleChatClient retries ECONNRESET and records attempt telemetry", async () => {
  const resetError = Object.assign(new Error("transport reset"), {
    code: "ECONNRESET",
  });
  const telemetry: ModelAttemptTelemetry[] = [];
  let attemptCount = 0;
  const result = await createClient(() => {
    attemptCount++;
    return attemptCount === 1
      ? Promise.reject(resetError)
      : Promise.resolve(completionResponse("recovered from reset"));
  }).complete("system", "content", {
    maxAttempts: 2,
    onAttempt: (attempt) => {
      telemetry.push(attempt);
    },
  });

  assertEquals(result, "recovered from reset");
  assertEquals(attemptCount, 2);
  assertEquals(
    telemetry.map(({ attempt, status }) => ({ attempt, status })),
    [
      { attempt: 1, status: "retry" },
      { attempt: 2, status: "success" },
    ],
  );
});

test("OpenAICompatibleChatClient exhausts bounded ECONNRESET attempts with the final error", async () => {
  const resetErrors = [
    Object.assign(new Error("first reset"), { code: "ECONNRESET" }),
    Object.assign(new Error("final reset"), { code: "ECONNRESET" }),
  ];
  const telemetry: ModelAttemptTelemetry[] = [];
  let attemptCount = 0;
  const thrownError = await assertRejects(() =>
    createClient(() => Promise.reject(resetErrors[attemptCount++])).complete(
      "system",
      "content",
      {
        maxAttempts: 2,
        onAttempt: (attempt) => {
          telemetry.push(attempt);
        },
      },
    )
  );

  assertStrictEquals(thrownError, resetErrors[1]);
  assertEquals(attemptCount, 2);
  assertEquals(
    telemetry.map(({ attempt, status }) => ({ attempt, status })),
    [
      { attempt: 1, status: "retry" },
      { attempt: 2, status: "failure" },
    ],
  );
});

test("OpenAICompatibleChatClient does not retry a non-reset Error", async () => {
  const nonResetError = Object.assign(new Error("transport failed"), {
    code: "EOTHER",
  });
  const telemetry: ModelAttemptTelemetry[] = [];
  let attemptCount = 0;
  const thrownError = await assertRejects(() =>
    createClient(() => {
      attemptCount++;
      return Promise.reject(nonResetError);
    }).complete("system", "content", {
      maxAttempts: 3,
      onAttempt: (attempt) => {
        telemetry.push(attempt);
      },
    })
  );

  assertStrictEquals(thrownError, nonResetError);
  assertEquals(attemptCount, 1);
  assertEquals(
    telemetry.map(({ attempt, status }) => ({ attempt, status })),
    [{ attempt: 1, status: "failure" }],
  );
});

test("OpenAICompatibleChatClient beforeAttempt throws on retry and fetch count remains one", async () => {
  const gateError = new Error("credential fence revoked");
  const telemetry: ModelAttemptTelemetry[] = [];
  let attemptCount = 0;
  let gateCalls = 0;
  const thrownError = await assertRejects(() =>
    createClient(() => {
      attemptCount++;
      return Promise.reject(new TypeError("transport reset"));
    }).complete("system", "content", {
      maxAttempts: 3,
      onAttempt: (attempt) => {
        telemetry.push(attempt);
      },
      beforeAttempt: () => {
        gateCalls++;
        if (gateCalls > 1) throw gateError;
      },
    })
  );

  // The gate runs before the first attempt, passes, and runs again before the
  // retry, where its throw aborts the request before any second fetch.
  assertStrictEquals(thrownError, gateError);
  assertEquals(gateCalls, 2);
  assertEquals(attemptCount, 1);
  assertEquals(
    telemetry.map(({ attempt, status }) => ({ attempt, status })),
    [{ attempt: 1, status: "retry" }],
  );
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

test("OpenAICompatibleChatClient retries an empty stop completion and succeeds", async () => {
  let attemptCount = 0;
  const telemetry: ModelAttemptTelemetry[] = [];
  const mockFetch: FetchFunction = () => {
    attemptCount++;
    return Promise.resolve(attemptCount === 1
      ? Response.json({
        choices: [{
          finish_reason: "stop",
          message: { content: "", refusal: null },
        }],
        usage: {
          prompt_tokens: 10,
          completion_tokens: 1,
          total_tokens: 11,
        },
      })
      : completionResponse('[{"t":"recovered","i":0}]'));
  };
  const result = await createClient(mockFetch).complete("system", "content", {
    maxAttempts: 2,
    maxOutputTokens: 4_000,
    jsonOutput: true,
    onAttempt: (attempt) => {
      telemetry.push(attempt);
    },
  });
  assertEquals(result, '[{"t":"recovered","i":0}]');
  assertEquals(attemptCount, 2);
  assertEquals(telemetry.map(({ status }) => status), ["retry", "success"]);
});

test("OpenAICompatibleChatClient does not retry an exhausted output limit", async () => {
  let attemptCount = 0;
  const telemetry: ModelAttemptTelemetry[] = [];
  const mockFetch: FetchFunction = () => {
    attemptCount++;
    return Promise.resolve(Response.json({
      choices: [{
        finish_reason: "length",
        message: {
          content: "",
          refusal: "provider detail must not appear",
          tool_calls: [{ id: "call-1" }],
        },
      }],
      usage: {
        prompt_tokens: 10,
        completion_tokens: 4_000,
        total_tokens: 4_010,
      },
    }));
  };
  const error = await assertRejects(
    () => createClient(mockFetch).complete("system", "content", {
      maxAttempts: 3,
      maxOutputTokens: 4_000,
      onAttempt: (attempt) => {
        telemetry.push(attempt);
      },
    }),
    ModelApiError,
    "exhausted output token limit",
  );
  assert(error instanceof ModelApiError);
  assertEquals(error.kind, "output_limit");
  assertEquals(attemptCount, 1);
  assertEquals(telemetry, [{
    model: "test-model",
    attempt: 1,
    durationMs: telemetry[0].durationMs,
    status: "failure",
    usage: {
      promptTokens: 10,
      completionTokens: 4_000,
      totalTokens: 4_010,
    },
  }]);
  assertStringIncludes(error.message, "finish_reason=length");
  assertStringIncludes(error.message, "max_tokens=4000");
  assertEquals(error.message.includes("provider detail"), false);
  assertEquals("content" in telemetry[0], false);
});

test("OpenAICompatibleChatClient rejects nonempty truncated output without retrying or exposing it", async () => {
  const truncatedContent = '{"points":[{"text":"private truncated output';
  const providerDetail = "private provider refusal";
  let attemptCount = 0;
  const telemetry: ModelAttemptTelemetry[] = [];
  const error = await assertRejects(
    () =>
      createClient(() => {
        attemptCount++;
        return Promise.resolve(Response.json({
          choices: [{
            finish_reason: "length",
            message: {
              content: truncatedContent,
              refusal: providerDetail,
            },
          }],
          usage: {
            prompt_tokens: 12,
            completion_tokens: 4_000,
            total_tokens: 4_012,
          },
        }));
      }).complete("system", "content", {
        maxAttempts: 3,
        maxOutputTokens: 4_000,
        onAttempt: (attempt) => {
          telemetry.push(attempt);
        },
      }),
    ModelApiError,
    "exhausted output token limit",
  );

  assert(error instanceof ModelApiError);
  assertEquals(error.kind, "output_limit");
  assertEquals(attemptCount, 1);
  assertEquals(telemetry, [{
    model: "test-model",
    attempt: 1,
    durationMs: telemetry[0].durationMs,
    status: "failure",
    usage: {
      promptTokens: 12,
      completionTokens: 4_000,
      totalTokens: 4_012,
    },
  }]);
  assertEquals(error.message.includes(truncatedContent), false);
  assertEquals(error.message.includes(providerDetail), false);
  assertEquals("content" in telemetry[0], false);
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
  assertEquals(thrownError.kind, "api");
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
    model: "test-model",
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
    {
      model: "test-model",
      attempt: 1,
      durationMs: telemetry[0].durationMs,
      status: "retry",
    },
    {
      model: "test-model",
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
test("maxOutputTokens emits max_tokens in request body", async () => {
  let capturedBody: string | undefined;
  const mockFetch: FetchFunction = (_input, init) => {
    capturedBody = init?.body as string;
    return Promise.resolve(completionResponse("ok"));
  };
  await createClient(mockFetch).complete("system", "content", {
    maxOutputTokens: 100,
  });
  assertStringIncludes(capturedBody ?? "", `"max_tokens":100`);
});

test("maxOutputTokens validation rejects invalid values", async () => {
  for (const invalid of [0, -1, 1.5, NaN, Infinity]) {
    await assertRejects(
      () =>
        createClient().complete("system", "content", {
          maxOutputTokens: invalid,
        }),
      RangeError,
      "Model output token limit must be a positive integer",
    );
  }
});

test("jsonOutput emits response_format json_object in request body", async () => {
  let capturedBody: string | undefined;
  const mockFetch: FetchFunction = (_input, init) => {
    capturedBody = init?.body as string;
    return Promise.resolve(completionResponse("ok"));
  };
  await createClient(mockFetch).complete("system", "content", {
    jsonOutput: true,
  });
  assertStringIncludes(
    capturedBody ?? "",
    `"response_format":{"type":"json_object"}`,
  );
});

test("jsonOutput defaults omit response_format from request body", async () => {
  let capturedBody: string | undefined;
  const mockFetch: FetchFunction = (_input, init) => {
    capturedBody = init?.body as string;
    return Promise.resolve(completionResponse("ok"));
  };
  await createClient(mockFetch).complete("system", "content");
  assertEquals(capturedBody?.includes("response_format"), false);
});

test("maxAttempts bounds retries to the specified count", async () => {
  let attemptCount = 0;
  const mockFetch: FetchFunction = () => {
    attemptCount++;
    return Promise.reject(new TypeError("down"));
  };
  await assertRejects(() =>
    createClient(mockFetch).complete("system", "content", { maxAttempts: 1 })
  );
  assertEquals(attemptCount, 1);
});

test("maxAttempts default allows three attempts", async () => {
  let attemptCount = 0;
  const mockFetch: FetchFunction = () => {
    attemptCount++;
    return Promise.reject(new TypeError("down"));
  };
  await assertRejects(() =>
    createClient(mockFetch).complete("system", "content")
  );
  assertEquals(attemptCount, 3);
});

test("maxAttempts validation rejects invalid values", async () => {
  for (const invalid of [0, -1, 1.5, NaN, Infinity]) {
    await assertRejects(
      () =>
        createClient().complete("system", "content", {
          maxAttempts: invalid,
        }),
      RangeError,
      "Model maximum attempts must be a positive integer",
    );
  }
});

test("model appears on every attempt telemetry callback", async () => {
  const telemetry: ModelAttemptTelemetry[] = [];
  let calls = 0;
  const mockFetch: FetchFunction = () => {
    calls++;
    if (calls < 3) {
      return Promise.resolve(new Response("busy", { status: 503 }));
    }
    return Promise.resolve(completionResponse("done"));
  };
  await createClient(mockFetch).complete("system", "content", {
    onAttempt: (attempt) => {
      telemetry.push(attempt);
    },
  });
  assertEquals(telemetry.length, 3);
  assert(
    telemetry.every((t) => t.model === "test-model"),
    "every telemetry entry should include the model",
  );
});

test("valid DeepSeek cache hit and miss usage retained", async () => {
  const telemetry: ModelAttemptTelemetry[] = [];
  await createClient(() =>
    Promise.resolve(Response.json({
      choices: [{ message: { content: "cached" } }],
      usage: {
        prompt_tokens: 100,
        completion_tokens: 50,
        total_tokens: 150,
        prompt_cache_hit_tokens: 80,
        prompt_cache_miss_tokens: 20,
      },
    }))
  ).complete("system", "content", {
    onAttempt: (attempt) => {
      telemetry.push(attempt);
    },
  });
  assertEquals(telemetry[0].usage, {
    promptTokens: 100,
    completionTokens: 50,
    totalTokens: 150,
    promptCacheHitTokens: 80,
    promptCacheMissTokens: 20,
  });
});

test("valid DeepSeek hit only (no miss) usage retained", async () => {
  const telemetry: ModelAttemptTelemetry[] = [];
  await createClient(() =>
    Promise.resolve(Response.json({
      choices: [{ message: { content: "partial" } }],
      usage: {
        prompt_tokens: 200,
        completion_tokens: 30,
        total_tokens: 230,
        prompt_cache_hit_tokens: 150,
      },
    }))
  ).complete("system", "content", {
    onAttempt: (attempt) => {
      telemetry.push(attempt);
    },
  });
  assertEquals(telemetry[0].usage, {
    promptTokens: 200,
    completionTokens: 30,
    totalTokens: 230,
    promptCacheHitTokens: 150,
  });
  assertEquals(telemetry[0].usage?.promptCacheMissTokens, undefined);
});

test("malformed cache tokens cause safe omission of usage", async () => {
  for (const testCase of [
    {
      desc: "negative hit tokens",
      usage: {
        prompt_tokens: 10,
        completion_tokens: 2,
        total_tokens: 12,
        prompt_cache_hit_tokens: -1,
      },
    },
    {
      desc: "negative miss tokens",
      usage: {
        prompt_tokens: 10,
        completion_tokens: 2,
        total_tokens: 12,
        prompt_cache_miss_tokens: -5,
      },
    },
    {
      desc: "string hit tokens",
      usage: {
        prompt_tokens: 10,
        completion_tokens: 2,
        total_tokens: 12,
        prompt_cache_hit_tokens: "lots",
      },
    },
    {
      desc: "null miss tokens",
      usage: {
        prompt_tokens: 10,
        completion_tokens: 2,
        total_tokens: 12,
        prompt_cache_miss_tokens: null,
      },
    },
    {
      desc: "float hit tokens",
      usage: {
        prompt_tokens: 10,
        completion_tokens: 2,
        total_tokens: 12,
        prompt_cache_hit_tokens: 3.14,
      },
    },
    {
      desc: "hit tokens exceed prompt tokens",
      usage: {
        prompt_tokens: 10,
        completion_tokens: 2,
        total_tokens: 12,
        prompt_cache_hit_tokens: 11,
      },
    },
    {
      desc: "miss tokens exceed prompt tokens",
      usage: {
        prompt_tokens: 10,
        completion_tokens: 2,
        total_tokens: 12,
        prompt_cache_miss_tokens: 11,
      },
    },
    {
      desc: "hit and miss tokens do not partition prompt tokens",
      usage: {
        prompt_tokens: 10,
        completion_tokens: 2,
        total_tokens: 12,
        prompt_cache_hit_tokens: 7,
        prompt_cache_miss_tokens: 7,
      },
    },
  ]) {
    const telemetry: ModelAttemptTelemetry[] = [];
    await createClient(() =>
      Promise.resolve(Response.json({
        choices: [{ message: { content: "ok" } }],
        usage: testCase.usage,
      }))
    ).complete("system", "content", {
      onAttempt: (attempt) => {
        telemetry.push(attempt);
      },
    });
    assertEquals(
      telemetry[0].usage,
      undefined,
      `expected usage to be omitted for: ${testCase.desc}`,
    );
  }
});

test("callback telemetry never leaks prompt or response content", async () => {
  let captured: ModelAttemptTelemetry | undefined;
  await assertRejects(() =>
    createClient(() => Promise.reject(new TypeError("🔑server_error"))).complete(
      "secret prompt",
      "secret content",
      {
        maxAttempts: 1,
        onAttempt: (t) => {
          captured = t;
        },
      },
    )
  );
  const json = JSON.stringify(captured);
  assertStringIncludes(json, `"attempt":1`);
  assertEquals(json.includes("secret"), false);
  assertEquals(json.includes("🔑server_error"), false);
});
