import { test } from "bun:test";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import sharp from "sharp";
import {
  assert,
  assertEquals,
  assertRejects,
  assertStringIncludes,
} from "./assertions.ts";
import { OpenAICompatibleSummarizerService } from "../src/summarizers/openai-compatible-summarizer.ts";
import {
  buildArticlePrompt,
  buildDiscussionPrompt,
  buildNewsPrompt,
  buildVisionAnalysisPrompt,
  selectRuleset,
} from "../src/summarizers/prompts.ts";
import type { OpenAICompatibleSummarizerOptions } from "../src/summarizers/openai-compatible-summarizer.ts";
import type { NormalizedItem } from "../src/connectors/connector.types.ts";
import type { SummarizationDiagnostic } from "../src/summarizers/summarizer.types.ts";
import type { FetchFunction } from "../src/summarizers/openai-compatible-client.ts";
import { ConnectorId } from "../src/constants.ts";

const fetchEnvironment: { fetch: FetchFunction } = globalThis;

const item = (overrides: Partial<NormalizedItem> = {}): NormalizedItem => ({
  connectorId: ConnectorId.Telegram,
  feedExternalId: "TestChannel",
  externalId: "1",
  date: new Date("2026-01-01T10:00:00Z").getTime(),
  title: null,
  text: "Some news post",
  author: null,
  url: "https://t.me/test/1",
  ...overrides,
});

const TEST_MODELS = {
  summarizer: { model: "test-model", baseUrl: "http://localhost" },
  vision: { model: "test-model", baseUrl: "http://localhost" },
  sameModel: true,
};

const DISTINCT_TEST_MODELS = {
  summarizer: { model: "text-model", baseUrl: "http://localhost:8000/v1" },
  vision: { model: "vision-model", baseUrl: "http://localhost:9000/v1" },
  sameModel: false,
};

function createTestSummarizer(
  options: OpenAICompatibleSummarizerOptions = {},
): OpenAICompatibleSummarizerService {
  return new OpenAICompatibleSummarizerService({
    models: TEST_MODELS,
    ...options,
  });
}

type FetchRequest = { messages: Array<{ role: string; content: unknown }> };

function stubFetch(responseBody: unknown): () => void {
  const original = globalThis.fetch;
  fetchEnvironment.fetch = (() =>
    Promise.resolve(
      new Response(JSON.stringify(responseBody), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
  ));
  return () => {
    globalThis.fetch = original;
  };
}

function captureFetch(responseBody: unknown): {
  captured: { body: FetchRequest | null };
  restore: () => void;
} {
  const original = globalThis.fetch;
  const state = { body: null as FetchRequest | null };
  fetchEnvironment.fetch = ((_input: RequestInfo | URL, init?: RequestInit) => {
    state.body = JSON.parse((init as RequestInit & { body: string }).body);
    return Promise.resolve(
      new Response(JSON.stringify(responseBody), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );
  });
  return {
    captured: state,
    restore: () => {
      globalThis.fetch = original;
    },
  };
}

// --- prompt builders ---

test("buildNewsPrompt — contains t/i field instruction", () => {
  const { systemPrompt } = buildNewsPrompt();
  assertStringIncludes(systemPrompt, '"t"');
  assertStringIncludes(systemPrompt, '"i"');
});

test("buildDiscussionPrompt — contains discussion instruction", () => {
  const { systemPrompt } = buildDiscussionPrompt();
  assertStringIncludes(systemPrompt, "discussion summarizer");
});

test("buildDiscussionPrompt — requires topic, arguments, and conclusion status", () => {
  const { systemPrompt } = buildDiscussionPrompt();
  // Must ban topic-only bullets.
  assertStringIncludes(systemPrompt, "topic-only");
  // Must require concrete arguments in addition to positions.
  assertStringIncludes(systemPrompt, "arguments");
  // Must require conclusion status including explicit unresolved.
  assertStringIncludes(systemPrompt, "unresolved");
  assertStringIncludes(systemPrompt, "no shared conclusion");
});
test("buildArticlePrompt — requires every article and forbids generated headings", () => {
  const rules = buildArticlePrompt({
    language: "French",
    focus: "product strategy",
  });
  assertStringIncludes(rules.systemPrompt, "never omit it as noise");
  assertStringIncludes(
    rules.systemPrompt,
    "Do not generate or repeat a heading",
  );
  assertStringIncludes(rules.systemPrompt, 'Write all "t" values in French.');
  assertStringIncludes(rules.systemPrompt, "Focus on: product strategy.");
  assertEquals(rules.showTitle, true);
});

test("buildNewsPrompt — explicit language overrides default", () => {
  const { systemPrompt } = buildNewsPrompt({ language: "Ukrainian" });
  assertStringIncludes(systemPrompt, "Ukrainian");
});

test("buildVisionAnalysisPrompt — enforces indexed OCR and album uncertainty contract", () => {
  const { systemPrompt } = buildVisionAnalysisPrompt();
  assertStringIncludes(systemPrompt, "exactly two fields");
  assertStringIncludes(systemPrompt, '"i"');
  assertStringIncludes(systemPrompt, '"description"');
  assertStringIncludes(systemPrompt, "visible facts");
  assertStringIncludes(systemPrompt, "OCR");
  assertStringIncludes(systemPrompt, "uncertainty");
  assertStringIncludes(systemPrompt, "Image 1");
  assertStringIncludes(systemPrompt, "Image 2");
});

// --- selectRuleset ---

test("selectRuleset — explicit kind 'discussion' returns discussion ruleset", () => {
  const items = [item({ meta: { isGroup: false } })];
  const rules = selectRuleset(items, "discussion");
  assertStringIncludes(rules.systemPrompt, "discussion summarizer");
});

test("selectRuleset — explicit kind 'news' returns news ruleset", () => {
  const items = [item({ meta: { isGroup: true } })];
  const rules = selectRuleset(items, "news");
  assertStringIncludes(rules.systemPrompt, "news summarizer");
});

test("selectRuleset — no kind, isGroup=true infers discussion", () => {
  const items = [item({ meta: { isGroup: true } })];
  const rules = selectRuleset(items);
  assertStringIncludes(rules.systemPrompt, "discussion summarizer");
});

test("selectRuleset — no kind, isGroup=false infers news", () => {
  const items = [item({ meta: { isGroup: false } })];
  const rules = selectRuleset(items);
  assertStringIncludes(rules.systemPrompt, "news summarizer");
});

test("selectRuleset — explicit kind overrides meta.isGroup", () => {
  const items = [item({ meta: { isGroup: true } })];
  const rules = selectRuleset(items, "news");
  assertStringIncludes(rules.systemPrompt, "news summarizer");
});

// --- summarizer wiring ---

test("summarize — sends configured system prompt to model",
async () => {
  const { captured, restore } = captureFetch({
    choices: [{ message: { content: '[{"t":"x","i":0}]' } }],
  });
  const svc = createTestSummarizer();
  await svc.summarize([item()], buildNewsPrompt());
  assertStringIncludes(captured.body!.messages[0].content as string, '"t"');
  restore();
},);

// --- emoji filter ---

test("buildContentParts — emoji-only item is filtered out", async () => {
  const { captured, restore } = captureFetch({
    choices: [{ message: { content: "[]" } }],
  });
  const svc = createTestSummarizer();
  await svc.summarize(
    [item({ text: "👍🔥😂" }), item({ text: "Real news" })],
    buildNewsPrompt(),
  );
  // News prompt with no media collapses to a plain string.
  const content = captured.body!.messages[1].content as string;
  assertStringIncludes(content, "[0]");
  assertEquals(content.includes("[1]"), false);
  restore();
});

test("buildContentParts — discussion preset sends plain string and shows authors",
async () => {
  const { captured, restore } = captureFetch({
    choices: [{ message: { content: "[]" } }],
  });
  const svc = createTestSummarizer();
  await svc.summarize(
    [item({ text: "hello", author: "@alice", meta: { isGroup: true } })],
    buildDiscussionPrompt(),
  );
  assertEquals(typeof captured.body!.messages[1].content, "string");
  assertStringIncludes(
    captured.body!.messages[1].content as string,
    "@alice",
  );
  restore();
},);

// --- parsePoints ---

test("parsePoints — attaches metadata from indexedItems", async () => {
  const restore = stubFetch({
    choices: [{ message: { content: '[{"t":"summary bullet","i":0}]' } }],
  });
  const svc = createTestSummarizer();
  const results = await svc.summarize([item()], buildNewsPrompt());
  assertEquals(results[0].text, "summary bullet");
  assertEquals(results[0].sourceUrl, "https://t.me/test/1");
  assertEquals(results[0].channel, "TestChannel");
  restore();
});

test("parsePoints — strips markdown code fences from response",
async () => {
  const restore = stubFetch({
    choices: [
      { message: { content: '```json\n[{"t":"fenced","i":0}]\n```' } },
    ],
  });
  const svc = createTestSummarizer();
  const results = await svc.summarize([item()], buildNewsPrompt());
  assertEquals(results[0].text, "fenced");
  restore();
},);

test("parsePoints — out-of-bounds sourceIndex yields null sourceUrl",
async () => {
  const restore = stubFetch({
    choices: [{ message: { content: '[{"t":"orphan","i":99}]' } }],
  });
  const svc = createTestSummarizer();
  const results = await svc.summarize([item()], buildNewsPrompt());
  assertEquals(results[0].text, "orphan");
  assertEquals(results[0].sourceUrl, null);
  restore();
},);

test("parsePoints — missing source index maps to null sourceUrl",
async () => {
  const restore = stubFetch({
    choices: [{
      message: { content: '[{"t":"discussion summary without index"}]' },
    }],
  });
  const svc = createTestSummarizer();
  const results = await svc.summarize([item()], buildNewsPrompt());
  assertEquals(results[0].text, "discussion summary without index");
  assertEquals(results[0].sourceUrl, null);
  restore();
},);

// --- retry / API error helpers ---

type ResponseSpec = { status: number; body: string };

function stubFetchSequence(specs: ResponseSpec[]): {
  callCount: () => number;
  restore: () => void;
} {
  const original = globalThis.fetch;
  let callIndex = 0;
  fetchEnvironment.fetch = (() => {
    const spec = specs[callIndex] ?? specs[specs.length - 1];
    callIndex++;
    return Promise.resolve(
      new Response(spec.body, {
        status: spec.status,
        headers: { "Content-Type": "application/json" },
      }),
    );
  });
  return {
    callCount: () => callIndex,
    restore: () => {
      globalThis.fetch = original;
    },
  };
}

type CapturedModelRequest = {
  url: string;
  body: FetchRequest & { model: string };
};

function captureFetchSequence(specs: ResponseSpec[]): {
  captured: CapturedModelRequest[];
  callCount: () => number;
  restore: () => void;
} {
  const original = globalThis.fetch;
  const captured: CapturedModelRequest[] = [];
  let callIndex = 0;
  fetchEnvironment.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
    captured.push({
      url: String(input),
      body: JSON.parse((init as RequestInit & { body: string }).body),
    });
    const spec = specs[callIndex] ?? specs[specs.length - 1];
    callIndex++;
    return Promise.resolve(
      new Response(spec.body, {
        status: spec.status,
        headers: { "Content-Type": "application/json" },
      }),
    );
  });
  return {
    captured,
    callCount: () => callIndex,
    restore: () => {
      globalThis.fetch = original;
    },
  };
}

