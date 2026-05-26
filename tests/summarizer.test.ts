import { assertEquals, assertStringIncludes } from "jsr:@std/assert";
import { OpenAICompatibleSummarizerService } from "../src/summarizers/openai-compatible-summarizer.ts";
import type { NormalizedItem } from "../src/summarizers/summarizer.types.ts";

const item = (overrides: Partial<NormalizedItem> = {}): NormalizedItem => ({
  connectorId: "telegram",
  sourceId: "TestChannel",
  date: new Date("2026-01-01T10:00:00Z"),
  title: null,
  text: "Some news post",
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

// --- system prompt ---

Deno.test(
  "buildSystemPrompt news mode — contains t/i field instruction",
  async () => {
    const { captured, restore } = captureFetch({
      choices: [{ message: { content: '[{"t":"x","i":0}]' } }],
    });
    const svc = new OpenAICompatibleSummarizerService(
      "test-model",
      "http://localhost",
    );
    await svc.summarize([item()], {});
    assertStringIncludes(captured.body!.messages[0].content as string, '"t"');
    assertStringIncludes(captured.body!.messages[0].content as string, '"i"');
    restore();
  },
);

Deno.test(
  "buildSystemPrompt discussion mode — contains discussion instruction",
  async () => {
    const { captured, restore } = captureFetch({
      choices: [{ message: { content: '[{"t":"x","i":0}]' } }],
    });
    const svc = new OpenAICompatibleSummarizerService(
      "test-model",
      "http://localhost",
    );
    await svc.summarize([item({ isGroup: true, author: "@user" })], {
      mode: "discussion",
    });
    assertStringIncludes(
      captured.body!.messages[0].content as string,
      "discussion summarizer",
    );
    restore();
  },
);

Deno.test(
  "buildSystemPrompt — explicit language overrides default",
  async () => {
    const { captured, restore } = captureFetch({
      choices: [{ message: { content: '[{"t":"x","i":0}]' } }],
    });
    const svc = new OpenAICompatibleSummarizerService(
      "test-model",
      "http://localhost",
    );
    await svc.summarize([item()], { language: "Ukrainian" });
    assertStringIncludes(
      captured.body!.messages[0].content as string,
      "Ukrainian",
    );
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
    {},
  );
  const parts = captured.body!.messages[1].content as Array<{ text: string }>;
  // Only the real news item should be present, indexed as [0]
  const texts = parts.map((p) => p.text).join("\n");
  assertStringIncludes(texts, "[0]");
  assertEquals(texts.includes("[1]"), false);
  restore();
});

Deno.test(
  "buildContentParts — discussion mode sends plain string not array",
  async () => {
    const { captured, restore } = captureFetch({
      choices: [{ message: { content: "[]" } }],
    });
    const svc = new OpenAICompatibleSummarizerService(
      "test-model",
      "http://localhost",
    );
    await svc.summarize(
      [item({ text: "hello", isGroup: true, author: "@alice" })],
      { mode: "discussion" },
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
  const results = await svc.summarize([item()], {});
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
    const results = await svc.summarize([item()], {});
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
    const results = await svc.summarize([item()], {});
    assertEquals(results[0].text, "orphan");
    assertEquals(results[0].sourceUrl, null);
    restore();
  },
);
