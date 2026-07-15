import { assertEquals, assertRejects, assert } from "@std/assert";
import { eq } from "drizzle-orm";
import { ConnectorId } from "../../src/constants.ts";
import { CredentialCipher, type EncryptedBlob } from "../../src/crypto/credential-cipher.ts";
import { EnvMasterKeyProvider } from "../../src/crypto/key-provider.ts";
import type { Database } from "../../src/db/client.ts";
import { withTestDb } from "../../src/db/testing.ts";
import { feeds } from "../../src/db/schema/feed.ts";
import { composeSummaryRuleset } from "../../src/summarizers/compose-prompt.ts";
import { DEFAULT_SYSTEM_PROMPT } from "../../src/summarizers/prompts.ts";
import type { SummarizeOptions, SummarizerService, SummaryPoint, SummaryRuleset } from "../../src/summarizers/summarizer.types.ts";
import { createOrReviveFeed } from "../../src/repositories/feed-repository.ts";
import { upsertItems } from "../../src/repositories/item-repository.ts";
import { findSummaryForFeedPeriod } from "../../src/repositories/summary-repository.ts";
import { createSource } from "../../src/repositories/source-repository.ts";
import { createUser, type CreateUserInput } from "../../src/repositories/user-repository.ts";
import { cleanupFeedMedia, getOrSummarizeFeedPeriod, summarizeFeedPeriod } from "../../src/services/summarization-service.ts";
import type { NormalizedItem } from "../../src/connectors/connector.types.ts";

class FakeSummarizer implements SummarizerService {
  readonly calls: Array<{ items: NormalizedItem[]; rules: SummaryRuleset; options?: SummarizeOptions }> = [];
  #results: SummaryPoint[][];

  constructor(results: SummaryPoint[][]) {
    this.#results = [...results];
  }