function modelResponse(content: string): string {
  return JSON.stringify({
    choices: [{ message: { content } }],
  });
}

async function createRoutingTestDirectory(name: string): Promise<string> {
  const directory = `./.test-data/${name}`;
  await mkdir(directory, { recursive: true });
  return directory;
}

test("summarize — enforces the timeout at the model request boundary", async () => {
  const originalFetch = globalThis.fetch;
  let requestAborted = false;
  fetchEnvironment.fetch = ((_input: RequestInfo | URL, init?: RequestInit) => new Promise<Response>((resolve, reject) => {
    const responseTimer = setTimeout(
      () =>
        resolve(
          new Response(modelResponse('[{"t":"too late","i":0}]'), {
            status: 200,
            headers: { "Content-Type": "application/json" },
          }),
        ),
      50,
    );
    const signal = init?.signal;
    signal?.addEventListener(
      "abort",
      () => {
        requestAborted = true;
        clearTimeout(responseTimer);
        reject(signal.reason);
      },
      { once: true },
    );
    }));

  try {
    const service = createTestSummarizer();
    await assertRejects(
      () =>
        service.summarize([item()], buildNewsPrompt(), {
          requestTimeoutMs: 5,
        }),
      DOMException,
      "Summarizer timed out",
    );
    assert(requestAborted);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("summarize — renews the timeout for every chunk and merge request", async () => {
  const originalFetch = globalThis.fetch;
  const requestSignals: Array<AbortSignal | null | undefined> = [];
  const responses = [
    modelResponse('[{"t":"first chunk","i":0}]'),
    modelResponse('[{"t":"second chunk","i":0}]'),
    modelResponse('[{"t":"merged","i":0}]'),
  ];
  let callIndex = 0;
  fetchEnvironment.fetch = ((_input: RequestInfo | URL, init?: RequestInit) => {
    requestSignals.push(init?.signal);
    const responseBody = responses[callIndex] ?? responses.at(-1)!;
    callIndex++;
    return Promise.resolve(
      new Response(responseBody, {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );
  });

  try {
    const service = createTestSummarizer({ maxItemsPerChunk: 1 });
    const result = await service.summarize(
      [
        item({ externalId: "first", text: "first" }),
        item({ externalId: "second", text: "second" }),
      ],
      buildNewsPrompt(),
      { requestTimeoutMs: 1_000 },
    );

    assertEquals(result[0].text, "merged");
    assertEquals(requestSignals.length, 3);
    assertEquals(
      requestSignals.every((signal) => signal instanceof AbortSignal),
      true,
    );
    assertEquals(new Set(requestSignals).size, 3);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

// --- retry behavior ---

test("summarize — retries on 429 and succeeds on second attempt", async () => {
  const { callCount, restore } = stubFetchSequence([
    { status: 429, body: '{"error":"rate limited"}' },
    {
      status: 200,
      body:
        '{"choices":[{"message":{"content":"[{\\"t\\":\\"ok\\",\\"i\\":0}]"}}]}',
    },
  ]);
  try {
    const svc = createTestSummarizer({ retryBaseDelayMs: 0 });
    const results = await svc.summarize([item()], buildNewsPrompt());
    assertEquals(results[0].text, "ok");
    assertEquals(callCount(), 2);
  } finally {
    restore();
  }
});

test("summarize — retries on 503 and succeeds on third attempt", async () => {
  const { callCount, restore } = stubFetchSequence([
    { status: 503, body: "Service Unavailable" },
    { status: 503, body: "Service Unavailable" },
    {
      status: 200,
      body:
        '{"choices":[{"message":{"content":"[{\\"t\\":\\"ok\\",\\"i\\":0}]"}}]}',
    },
  ]);
  try {
    const svc = createTestSummarizer({ retryBaseDelayMs: 0 });
    const results = await svc.summarize([item()], buildNewsPrompt());
    assertEquals(results[0].text, "ok");
    assertEquals(callCount(), 3);
  } finally {
    restore();
  }
});

test("summarize — does not retry on 400 (non-retryable status)", async () => {
  const { callCount, restore } = stubFetchSequence([
    { status: 400, body: '{"error":"bad request"}' },
  ]);
  try {
    const svc = createTestSummarizer({ retryBaseDelayMs: 0 });
    await svc.summarize([item()], buildNewsPrompt());
    throw new Error("expected summarize to throw on 400");
  } catch (err: unknown) {
    if (
      err instanceof Error &&
      err.message === "expected summarize to throw on 400"
    ) throw err;
    assertEquals(err instanceof Error, true);
    assertStringIncludes((err as Error).message, "Model API 400");
    assertEquals((err as Error).message.includes("bad request"), false);
    assertEquals(callCount(), 1);
  } finally {
    restore();
  }
});

test("summarize — provider response bodies stay out of diagnostics", async () => {
  const privateMarker = "PRIVATE_PROVIDER_RESPONSE_MUST_NOT_BE_LOGGED";
  const { restore } = stubFetchSequence([
    { status: 500, body: `{"error":"${privateMarker}"}` },
  ]);
  const diagnostics: SummarizationDiagnostic[] = [];
  try {
    const service = createTestSummarizer({ retryBaseDelayMs: 0 });
    const error = await assertRejects(
      () =>
        service.summarize([item()], buildNewsPrompt(), {
          onDiagnostic: (diagnostic) => {
            diagnostics.push(diagnostic);
          },
        }),
      Error,
      "Model API 500",
    );
    assertEquals(error.message.includes(privateMarker), false);
    assertEquals(diagnostics, [{
      event: "chunk_failed",
      chunkIndex: 1,
      chunkCount: 1,
      model: "test-model",
      errorMessage: "Model API 500",
    }]);
  } finally {
    restore();
  }
});

// --- parsePoints boundary cases ---

test("parsePoints — throws on empty response", async () => {
  const restore = stubFetch({
    choices: [{ message: { content: "" } }],
  });
  try {
    const svc = createTestSummarizer();
    await svc.summarize([item()], buildNewsPrompt());
    throw new Error("expected summarize to throw on empty response");
  } catch (err: unknown) {
    if (
      err instanceof Error &&
      err.message === "expected summarize to throw on empty response"
    ) throw err;
    assertEquals(err instanceof Error, true);
    assertStringIncludes((err as Error).message, "empty response");
  } finally {
    restore();
  }
});

test("parsePoints — throws on non-array JSON response", async () => {
  const restore = stubFetch({
    choices: [{ message: { content: '{"not":"an array"}' } }],
  });
  try {
    const svc = createTestSummarizer();
    await svc.summarize([item()], buildNewsPrompt());
    throw new Error("expected summarize to throw on non-array response");
  } catch (err: unknown) {
    if (
      err instanceof Error &&
      err.message === "expected summarize to throw on non-array response"
    ) throw err;
    assertEquals(err instanceof Error, true);
    assertStringIncludes((err as Error).message, "non-array");
  } finally {
    restore();
  }
});

test("parsePoints — throws on non-array object response", async () => {
  const restore = stubFetch({
    choices: [{ message: { content: '{"status":"ok","summary":"done"}' } }],
  });
  try {
    const svc = createTestSummarizer();
    await svc.summarize([item()], buildNewsPrompt());
    throw new Error("expected summarize to throw on non-array");
  } catch (err: unknown) {
    if (
      err instanceof Error &&
      err.message === "expected summarize to throw on non-array"
    ) throw err;
    assertEquals(err instanceof Error, true);
    assertStringIncludes((err as Error).message, "non-array");
  } finally {
    restore();
  }
});

test("parsePoints — validation errors do not include raw model output", async () => {
  const privateMarker = "PRIVATE_MODEL_OUTPUT_MUST_NOT_BE_LOGGED";
  const restore = stubFetch({
    choices: [{
      message: { content: `{"private":"${privateMarker}"}` },
    }],
  });
  try {
    const service = createTestSummarizer();
    await service.summarize([item()], buildNewsPrompt());
    throw new Error("expected summarize to reject raw object output");
  } catch (error) {
    if (
      error instanceof Error &&
      error.message === "expected summarize to reject raw object output"
    ) {
      throw error;
    }
    assertEquals(error instanceof Error, true);
    assertStringIncludes((error as Error).message, "non-array");
    assertEquals((error as Error).message.includes(privateMarker), false);
  } finally {
    restore();
  }
});

test("parsePoints — strips bare fence without language tag", async () => {
  const restore = stubFetch({
    choices: [{ message: { content: '```\n[{"t":"bare","i":0}]\n```' } }],
  });
  try {
    const svc = createTestSummarizer();
    const results = await svc.summarize([item()], buildNewsPrompt());
    assertEquals(results[0].text, "bare");
  } finally {
    restore();
  }
});

test("parsePoints — strips think tags before fence extraction", async () => {
  const restore = stubFetch({
    choices: [{
      message: {
        content:
          '<think>reasoning</think>\n```json\n[{"t":"after think","i":0}]\n```',
      },
    }],
  });
  try {
    const svc = createTestSummarizer();
    const results = await svc.summarize([item()], buildNewsPrompt());
    assertEquals(results[0].text, "after think");
  } finally {
    restore();
  }
});

test("parsePoints — throws on element without string t (prose turned to word array)", async () => {
  // jsonrepair turns "Sure, here is your summary:" into ["Sure","here is your summary:"]
  // — a valid array whose elements lack t/i, which should fail element validation.
  const restore = stubFetch({
    choices: [{ message: { content: "Sure, here is your summary:" } }],
  });
  try {
    const svc = createTestSummarizer();
    await svc.summarize([item()], buildNewsPrompt());
    throw new Error("expected summarize to throw on element validation");
  } catch (err: unknown) {
    if (
      err instanceof Error &&
      err.message === "expected summarize to throw on element validation"
    ) throw err;
    assertEquals(err instanceof Error, true);
    assertStringIncludes((err as Error).message, "non-object at index 0");
  } finally {
    restore();
  }
});

// --- empty and filtered input ---

test("summarize — returns [] for empty items", async () => {
  const svc = createTestSummarizer();
  const results = await svc.summarize([], buildNewsPrompt());
  assertEquals(results, []);
});

test("summarize — returns [] when all items are filtered (emoji-only, no photo)", async () => {
  const svc = createTestSummarizer();
  const results = await svc.summarize(
    [item({ text: "👍🔥😂" }), item({ text: "" })],
    buildNewsPrompt(),
  );
  assertEquals(results, []);
});

// --- chunking and merge ---

test("summarize — chunks items and merges when maxItemsPerChunk is exceeded", async () => {
  // 3 items, maxItemsPerChunk=2 → chunk 1 gets items 0,1; chunk 2 gets item 2.
  // Each chunk returns fewer points than items to simulate real summarization reduction.
  // Merge call returns final points.
  const responses = [
    // Chunk 1 (2 items → 1 point)
    {
      status: 200,
      body:
        '{"choices":[{"message":{"content":"[{\\"t\\":\\"summary AB\\",\\"i\\":0}]"}}]}',
    },
    // Chunk 2 (1 item → 1 point)
    {
      status: 200,
      body:
        '{"choices":[{"message":{"content":"[{\\"t\\":\\"summary C\\",\\"i\\":0}]"}}]}',
    },
    // Merge: 2 synthetic items, maxItemsPerChunk=2 → 1 chunk → result
    {
      status: 200,
      body:
        '{"choices":[{"message":{"content":"[{\\"t\\":\\"final X\\",\\"i\\":0},{\\"t\\":\\"final Y\\",\\"i\\":1}]"}}]}',
    },
  ];
  const { callCount, restore } = stubFetchSequence(responses);
  try {
    const svc = createTestSummarizer({
      retryBaseDelayMs: 0,
      maxItemsPerChunk: 2,
    });
    const results = await svc.summarize(
      [
        item({ text: "item A" }),
        item({ text: "item B" }),
        item({ text: "item C" }),
      ],
      buildNewsPrompt(),
    );
    assertEquals(callCount(), 3, "expected 3 calls: 2 chunk + 1 merge");
    assertEquals(results.length, 2);
    assertEquals(results[0].text, "final X");
    assertEquals(results[1].text, "final Y");
  } finally {
    restore();
  }
});

test("summarize — bounds a production-shaped hierarchical merge", async () => {
  const originalFetch = globalThis.fetch;
  const sourceRequestCount = 18;
  const pointsPerSource = 50;
  const totalPoints = sourceRequestCount * pointsPerSource;
  const maxMergeItems = 32;
  const maxMergeBytes = 512;
  const mergePayloads: string[] = [];
  let requestCount = 0;
  fetchEnvironment.fetch = ((_input: RequestInfo | URL, init?: RequestInit) => {
    const request = JSON.parse(
      (init as RequestInit & { body: string }).body,
    ) as FetchRequest;
    const isSourceRequest = requestCount++ < sourceRequestCount;
    const responseContent = isSourceRequest
      ? JSON.stringify(
        Array.from(
          { length: pointsPerSource },
          (_, index) => ({ t: `source ${requestCount} point ${index}`, i: 0 }),
        ),
      )
      : (() => {
        mergePayloads.push(String(request.messages[1].content));
        return `[{"t":"merged ${mergePayloads.length}","i":0}]`;
      })();
    return Promise.resolve(
      new Response(modelResponse(responseContent), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );
  });

  try {
    const service = createTestSummarizer({
      retryBaseDelayMs: 0,
      maxItemsPerChunk: maxMergeItems,
      maxTextBytesPerChunk: maxMergeBytes,
    });
    const results = await service.summarize(
      Array.from(
        { length: sourceRequestCount },
        (_, index) =>
          item({
            externalId: String(index),
            text: `source item ${index} ${"x".repeat(300)}`,
          }),
      ),
      buildNewsPrompt(),
    );

    const encoder = new TextEncoder();
    const mergeItemCounts = mergePayloads.map((content) =>
      (content.match(/^\[\d+\]$/gm) ?? []).length
    );
    assert(mergePayloads.length > 1);
    assert(
      mergeItemCounts.every((count) =>
        count <= maxMergeItems && count < totalPoints
      ),
    );
    assert(
      mergePayloads.every((content) =>
        encoder.encode(content).byteLength <= maxMergeBytes
      ),
    );
    assertEquals(results.length, 1);
    assertStringIncludes(results[0].text, "merged");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("summarize — merge framing honors tiny UTF-8 budgets and maxItems one", async () => {
  const originalFetch = globalThis.fetch;
  const mergeContents: string[] = [];
  let requestCount = 0;
  fetchEnvironment.fetch = ((_input: RequestInfo | URL, init?: RequestInit) => {
    const request = JSON.parse(
      (init as RequestInit & { body: string }).body,
    ) as FetchRequest;
    requestCount++;
    const responseContent = requestCount <= 2
      ? '[{"t":"😀😀","i":0}]'
      : (() => {
        mergeContents.push(String(request.messages[1].content));
        return '[{"t":"done","i":0}]';
      })();
    return Promise.resolve(
      new Response(modelResponse(responseContent), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );
  });

  try {
    const service = createTestSummarizer({
      maxItemsPerChunk: 1,
      maxTextBytesPerChunk: 14,
    });
    const result = await service.summarize(
      [item({ text: "a" }), item({ text: "b" })],
      buildNewsPrompt(),
    );
    assertEquals(result[0].text, "done");
    assertEquals(mergeContents.length, 1);
    assertEquals(new TextEncoder().encode(mergeContents[0]).byteLength, 14);
    assertEquals((mergeContents[0].match(/^\[\d+\]$/gm) ?? []).length, 2);
    assertEquals(mergeContents[0].includes("\uFFFD"), false);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("summarize — rejects an empty intermediate merge through merge_failed", async () => {
  const diagnostics: SummarizationDiagnostic[] = [];
  const { restore } = stubFetchSequence([
    { status: 200, body: modelResponse('[{"t":"first","i":0}]') },
    { status: 200, body: modelResponse('[{"t":"second","i":0}]') },
    { status: 200, body: modelResponse('[{"t":"third","i":0}]') },
    { status: 200, body: modelResponse("[]") },
  ]);
  try {
    const service = createTestSummarizer({
      retryBaseDelayMs: 0,
      maxItemsPerChunk: 1,
    });
    await assertRejects(
      () =>
        service.summarize(
          [item({ text: "a" }), item({ text: "b" }), item({ text: "c" })],
          buildNewsPrompt(),
          {
            onDiagnostic: (diagnostic) => {
              diagnostics.push(diagnostic);
            },
          },
        ),
      Error,
      "Non-final merge batch returned no summary points",
    );
    assertEquals(diagnostics, [{
      event: "merge_failed",
      chunkCount: 3,
      model: "test-model",
      errorMessage: "Non-final merge batch returned no summary points",
    }]);
  } finally {
    restore();
  }
});

test("summarize — constructor uses the scoped item limit configuration", async () => {
  const previousValue = process.env.SUMMARIZER_MAX_ITEMS_PER_CHUNK;
  process.env.SUMMARIZER_MAX_ITEMS_PER_CHUNK = "1";
  const { callCount, restore } = stubFetchSequence([
    { status: 200, body: modelResponse('[{"t":"first","i":0}]') },
    { status: 200, body: modelResponse('[{"t":"second","i":0}]') },
    { status: 200, body: modelResponse('[{"t":"merged","i":0}]') },
  ]);

  try {
    const service = createTestSummarizer({ retryBaseDelayMs: 0 });
    await service.summarize(
      [
        item({ externalId: "first", text: "first" }),
        item({ externalId: "second", text: "second" }),
      ],
      buildNewsPrompt(),
    );
    assertEquals(callCount(), 3);
  } finally {
    if (previousValue === undefined) {
      delete process.env.SUMMARIZER_MAX_ITEMS_PER_CHUNK;
    } else {
      process.env.SUMMARIZER_MAX_ITEMS_PER_CHUNK = previousValue;
    }
    restore();
  }
});

test("summarize — single chunk skips merge", async () => {
  const { callCount, restore } = stubFetchSequence([
    {
      status: 200,
      body:
        '{"choices":[{"message":{"content":"[{\\"t\\":\\"single\\",\\"i\\":0}]"}}]}',
    },
  ]);
  try {
    const svc = createTestSummarizer();
    const results = await svc.summarize([item()], buildNewsPrompt());
    assertEquals(callCount(), 1, "expected single call with no merge");
    assertEquals(results.length, 1);
    assertEquals(results[0].text, "single");
  } finally {
    restore();
  }
});

test("summarize — article mode splits UTF-8 safely, keeps title context, and never merges chunks", async () => {
  const original = globalThis.fetch;
  const requestContents: string[] = [];
  fetchEnvironment.fetch = ((_input: RequestInfo | URL, init?: RequestInit) => {
    const request = JSON.parse(
      (init as RequestInit & { body: string }).body,
    ) as FetchRequest;
    requestContents.push(request.messages[1].content as string);
    const chunkNumber = requestContents.length;
    return Promise.resolve(
      new Response(
        JSON.stringify({
          choices: [{
            message: { content: `[{"t":"chunk ${chunkNumber}","i":0}]` },
          }],
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ),
    );
  });
  try {
    const service = createTestSummarizer({ maxTextBytesPerChunk: 5 });
    const points = await service.summarize(
      [item({ title: "Résumé title", text: "ééééé" })],
      buildArticlePrompt(),
      { summaryMode: "article" },
    );
    assertEquals(requestContents.length, 3);
    assertEquals(points.map((point) => point.text), [
      "chunk 1",
      "chunk 2",
      "chunk 3",
    ]);
    assert(
      requestContents.every((content) =>
        content.includes("Title: Résumé title")
      ),
    );
    assertEquals(requestContents.map((content) => content.split("\n").at(-1)), [
      "éé",
      "éé",
      "é",
    ]);
  } finally {
    globalThis.fetch = original;
  }
});

test("summarize — article mode rejects multiple items", async () => {
  const service = createTestSummarizer();
  await assertRejects(
    () =>
      service.summarize(
        [item(), item({ externalId: "2" })],
        buildArticlePrompt(),
        {
          summaryMode: "article",
        },
      ),
    Error,
    "exactly one item",
  );
});

test("summarize — article mode does not apply aggregate noise filtering", async () => {
  const original = globalThis.fetch;
  const submitted: string[] = [];
  fetchEnvironment.fetch = ((_input: RequestInfo | URL, init?: RequestInit) => {
    const request = JSON.parse(
      (init as RequestInit & { body: string }).body,
    ) as FetchRequest;
    submitted.push(request.messages[1].content as string);
    return Promise.resolve(
      new Response(
        JSON.stringify({
          choices: [{ message: { content: '[{"t":"kept","i":0}]' } }],
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ),
    );
  });
  try {
    const service = createTestSummarizer();
    for (const text of ["123456", "(){ =>; }", "👍🔥😂"]) {
      const points = await service.summarize(
        [item({ text })],
        buildArticlePrompt(),
        { summaryMode: "article" },
      );
      assertEquals(points.map((point) => point.text), ["kept"]);
    }
    assertEquals(submitted.length, 3);
  } finally {
    globalThis.fetch = original;
  }
});

test("summarize — article byte budget rejects invalid and undersized scalar budgets before requests", async () => {
  const original = globalThis.fetch;
  let requests = 0;
  fetchEnvironment.fetch = (() => {
    requests++;
    throw new Error("model must not be called");
  });
  try {
    const service = createTestSummarizer();
    for (const budget of [0, -1, 1.5, Number.POSITIVE_INFINITY, Number.NaN]) {
      await assertRejects(
        () =>
          service.summarize([item({ text: "a" })], buildArticlePrompt(), {
            summaryMode: "article",
            maxTextBytesPerChunk: budget,
          }),
        Error,
        "positive finite integer",
      );
    }
    await assertRejects(
      () =>
        service.summarize([item({ text: "é" })], buildArticlePrompt(), {
          summaryMode: "article",
          maxTextBytesPerChunk: 1,
        }),
      Error,
      "smaller than a 2-byte Unicode scalar",
    );
    await assertRejects(
      () =>
        service.summarize([item({ text: "😀" })], buildArticlePrompt(), {
          summaryMode: "article",
          maxTextBytesPerChunk: 1,
        }),
      Error,
      "smaller than a 4-byte Unicode scalar",
    );
    assertEquals(requests, 0);
  } finally {
    globalThis.fetch = original;
  }
});

test("summarize — article splitter preserves long mixed UTF-8 text at byte boundaries", async () => {
  const original = globalThis.fetch;
  const chunks: string[] = [];
  fetchEnvironment.fetch = ((_input: RequestInfo | URL, init?: RequestInit) => {
    const request = JSON.parse(
      (init as RequestInit & { body: string }).body,
    ) as FetchRequest;
    const content = request.messages[1].content as string;
    chunks.push(content.split("\n").at(-1)!);
    return Promise.resolve(
      new Response(
        JSON.stringify({
          choices: [{ message: { content: '[{"t":"chunk","i":0}]' } }],
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ),
    );
  });
  try {
    const text = "aé😀".repeat(20);
    const service = createTestSummarizer();
    const points = await service.summarize(
      [item({ text })],
      buildArticlePrompt(),
      { summaryMode: "article", maxTextBytesPerChunk: 9 },
    );
    assert(chunks.length > 1);
    assertEquals(points.length, chunks.length);
    assertEquals(chunks.join(""), text);
    assert(
      chunks.every((chunk) => new TextEncoder().encode(chunk).byteLength <= 9),
    );
  } finally {
    globalThis.fetch = original;
  }
});

// --- oversize text truncation ---

test("summarize — truncates item text exceeding maxTextBytesPerChunk", async () => {
  const longText = "A".repeat(200);
  const maxBytes = 100;

  const { captured, restore } = captureFetch({
    choices: [{ message: { content: '[{"t":"truncated","i":0}]' } }],
  });
  try {
    const svc = createTestSummarizer({
      retryBaseDelayMs: 0,
      maxTextBytesPerChunk: maxBytes,
    });
    await svc.summarize(
      [item({ text: longText })],
      buildNewsPrompt(),
    );
    const content = captured.body!.messages[1].content as string;
    // The text part is "[0]\n" + truncated text
    assertStringIncludes(content, "A".repeat(maxBytes));
    assert(
      !content.includes("A".repeat(maxBytes + 1)),
      "text should be truncated",
    );
  } finally {
    restore();
  }
});

test("summarize — normal text below maxTextBytesPerChunk is not truncated", async () => {
  const normalText = "Hello world";

  const { captured, restore } = captureFetch({
    choices: [{ message: { content: '[{"t":"normal","i":0}]' } }],
  });
  try {
    const svc = createTestSummarizer({
      retryBaseDelayMs: 0,
      maxTextBytesPerChunk: 100,
    });
    await svc.summarize(
      [item({ text: normalText })],
      buildNewsPrompt(),
    );
    const content = captured.body!.messages[1].content as string;
    assertStringIncludes(content, "Hello world");
  } finally {
    restore();
  }
});

// --- image omission ---

test("summarize — omits images above maxImageBytes", async () => {
  const temporaryDirectory = "./.test-data/summarizer-test-images";
  try {
    await mkdir(temporaryDirectory, { recursive: true });
    await writeFile(`${temporaryDirectory}/small.jpg`, new Uint8Array(50)); // 50 bytes
    await writeFile(
      `${temporaryDirectory}/large.jpg`,
      new Uint8Array(2_000),
    ); // 2KB
    const maxImageBytes = 100;

    // Small image below threshold: included (not omitted)
    const { captured, restore } = captureFetch({
      choices: [{ message: { content: '[{"t":"done","i":0}]' } }],
    });
    try {
      const svc = createTestSummarizer({
        retryBaseDelayMs: 0,
        maxImageBytes,
      });
      await svc.summarize(
        [item({
          text: "small img",
          media: {
            type: "photo",
            localPath: `${temporaryDirectory}/small.jpg`,
          },
        })],
        buildNewsPrompt(),
      );
      const content = captured.body!.messages[1].content;
      assert(
        Array.isArray(content),
        "small image should produce array content (image_url present)",
      );
      const textParts = content.filter((p: { type: string }) =>
        p.type === "text"
      );
      const imageParts = content.filter((p: { type: string }) =>
        p.type === "image_url"
      );
      assert(
        imageParts.length > 0,
        "small image should produce an image_url part",
      );
      const omittedTexts = textParts.filter((p: { text: string }) =>
        p.text === "[IMAGE_OMITTED]"
      );
      assertEquals(omittedTexts.length, 0, "small image should not be omitted");
    } finally {
      restore();
    }

    // Large image above threshold: omitted → [IMAGE_OMITTED] text
    const { captured: captured2, restore: restore2 } = captureFetch({
      choices: [{ message: { content: '[{"t":"done","i":0}]' } }],
    });
    try {
      const svc = createTestSummarizer({
        retryBaseDelayMs: 0,
        maxImageBytes,
      });
      await svc.summarize(
        [item({
          text: "large img",
          media: {
            type: "photo",
            localPath: `${temporaryDirectory}/large.jpg`,
          },
        })],
        buildNewsPrompt(),
      );
      const content = captured2.body!.messages[1].content;
      assert(
        typeof content === "string",
        "omitted images produce collapsed string",
      );
      assertStringIncludes(
        content,
        "[IMAGE_OMITTED]",
        "large image should be omitted",
      );
    } finally {
      restore2();
    }
  } finally {
    await rm(temporaryDirectory, { recursive: true });
  }
});

test("Bun loads native sharp and resizes a PNG through temporary files", async () => {
  const directory = await mkdtemp(join(tmpdir(), "morning-post-sharp-"));
  const sourcePath = join(directory, "source.png");
  const resizedPath = join(directory, "resized.png");
  try {
    await sharp({
      create: {
        width: 4,
        height: 3,
        channels: 4,
        background: { r: 12, g: 34, b: 56, alpha: 1 },
      },
    }).png().toFile(sourcePath);
    await sharp(sourcePath).resize(2, 2, { fit: "fill" }).png().toFile(resizedPath);

    const resized = await readFile(resizedPath);
    assertEquals(resized.subarray(1, 4).toString("ascii"), "PNG");
    const metadata = await sharp(resized).metadata();
    assertEquals(metadata.format, "png");
    assertEquals(metadata.width, 2);
    assertEquals(metadata.height, 2);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("summarize — encodes an image at the configured byte limit", async () => {
  const temporaryDirectory = await createRoutingTestDirectory("image-limit");
  const imagePath = `${temporaryDirectory}/limit.jpg`;
  await writeFile(imagePath, new Uint8Array(1_000_000).fill(7));
  const { captured, restore } = captureFetch({
    choices: [{ message: { content: '[{"t":"limit image","i":0}]' } }],
  });
  try {
    const svc = createTestSummarizer({
      retryBaseDelayMs: 0,
      maxImageBytes: 1_000_000,
    });
    await svc.summarize(
      [item({ media: { type: "photo", localPath: imagePath } })],
      buildNewsPrompt(),
    );
    const content = captured.body!.messages[1].content;
    assert(
      Array.isArray(content),
      "an image at the limit should remain multimodal",
    );
    assertStringIncludes(JSON.stringify(content), "data:image/jpeg;base64");
    assertEquals(JSON.stringify(content).includes("[IMAGE_OMITTED]"), false);
  } finally {
    restore();
    await rm(temporaryDirectory, { recursive: true });
  }
});

test("summarize — same-model routing sends valid images directly as multimodal content", async () => {
  const temporaryDirectory = await createRoutingTestDirectory(
    "same-model-direct",
  );
  const imagePath = `${temporaryDirectory}/photo.jpg`;
  await writeFile(imagePath, new Uint8Array([1, 2, 3]));
  const { captured, restore } = captureFetchSequence([
    {
      status: 200,
      body: modelResponse('[{"t":"direct image summary","i":0}]'),
    },
  ]);
  try {
    const svc = createTestSummarizer({ retryBaseDelayMs: 0 });
    const results = await svc.summarize(
      [item({ media: { type: "photo", localPath: imagePath } })],
      buildNewsPrompt(),
    );
    assertEquals(results[0].text, "direct image summary");
    assertEquals(captured.length, 1);
    assertEquals(captured[0].body.model, "test-model");
    assertStringIncludes(captured[0].url, "http://localhost/chat/completions");
    assertStringIncludes(
      JSON.stringify(captured[0].body.messages[1].content),
      "image_url",
    );
  } finally {
    restore();
    await rm(temporaryDirectory, { recursive: true });
  }
});

test("summarize — distinct vision model analyzes images before text summarization", async () => {
  const temporaryDirectory = await createRoutingTestDirectory(
    "distinct-vision",
  );
  const imagePath = `${temporaryDirectory}/photo.jpg`;
  await writeFile(imagePath, new Uint8Array([1, 2, 3]));
  const { captured, restore } = captureFetchSequence([
    {
      status: 200,
      body: modelResponse(
        '[{"i":0,"description":"visible OCR text, uncertain context"}]',
      ),
    },
    {
      status: 200,
      body: modelResponse('[{"t":"described image summary","i":0}]'),
    },
  ]);
  try {
    const svc = createTestSummarizer({
      models: DISTINCT_TEST_MODELS,
      retryBaseDelayMs: 0,
    });
    const results = await svc.summarize(
      [item({ media: { type: "photo", localPath: imagePath } })],
      buildNewsPrompt(),
    );
    assertEquals(results[0].text, "described image summary");
    assertEquals(captured.length, 2);
    assertEquals(captured[0].body.model, "vision-model");
    assertStringIncludes(
      captured[0].url,
      "http://localhost:9000/v1/chat/completions",
    );
    assertStringIncludes(
      JSON.stringify(captured[0].body.messages[1].content),
      "Item [0], Image 1",
    );
    assertStringIncludes(
      JSON.stringify(captured[0].body.messages[1].content),
      "image_url",
    );
    assertEquals(captured[1].body.model, "text-model");
    assertStringIncludes(
      captured[1].url,
      "http://localhost:8000/v1/chat/completions",
    );
    const summaryContent = captured[1].body.messages[1].content;
    assertEquals(typeof summaryContent, "string");
    assertStringIncludes(String(summaryContent), "[IMAGE_ANALYSIS]");
    assertEquals(String(summaryContent).includes("image_url"), false);
  } finally {
    restore();
    await rm(temporaryDirectory, { recursive: true });
  }
});

test("summarize — separate vision preserves omitted album images without decorating omission markers", async () => {
  const temporaryDirectory = await createRoutingTestDirectory("distinct-album");
  const validImagePath = `${temporaryDirectory}/valid.jpg`;
  const missingImagePath = `${temporaryDirectory}/missing.jpg`;
  await writeFile(validImagePath, new Uint8Array([1, 2, 3]));
  const { captured, restore } = captureFetchSequence([
    {
      status: 200,
      body: modelResponse('[{"i":0,"description":"one visible album image"}]'),
    },
    { status: 200, body: modelResponse('[{"t":"album summary","i":0}]') },
  ]);
  try {
    const svc = createTestSummarizer({
      models: DISTINCT_TEST_MODELS,
      retryBaseDelayMs: 0,
    });
    await svc.summarize(
      [{
        ...item({ text: "album post" }),
        media: {
          type: "album",
          localPaths: [missingImagePath, validImagePath],
        },
      }],
      buildNewsPrompt(),
    );
    const visionContent = JSON.stringify(captured[0].body.messages[1].content);
    assertStringIncludes(visionContent, "Item [0], Image 2");
    assertEquals(visionContent.includes("Image 1"), false);
    const summaryContent = captured[1].body.messages[1].content;
    assertEquals(typeof summaryContent, "string");
    const summaryText = String(summaryContent);
    assertStringIncludes(summaryText, "[IMAGE_OMITTED]");
    assertStringIncludes(summaryText, "[IMAGE_ANALYSIS]");
    assertEquals(
      summaryText.includes("[IMAGE_OMITTED]\n[IMAGE_ANALYSIS]"),
      false,
    );
    assertEquals(
      summaryText.includes("[IMAGE_OMITTED]\n[IMAGE_ANALYSIS_UNAVAILABLE]"),
      false,
    );
  } finally {
    restore();
    await rm(temporaryDirectory, { recursive: true });
  }
});

test("summarize — same-model vision fallback disables image attempts for later chunks", async () => {
  const temporaryDirectory = await createRoutingTestDirectory(
    "same-model-fallback",
  );
  const firstImagePath = `${temporaryDirectory}/first.jpg`;
  const secondImagePath = `${temporaryDirectory}/second.jpg`;
  await writeFile(firstImagePath, new Uint8Array([1, 2, 3]));
  await writeFile(secondImagePath, new Uint8Array([4, 5, 6]));
  const { captured, callCount, restore } = captureFetchSequence([
    { status: 400, body: '{"error":"multimodal unsupported"}' },
    { status: 200, body: modelResponse('[{"t":"first fallback","i":0}]') },
    { status: 200, body: modelResponse('[{"t":"second fallback","i":0}]') },
    { status: 200, body: modelResponse('[{"t":"merged fallback","i":0}]') },
  ]);
  try {
    const svc = createTestSummarizer({
      retryBaseDelayMs: 0,
      maxItemsPerChunk: 1,
    });
    const results = await svc.summarize(
      [
        item({
          text: "first",
          media: { type: "photo", localPath: firstImagePath },
        }),
        item({
          text: "second",
          media: { type: "photo", localPath: secondImagePath },
        }),
      ],
      buildNewsPrompt(),
    );
    assertEquals(callCount(), 4);
    assertEquals(results[0].text, "merged fallback");
    assertStringIncludes(
      JSON.stringify(captured[0].body.messages[1].content),
      "image_url",
    );
    for (const request of captured.slice(1)) {
      assertEquals(
        JSON.stringify(request.body.messages[1].content).includes("image_url"),
        false,
      );
    }
    assertStringIncludes(
      String(captured[1].body.messages[1].content),
      "[IMAGE_ANALYSIS_UNAVAILABLE]",
    );
    assertStringIncludes(
      String(captured[2].body.messages[1].content),
      "[IMAGE_ANALYSIS_UNAVAILABLE]",
    );
  } finally {
    restore();
    await rm(temporaryDirectory, { recursive: true });
  }
});

test("summarize — same-model vision does not fall back on unrelated provider failures", async () => {
  const temporaryDirectory = await createRoutingTestDirectory(
    "same-model-failure",
  );
  const imagePath = `${temporaryDirectory}/photo.jpg`;
  await writeFile(imagePath, new Uint8Array([1, 2, 3]));
  const { callCount, restore } = captureFetchSequence([
    { status: 401, body: '{"error":"unauthorized"}' },
  ]);
  try {
    const svc = createTestSummarizer({ retryBaseDelayMs: 0 });
    await assertRejects(
      () =>
        svc.summarize([
          item({ media: { type: "photo", localPath: imagePath } }),
        ], buildNewsPrompt()),
      Error,
      "Model API 401",
    );
    assertEquals(callCount(), 1);
  } finally {
    restore();
    await rm(temporaryDirectory, { recursive: true });
  }
});

test("summarize — vision failure is logged once per run and retried on the next run", async () => {
  const temporaryDirectory = await createRoutingTestDirectory("vision-retry");
  const imagePath = `${temporaryDirectory}/photo.jpg`;
  await writeFile(imagePath, new Uint8Array([1, 2, 3]));
  const { captured, callCount, restore } = captureFetchSequence([
    { status: 200, body: "not valid vision JSON" },
    { status: 200, body: modelResponse('[{"t":"first unavailable","i":0}]') },
    { status: 200, body: "not valid vision JSON" },
    { status: 200, body: modelResponse('[{"t":"second unavailable","i":0}]') },
  ]);
  const originalWarning = console.warn;
  const logs: unknown[][] = [];
  console.warn = (...arguments_: unknown[]) => {
    logs.push(arguments_);
  };
  try {
    const svc = createTestSummarizer({
      models: DISTINCT_TEST_MODELS,
      retryBaseDelayMs: 0,
    });
    await svc.summarize([
      item({ media: { type: "photo", localPath: imagePath } }),
    ], buildNewsPrompt());
    await svc.summarize([
      item({ media: { type: "photo", localPath: imagePath } }),
    ], buildNewsPrompt());
    assertEquals(callCount(), 4);
    assertEquals(logs.length, 2);
    assertEquals(
      logs.every((entry) =>
        entry[0] ===
          "[summarization] vision analysis unavailable at chunk 1/1; continuing with text-only fallback:"
      ),
      true,
    );
    assertEquals(String(logs[0][1]).includes("not valid vision JSON"), false);
    assertStringIncludes(
      String(captured[1].body.messages[1].content),
      "[IMAGE_ANALYSIS_UNAVAILABLE]",
    );
    assertStringIncludes(
      String(captured[3].body.messages[1].content),
      "[IMAGE_ANALYSIS_UNAVAILABLE]",
    );
  } finally {
    console.warn = originalWarning;
    restore();
    await rm(temporaryDirectory, { recursive: true });
  }
});

test("summarize — duplicate vision indexes merge distinct album descriptions", async () => {
  const temporaryDirectory = await createRoutingTestDirectory(
    "vision-duplicate-index",
  );
  const firstImagePath = `${temporaryDirectory}/first.jpg`;
  const secondImagePath = `${temporaryDirectory}/second.jpg`;
  await writeFile(firstImagePath, new Uint8Array([1, 2, 3]));
  await writeFile(secondImagePath, new Uint8Array([4, 5, 6]));
  const { captured, callCount, restore } = captureFetchSequence([
    {
      status: 200,
      body: modelResponse(
        '[{"i":0,"description":" first image "},{"i":0,"description":"second image"},{"i":0,"description":"first image"}]',
      ),
    },
    { status: 200, body: modelResponse('[{"t":"album summary","i":0}]') },
  ]);
  const originalWarning = console.warn;
  const warnings: unknown[][] = [];
  const diagnostics: SummarizationDiagnostic[] = [];
  console.warn = (...arguments_: unknown[]) => {
    warnings.push(arguments_);
  };

  try {
    const service = createTestSummarizer({
      models: DISTINCT_TEST_MODELS,
      retryBaseDelayMs: 0,
    });
    const result = await service.summarize(
      [item({
        media: {
          type: "album",
          localPaths: [firstImagePath, secondImagePath],
        },
      })],
      buildNewsPrompt(),
      {
        onDiagnostic: (diagnostic) => {
          diagnostics.push(diagnostic);
        },
      },
    );

    assertEquals(callCount(), 2);
    assertEquals(result[0].text, "album summary");
    assertEquals(
      captured[1].body.messages[1].content,
      "[0]\nSome news post\n[IMAGE_ANALYSIS]\nfirst image\nsecond image\n[/IMAGE_ANALYSIS]",
    );
    assertEquals(
      String(captured[1].body.messages[1].content).includes(
        "[IMAGE_ANALYSIS_UNAVAILABLE]",
      ),
      false,
    );
    assertEquals(warnings, []);
    assertEquals(diagnostics, []);
  } finally {
    console.warn = originalWarning;
    restore();
    await rm(temporaryDirectory, { recursive: true });
  }
});

test("summarize — duplicate vision indexes do not mask a missing expected index", async () => {
  const temporaryDirectory = await createRoutingTestDirectory(
    "vision-duplicate-missing-index",
  );
  const firstImagePath = `${temporaryDirectory}/first.jpg`;
  const secondImagePath = `${temporaryDirectory}/second.jpg`;
  await writeFile(firstImagePath, new Uint8Array([1, 2, 3]));
  await writeFile(secondImagePath, new Uint8Array([4, 5, 6]));
  const { captured, callCount, restore } = captureFetchSequence([
    {
      status: 200,
      body: modelResponse(
        '[{"i":0,"description":"first"},{"i":0,"description":"second"}]',
      ),
    },
    { status: 200, body: modelResponse('[{"t":"text fallback","i":0}]') },
  ]);
  const originalWarning = console.warn;
  const diagnostics: SummarizationDiagnostic[] = [];
  console.warn = () => {};

  try {
    const service = createTestSummarizer({
      models: DISTINCT_TEST_MODELS,
      retryBaseDelayMs: 0,
    });
    const result = await service.summarize(
      [
        item({
          externalId: "1",
          media: { type: "photo", localPath: firstImagePath },
        }),
        item({
          externalId: "2",
          media: { type: "photo", localPath: secondImagePath },
        }),
      ],
      buildNewsPrompt(),
      {
        onDiagnostic: (diagnostic) => {
          diagnostics.push(diagnostic);
        },
      },
    );

    assertEquals(callCount(), 2);
    assertEquals(result[0].text, "text fallback");
    assertStringIncludes(
      String(captured[1].body.messages[1].content),
      "[IMAGE_ANALYSIS_UNAVAILABLE]",
    );
    assertEquals(diagnostics, [{
      event: "vision_unavailable",
      chunkIndex: 1,
      chunkCount: 1,
      model: "vision-model",
      errorMessage: "vision response validation failed: expected=2 received=1",
    }]);
  } finally {
    console.warn = originalWarning;
    restore();
    await rm(temporaryDirectory, { recursive: true });
  }
});

test("summarize — text timeout after valid vision is not retried as vision fallback", async () => {
  const temporaryDirectory = await createRoutingTestDirectory(
    "vision-success-text-timeout",
  );
  const imagePath = `${temporaryDirectory}/photo.jpg`;
  await writeFile(imagePath, new Uint8Array([1, 2, 3]));
  const originalFetch = globalThis.fetch;
  const diagnostics: SummarizationDiagnostic[] = [];
  let callCount = 0;
  const textRequestContents: string[] = [];
  fetchEnvironment.fetch = ((_input: RequestInfo | URL, init?: RequestInit) => {
    callCount++;
    const request = JSON.parse(
      (init as RequestInit & { body: string }).body,
    ) as FetchRequest;
    if (callCount === 1) {
      return Promise.resolve(
        new Response(
          modelResponse('[{"i":0,"description":"visible image"}]'),
          {
            status: 200,
            headers: { "Content-Type": "application/json" },
          },
        ),
      );
    }
    textRequestContents.push(String(request.messages[1].content));
    return new Promise<Response>((resolve, reject) => {
      const responseTimer = setTimeout(
        () =>
          resolve(
            new Response(modelResponse('[{"t":"too late","i":0}]'), {
              status: 200,
              headers: { "Content-Type": "application/json" },
            }),
          ),
        50,
      );
      const signal = init?.signal;
      signal?.addEventListener(
        "abort",
        () => {
          clearTimeout(responseTimer);
          reject(signal.reason);
        },
        { once: true },
      );
    });
  });

  try {
    const service = createTestSummarizer({
      models: DISTINCT_TEST_MODELS,
      retryBaseDelayMs: 0,
    });
    await assertRejects(
      () =>
        service.summarize(
          [item({ media: { type: "photo", localPath: imagePath } })],
          buildNewsPrompt(),
          {
            requestTimeoutMs: 5,
            onDiagnostic: (diagnostic) => {
              diagnostics.push(diagnostic);
            },
          },
        ),
      DOMException,
      "Summarizer timed out",
    );

    assertEquals(callCount, 4);
    assertEquals(textRequestContents.length, 3);
    assert(
      textRequestContents.every((content) =>
        content.includes("[IMAGE_ANALYSIS]") &&
        content.includes("visible image") &&
        !content.includes("[IMAGE_ANALYSIS_UNAVAILABLE]")
      ),
    );
    assertEquals(
      diagnostics.some((diagnostic) =>
        diagnostic.event === "vision_unavailable"
      ),
      false,
    );
    assertEquals(diagnostics, [{
      event: "chunk_failed",
      chunkIndex: 1,
      chunkCount: 1,
      model: "text-model",
      errorMessage: "Summarizer timed out",
    }]);
  } finally {
    globalThis.fetch = originalFetch;
    await rm(temporaryDirectory, { recursive: true });
  }
});

test("summarize — allows remote base URL with opt-in", async () => {
  const restore = stubFetch({
    choices: [{ message: { content: '[{"t":"remote summary","i":0}]' } }],
  });
  try {
    const svc = createTestSummarizer({
      models: {
        summarizer: {
          model: "test-model",
          baseUrl: "https://api.openai.com/v1",
        },
        vision: { model: "test-model", baseUrl: "https://api.openai.com/v1" },
        sameModel: true,
      },
      retryBaseDelayMs: 0,
      allowRemoteSummarization: true,
    });
    const results = await svc.summarize([item()], buildNewsPrompt());
    assertEquals(results[0].text, "remote summary");
  } finally {
    restore();
  }
});

test("summarize — allows loopback URL without opt-in flag", async () => {
  const restore = stubFetch({
    choices: [{ message: { content: '[{"t":"local summary","i":0}]' } }],
  });
  try {
    const svc = createTestSummarizer({
      models: {
        summarizer: {
          model: "test-model",
          baseUrl: "http://127.0.0.1:1234/v1",
        },
        vision: { model: "test-model", baseUrl: "http://127.0.0.1:1234/v1" },
        sameModel: true,
      },
      retryBaseDelayMs: 0,
    });
    const results = await svc.summarize([item()], buildNewsPrompt());
    assertEquals(results[0].text, "local summary");
  } finally {
    restore();
  }
});

// --- Retry-After header ---

test("summarize — retries on 429 with Retry-After header", async () => {
  const original = globalThis.fetch;
  let callIndex = 0;
  const specs: Array<
    { status: number; body: string; headers: Record<string, string> }
  > = [
    {
      status: 429,
      body: '{"error":"rate limited"}',
      headers: { "Retry-After": "0", "Content-Type": "application/json" },
    },
    {
      status: 200,
      body:
        '{"choices":[{"message":{"content":"[{\\"t\\":\\"after retry-after\\",\\"i\\":0}]"}}]}',
      headers: { "Content-Type": "application/json" },
    },
  ];
  fetchEnvironment.fetch = (() => {
    const spec = specs[callIndex] ?? specs[specs.length - 1];
    callIndex++;
    return Promise.resolve(
      new Response(spec.body, { status: spec.status, headers: spec.headers }),
    );
  });
  try {
    const svc = createTestSummarizer({ retryBaseDelayMs: 0 });
    const results = await svc.summarize([item()], buildNewsPrompt());
    assertEquals(results[0].text, "after retry-after");
    assertEquals(callIndex, 2);
  } finally {
    globalThis.fetch = original;
  }
});
