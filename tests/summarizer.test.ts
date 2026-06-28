import { assertEquals, assertStringIncludes } from "@std/assert"
import { OpenAICompatibleSummarizerService } from "../src/summarizers/openai-compatible-summarizer.ts";
import {
  buildDiscussionPrompt,
  buildNewsPrompt,
  selectRuleset,
} from "../src/summarizers/prompts.ts";
import type { NormalizedItem } from "../src/connectors/connector.types.ts";
import { ConnectorId } from "../src/constants.ts";

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

type FetchRequest = { messages: Array<{ role: string; content: unknown }> };

function stubFetch(responseBody: unknown): () => void {
  const original = globalThis.fetch;
  globalThis.fetch = () =>
    Promise.resolve(
      new Response(JSON.stringify(responseBody), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );
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
  globalThis.fetch = (_input, init) => {
    state.body = JSON.parse((init as RequestInit & { body: string }).body);
    return Promise.resolve(
      new Response(JSON.stringify(responseBody), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );
  };
  return {
    captured: state,
    restore: () => {
      globalThis.fetch = original;
    },
  };
}

// --- prompt builders ---

Deno.test("buildNewsPrompt — contains t/i field instruction", () => {
  const { systemPrompt } = buildNewsPrompt();
  assertStringIncludes(systemPrompt, '"t"');
  assertStringIncludes(systemPrompt, '"i"');
});

Deno.test("buildDiscussionPrompt — contains discussion instruction", () => {
  const { systemPrompt } = buildDiscussionPrompt();
  assertStringIncludes(systemPrompt, "discussion summarizer");
});

Deno.test("buildNewsPrompt — explicit language overrides default", () => {
  const { systemPrompt } = buildNewsPrompt({ language: "Ukrainian" });
  assertStringIncludes(systemPrompt, "Ukrainian");
});

// --- selectRuleset ---

Deno.test("selectRuleset — explicit kind 'discussion' returns discussion ruleset", () => {
  const items = [item({ meta: { isGroup: false } })];
  const rules = selectRuleset(items, "discussion");
  assertStringIncludes(rules.systemPrompt, "discussion summarizer");
});

Deno.test("selectRuleset — explicit kind 'news' returns news ruleset", () => {
  const items = [item({ meta: { isGroup: true } })];
  const rules = selectRuleset(items, "news");
  assertStringIncludes(rules.systemPrompt, "news summarizer");
});

Deno.test("selectRuleset — no kind, isGroup=true infers discussion", () => {
  const items = [item({ meta: { isGroup: true } })];
  const rules = selectRuleset(items);
  assertStringIncludes(rules.systemPrompt, "discussion summarizer");
});

Deno.test("selectRuleset — no kind, isGroup=false infers news", () => {
  const items = [item({ meta: { isGroup: false } })];
  const rules = selectRuleset(items);
  assertStringIncludes(rules.systemPrompt, "news summarizer");
});

Deno.test("selectRuleset — explicit kind overrides meta.isGroup", () => {
  const items = [item({ meta: { isGroup: true } })];
  const rules = selectRuleset(items, "news");
  assertStringIncludes(rules.systemPrompt, "news summarizer");
});

// --- summarizer wiring ---

Deno.test(
  "summarize — sends configured system prompt to model",
  async () => {
    const { captured, restore } = captureFetch({
      choices: [{ message: { content: '[{"t":"x","i":0}]' } }],
    });
    const svc = new OpenAICompatibleSummarizerService(
      "test-model",
      "http://localhost",
    );
    await svc.summarize([item()], buildNewsPrompt());
    assertStringIncludes(captured.body!.messages[0].content as string, '"t"');
    restore();
  },
);

// --- emoji filter ---

Deno.test("buildContentParts — emoji-only item is filtered out", async () => {
  const { captured, restore } = captureFetch({
    choices: [{ message: { content: "[]" } }],
  });
  const svc = new OpenAICompatibleSummarizerService(
    "test-model",
    "http://localhost",
  );
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

Deno.test(
  "buildContentParts — discussion preset sends plain string and shows authors",
  async () => {
    const { captured, restore } = captureFetch({
      choices: [{ message: { content: "[]" } }],
    });
    const svc = new OpenAICompatibleSummarizerService(
      "test-model",
      "http://localhost",
    );
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
  },
);

// --- parsePoints ---

Deno.test("parsePoints — attaches metadata from indexedItems", async () => {
  const restore = stubFetch({
    choices: [{ message: { content: '[{"t":"summary bullet","i":0}]' } }],
  });
  const svc = new OpenAICompatibleSummarizerService(
    "test-model",
    "http://localhost",
  );
  const results = await svc.summarize([item()], buildNewsPrompt());
  assertEquals(results[0].text, "summary bullet");
  assertEquals(results[0].sourceUrl, "https://t.me/test/1");
  assertEquals(results[0].channel, "TestChannel");
  restore();
});

Deno.test(
  "parsePoints — strips markdown code fences from response",
  async () => {
    const restore = stubFetch({
      choices: [
        { message: { content: '```json\n[{"t":"fenced","i":0}]\n```' } },
      ],
    });
    const svc = new OpenAICompatibleSummarizerService(
      "test-model",
      "http://localhost",
    );
    const results = await svc.summarize([item()], buildNewsPrompt());
    assertEquals(results[0].text, "fenced");
    restore();
  },
);

Deno.test(
  "parsePoints — out-of-bounds sourceIndex yields null sourceUrl",
  async () => {
    const restore = stubFetch({
      choices: [{ message: { content: '[{"t":"orphan","i":99}]' } }],
    });
    const svc = new OpenAICompatibleSummarizerService(
      "test-model",
      "http://localhost",
    );
    const results = await svc.summarize([item()], buildNewsPrompt());
    assertEquals(results[0].text, "orphan");
    assertEquals(results[0].sourceUrl, null);
    restore();
  },
);

// --- retry / API error helpers ---

type ResponseSpec = { status: number; body: string };

function stubFetchSequence(specs: ResponseSpec[]): {
  callCount: () => number;
  restore: () => void;
} {
  const original = globalThis.fetch;
  let callIndex = 0;
  globalThis.fetch = () => {
    const spec = specs[callIndex] ?? specs[specs.length - 1];
    callIndex++;
    return Promise.resolve(
      new Response(spec.body, {
        status: spec.status,
        headers: { "Content-Type": "application/json" },
      }),
    );
  };
  return {
    callCount: () => callIndex,
    restore: () => {
      globalThis.fetch = original;
    },
  };
}

// --- retry behavior ---

Deno.test("summarize — retries on 429 and succeeds on second attempt", async () => {
  const { callCount, restore } = stubFetchSequence([
    { status: 429, body: '{"error":"rate limited"}' },
    { status: 200, body: '{"choices":[{"message":{"content":"[{\\"t\\":\\"ok\\",\\"i\\":0}]"}}]}' },
  ]);
  try {
    const svc = new OpenAICompatibleSummarizerService("test-model", "http://localhost", undefined, 0);
    const results = await svc.summarize([item()], buildNewsPrompt());
    assertEquals(results[0].text, "ok");
    assertEquals(callCount(), 2);
  } finally {
    restore();
  }
});

Deno.test("summarize — retries on 503 and succeeds on third attempt", async () => {
  const { callCount, restore } = stubFetchSequence([
    { status: 503, body: "Service Unavailable" },
    { status: 503, body: "Service Unavailable" },
    { status: 200, body: '{"choices":[{"message":{"content":"[{\\"t\\":\\"ok\\",\\"i\\":0}]"}}]}' },
  ]);
  try {
    const svc = new OpenAICompatibleSummarizerService("test-model", "http://localhost", undefined, 0);
    const results = await svc.summarize([item()], buildNewsPrompt());
    assertEquals(results[0].text, "ok");
    assertEquals(callCount(), 3);
  } finally {
    restore();
  }
});

Deno.test("summarize — does not retry on 400 (non-retryable status)", async () => {
  const { callCount, restore } = stubFetchSequence([
    { status: 400, body: '{"error":"bad request"}' },
  ]);
  try {
    const svc = new OpenAICompatibleSummarizerService("test-model", "http://localhost", undefined, 0);
    await svc.summarize([item()], buildNewsPrompt());
    throw new Error("expected summarize to throw on 400");
  } catch (err: unknown) {
    if (err instanceof Error && err.message === "expected summarize to throw on 400") throw err;
    assertEquals(err instanceof Error, true);
    assertStringIncludes((err as Error).message, "Summarizer API 400");
    assertStringIncludes((err as Error).message, "bad request");
    assertEquals(callCount(), 1);
  } finally {
    restore();
  }
});

Deno.test("summarize — includes response body in error message", async () => {
  const { restore } = stubFetchSequence([
    { status: 500, body: '{"error":"internal quota exceeded"}' },
  ]);
  try {
    const svc = new OpenAICompatibleSummarizerService("test-model", "http://localhost", undefined, 0);
    await svc.summarize([item()], buildNewsPrompt());
    throw new Error("expected summarize to throw on 500");
  } catch (err: unknown) {
    if (err instanceof Error && err.message === "expected summarize to throw on 500") throw err;
    assertEquals(err instanceof Error, true);
    assertStringIncludes((err as Error).message, "internal quota exceeded");
  } finally {
    restore();
  }
});

// --- parsePoints boundary cases ---

Deno.test("parsePoints — throws on empty response", async () => {
  const restore = stubFetch({
    choices: [{ message: { content: "" } }],
  });
  try {
    const svc = new OpenAICompatibleSummarizerService("test-model", "http://localhost");
    await svc.summarize([item()], buildNewsPrompt());
    throw new Error("expected summarize to throw on empty response");
  } catch (err: unknown) {
    if (err instanceof Error && err.message === "expected summarize to throw on empty response") throw err;
    assertEquals(err instanceof Error, true);
    assertStringIncludes((err as Error).message, "empty response");
  } finally {
    restore();
  }
});

Deno.test("parsePoints — throws on non-array JSON response", async () => {
  const restore = stubFetch({
    choices: [{ message: { content: '{"not":"an array"}' } }],
  });
  try {
    const svc = new OpenAICompatibleSummarizerService("test-model", "http://localhost");
    await svc.summarize([item()], buildNewsPrompt());
    throw new Error("expected summarize to throw on non-array response");
  } catch (err: unknown) {
    if (err instanceof Error && err.message === "expected summarize to throw on non-array response") throw err;
    assertEquals(err instanceof Error, true);
    assertStringIncludes((err as Error).message, "non-array");
  } finally {
    restore();
  }
});

Deno.test("parsePoints — throws on non-array object response", async () => {
  const restore = stubFetch({
    choices: [{ message: { content: '{"status":"ok","summary":"done"}' } }],
  });
  try {
    const svc = new OpenAICompatibleSummarizerService("test-model", "http://localhost");
    await svc.summarize([item()], buildNewsPrompt());
    throw new Error("expected summarize to throw on non-array");
  } catch (err: unknown) {
    if (err instanceof Error && err.message === "expected summarize to throw on non-array") throw err;
    assertEquals(err instanceof Error, true);
    assertStringIncludes((err as Error).message, "non-array");
  } finally {
    restore();
  }
});

Deno.test("parsePoints — strips bare fence without language tag", async () => {
  const restore = stubFetch({
    choices: [{ message: { content: '```\n[{"t":"bare","i":0}]\n```' } }],
  });
  try {
    const svc = new OpenAICompatibleSummarizerService("test-model", "http://localhost");
    const results = await svc.summarize([item()], buildNewsPrompt());
    assertEquals(results[0].text, "bare");
  } finally {
    restore();
  }
});

Deno.test("parsePoints — strips think tags before fence extraction", async () => {
  const restore = stubFetch({
    choices: [{ message: { content: '<think>reasoning</think>\n```json\n[{"t":"after think","i":0}]\n```' } }],
  });
  try {
    const svc = new OpenAICompatibleSummarizerService("test-model", "http://localhost");
    const results = await svc.summarize([item()], buildNewsPrompt());
    assertEquals(results[0].text, "after think");
  } finally {
    restore();
  }
});

Deno.test("parsePoints — throws on element without string t (prose turned to word array)", async () => {
  // jsonrepair turns "Sure, here is your summary:" into ["Sure","here is your summary:"]
  // — a valid array whose elements lack t/i, which should fail element validation.
  const restore = stubFetch({
    choices: [{ message: { content: "Sure, here is your summary:" } }],
  });
  try {
    const svc = new OpenAICompatibleSummarizerService("test-model", "http://localhost");
    await svc.summarize([item()], buildNewsPrompt());
    throw new Error("expected summarize to throw on element validation");
  } catch (err: unknown) {
    if (err instanceof Error && err.message === "expected summarize to throw on element validation") throw err;
    assertEquals(err instanceof Error, true);
    assertStringIncludes((err as Error).message, "non-object at index 0");
  } finally {
    restore();
  }
});