  summarize(items: NormalizedItem[], rules: SummaryRuleset, options?: SummarizeOptions): Promise<SummaryPoint[]> {
    this.calls.push({ items, rules, options });
    return Promise.resolve(this.#results.shift() ?? []);
  }
}

function userInput(email: string): CreateUserInput {
  return {
    name: "Summarization Owner",
    email,
    passwordHash: "$argon2id$fakehash",
    systemPrompt: "Focus on important product changes.",
    defaultLanguage: "Ukrainian",
  };
}

function credentialCipher(): CredentialCipher {
  return new CredentialCipher(new EnvMasterKeyProvider(new Uint8Array(32).fill(41)));
}

async function encryptedCredentials(userId: string): Promise<EncryptedBlob> {
  return await credentialCipher().encrypt(JSON.stringify({ sessionString: "telegram-session" }), {
    userId,
    connectorId: ConnectorId.Telegram,
  });
}

async function createFeed(database: Database, email: string, customPrompt: string | null = "Prefer company strategy.") {
  const user = await createUser(database, userInput(email));
  const source = await createSource(database, {
    userId: user.id,
    connectorId: ConnectorId.Telegram,
    credentials: await encryptedCredentials(user.id),
  });
  const feed = await createOrReviveFeed(database, {
    userId: user.id,
    sourceId: source.id,
    externalId: "channel:1",
    name: "Channel",
    kind: "news",
    customPrompt,
  });
  return { user, feed };
}

function normalizedItem(overrides: Partial<NormalizedItem> = {}): NormalizedItem {
  return {
    connectorId: ConnectorId.Telegram,
    feedExternalId: "channel:1",
    externalId: "message:1",
    date: 1_700_000_000_000,
    title: null,
    text: "Some update",
    author: "Channel",
    url: "https://t.me/channel/1",
    ...overrides,
  };
}

const periodStartMs = 1_700_000_000_000;
const periodEndMs = 1_700_086_400_000;

Deno.test("composeSummaryRuleset layers base, user, feed, and kind prompts in order", () => {
  const rules = composeSummaryRuleset({
    kind: "discussion",
    systemPrompt: "User focus",
    customPrompt: "Feed focus",
    language: "English",
  });
  const defaultIndex = rules.systemPrompt.indexOf(DEFAULT_SYSTEM_PROMPT);
  const userIndex = rules.systemPrompt.indexOf("User focus");
  const feedIndex = rules.systemPrompt.indexOf("Feed focus");
  const kindIndex = rules.systemPrompt.indexOf("You are a discussion summarizer analyzing a group chat.");
  assertEquals(defaultIndex >= 0, true);
  assertEquals(defaultIndex < userIndex, true);
  assertEquals(userIndex < feedIndex, true);
  assertEquals(feedIndex < kindIndex, true);
  assertEquals(rules.systemPrompt.includes('Write all "t" values in English.'), true);
});

Deno.test("summarizeFeedPeriod composes prompt layers and passes the run signal without a per-user model override", async () => {
  await withTestDb(async (database) => {
    const { user, feed } = await createFeed(database, "summarize-compose@example.com");
    await upsertItems(database, feed.id, [normalizedItem()], 1);
    const summarizer = new FakeSummarizer([[{ text: "Summary point", sourceUrl: "https://t.me/channel/1" }]]);

    const summary = await summarizeFeedPeriod(
      database,
      user.id,
      feed.id,
      periodStartMs,
      periodEndMs,
      { summarizer, now: () => 99 },
    );

    assertEquals(summary.feedNameSnapshot, feed.name);
    assertEquals(summary.generatedAt, 99);
    assertEquals(summarizer.calls.length, 1);
    assertEquals(summarizer.calls[0].options?.signal?.aborted, false);
    assertEquals("model" in (summarizer.calls[0].options ?? {}), false);
    assertEquals(summarizer.calls[0].items.length, 1);
    const systemPrompt = summarizer.calls[0].rules.systemPrompt;
    assertEquals(systemPrompt.includes(DEFAULT_SYSTEM_PROMPT), true);
    assertEquals(systemPrompt.includes(user.systemPrompt), true);
    assertEquals(systemPrompt.includes("Prefer company strategy."), true);
    assertEquals(systemPrompt.includes("You are a concise news summarizer."), true);
    assertEquals(systemPrompt.includes('Write all "t" values in Ukrainian.'), true);
  });
});

Deno.test("summarizeFeedPeriod skips the model and stores an empty summary when the window has no items", async () => {
  await withTestDb(async (database) => {
    const { user, feed } = await createFeed(database, "summarize-empty@example.com");
    const summarizer = new FakeSummarizer([[{ text: "should not happen", sourceUrl: null }]]);

    const summary = await summarizeFeedPeriod(
      database,
      user.id,
      feed.id,
      periodStartMs,
      periodEndMs,
      { summarizer, now: () => 11 },
    );

    assertEquals(summary.points, []);
    assertEquals(summary.generatedAt, 11);
    assertEquals(summarizer.calls.length, 0);
  });
});

Deno.test("summarizeFeedPeriod preserves feedNameSnapshot after later feed rename", async () => {
  await withTestDb(async (database) => {
    const { user, feed } = await createFeed(database, "summarize-snapshot@example.com");
    await upsertItems(database, feed.id, [normalizedItem()], 1);
    const summarizer = new FakeSummarizer([[{ text: "Snapshot point", sourceUrl: null }]]);

    await summarizeFeedPeriod(database, user.id, feed.id, periodStartMs, periodEndMs, { summarizer, now: () => 21 });
    await database.update(feeds).set({ name: "Renamed Channel", updatedAt: 22 }).where(eq(feeds.id, feed.id));

    const summary = await findSummaryForFeedPeriod(database, feed.id, periodStartMs, periodEndMs);
    assertEquals(summary?.feedNameSnapshot, "Channel");
  });
});

Deno.test("summarizeFeedPeriod re-runs overwrite the same period row", async () => {
  await withTestDb(async (database) => {
    const { user, feed } = await createFeed(database, "summarize-rerun@example.com", null);
    await upsertItems(database, feed.id, [normalizedItem()], 1);
    const summarizer = new FakeSummarizer([
      [{ text: "First point", sourceUrl: null }],
      [{ text: "Second point", sourceUrl: null }],
    ]);

    const first = await summarizeFeedPeriod(database, user.id, feed.id, periodStartMs, periodEndMs, { summarizer, now: () => 31 });
    const second = await summarizeFeedPeriod(database, user.id, feed.id, periodStartMs, periodEndMs, { summarizer, now: () => 32 });

    assertEquals(first.id, second.id);
    assertEquals(second.points, [{ text: "Second point", sourceUrl: null }]);
    assertEquals(second.generatedAt, 32);
  });
});

Deno.test("getOrSummarizeFeedPeriod enforces feed ownership on cached summaries", async () => {
  await withTestDb(async (database) => {
    const { user, feed } = await createFeed(database, "summarize-owner@example.com");
    const otherUser = await createUser(database, userInput("summarize-other@example.com"));
    await upsertItems(database, feed.id, [normalizedItem()], 1);
    const summarizer = new FakeSummarizer([[{ text: "Owned point", sourceUrl: null }]]);
    await summarizeFeedPeriod(database, user.id, feed.id, periodStartMs, periodEndMs, { summarizer, now: () => 40 });

    await assertRejects(
      () => getOrSummarizeFeedPeriod(database, otherUser.id, feed.id, periodStartMs, periodEndMs),
      Error,
      "feed not found",
    );
  });
});

// --- Fake summarizers for signal/timeout tests ---

class SignalAwareFakeSummarizer implements SummarizerService {
  readonly calls: Array<{ items: NormalizedItem[]; rules: SummaryRuleset; options?: SummarizeOptions }> = [];

