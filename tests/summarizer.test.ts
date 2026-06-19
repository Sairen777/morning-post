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