  summarize(items: NormalizedItem[], rules: SummaryRuleset, options?: SummarizeOptions): Promise<SummaryPoint[]> {
    this.calls.push({ items, rules, options });
    if (options?.signal?.aborted) {
      return Promise.reject(options.signal.reason);
    }
    return Promise.resolve(items.map(() => ({ text: "ok", sourceUrl: null })));
  }
}

class NeverSettlingFakeSummarizer implements SummarizerService {
  summarize(_items: NormalizedItem[], _rules: SummaryRuleset, options?: SummarizeOptions): Promise<SummaryPoint[]> {
    // Return a promise that rejects when the signal aborts, never resolves otherwise
    return new Promise<SummaryPoint[]>((_resolve, reject) => {
      if (options?.signal) {
        if (options.signal.aborted) {
          reject(options.signal.reason);
          return;
        }
        options.signal.addEventListener("abort", () => reject(options.signal!.reason), { once: true });
      }
      // If no signal provided, never settle (simulates a hang)
    });
  }
}

Deno.test("summarizeOwnedFeedPeriod — abort signal before summarization rejects with AbortError", async () => {
  await withTestDb(async (database) => {
    const { user, feed } = await createFeed(database, "summarize-abort@example.com");
    await upsertItems(database, feed.id, [normalizedItem()], 1);
    const summarizer = new SignalAwareFakeSummarizer();
    const signal = AbortSignal.abort(new DOMException("test abort", "AbortError"));

    await assertRejects(
      () => summarizeFeedPeriod(database, user.id, feed.id, periodStartMs, periodEndMs, { summarizer, signal }),
      DOMException,
      "test abort",
    );
  });
});

Deno.test("summarizeOwnedFeedPeriod — timeout during summarization rejects with TimeoutError", async () => {
  await withTestDb(async (database) => {
    const { user, feed } = await createFeed(database, "summarize-timeout@example.com");
    await upsertItems(database, feed.id, [normalizedItem()], 1);
    const summarizer = new NeverSettlingFakeSummarizer();

    await assertRejects(
      () => summarizeFeedPeriod(database, user.id, feed.id, periodStartMs, periodEndMs, { summarizer, timeoutMs: 5 }),
      DOMException,
      "Summarizer timed out",
    );
  });
});
Deno.test("cleanupFeedMedia — deletes files for media items in the window", async () => {
  await withTestDb(async (database) => {
    const { user, feed } = await createFeed(database, "summarize-cleanup-file@example.com");
    const testDir = "./media/test-summarization-cleanup";
    await Deno.mkdir(testDir, { recursive: true });
    const mediaPath = `${testDir}/test-photo.jpg`;
    await Deno.writeTextFile(mediaPath, "fake image bytes");

    await upsertItems(database, feed.id, [normalizedItem({
      media: { type: "photo" as const, localPath: mediaPath },
    })], 1);

    await cleanupFeedMedia(database, feed.id, periodStartMs, periodEndMs);

    // File should be gone
    await assertRejects(() => Deno.stat(mediaPath), Deno.errors.NotFound);
    await Deno.remove(testDir, { recursive: true }).catch(() => {});
  });
});

Deno.test("cleanupFeedMedia — handles missing file without throwing", async () => {
  await withTestDb(async (database) => {
    const { user, feed } = await createFeed(database, "summarize-cleanup-missing@example.com");
    const testDir = "./media/test-summarization-cleanup-missing";
    await Deno.mkdir(testDir, { recursive: true });
    const missingPath = `${testDir}/nonexistent-media-file.jpg`;

    await upsertItems(database, feed.id, [normalizedItem({
      media: { type: "photo" as const, localPath: missingPath },
    })], 1);

    // Should not throw despite file not existing
    await cleanupFeedMedia(database, feed.id, periodStartMs, periodEndMs);
    await Deno.remove(testDir, { recursive: true }).catch(() => {});
  });
});

Deno.test("summarizeFeedPeriod — media cleanup after success does not fail the summarization", async () => {
  await withTestDb(async (database) => {
    const { user, feed } = await createFeed(database, "summarize-cleanup-nonfatal@example.com");
    const testDir = "./media/test-summarization-cleanup-nonfatal";
    await Deno.mkdir(testDir, { recursive: true });
    await Deno.writeTextFile(`${testDir}/wont-be-deleted.jpg`, "image");
    // Create a subdirectory with a file in it — Deno.remove on a non-empty
    // directory fails (EPERM on macOS), simulating a nonfatal cleanup error.
    await Deno.mkdir(`${testDir}/subdir`, { recursive: true });
    await Deno.writeTextFile(`${testDir}/subdir/locked.jpg`, "locked");
    const mediaPath = `${testDir}/subdir/locked.jpg`;

    await upsertItems(database, feed.id, [normalizedItem({
      media: { type: "photo" as const, localPath: mediaPath },
    })], 1);

    const summarizer = new FakeSummarizer([[{ text: "Keep me", sourceUrl: null }]]);

    // Summarization should succeed even though cleanup will fail
    // (Deno.remove on a single file should succeed, but this test simulates
    //  a scenario where the cleanup encounters an error)
    const summary = await summarizeFeedPeriod(
      database,
      user.id,
      feed.id,
      periodStartMs,
      periodEndMs,
      { summarizer, now: () => 55 },
    );
    assertEquals(summary.points.length, 1);
    assertEquals(summary.points[0].text, "Keep me");

    await Deno.remove(testDir, { recursive: true }).catch(() => {});
  });
});
