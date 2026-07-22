import { test } from "bun:test";
import { readFile, rm } from "node:fs/promises";
import { assertEquals, assertStringIncludes } from "./assertions.ts";
import {
  appendOperationalLog,
  type OperationalLogEvent,
} from "../src/observability/operational-log.ts";

const directory = ".test-data/operational-log";
const path = `${directory}/operations.jsonl`;

async function resetDirectory(): Promise<void> {
  await rm(directory, { recursive: true, force: true });
}

function event(
  overrides: Partial<OperationalLogEvent> = {},
): OperationalLogEvent {
  return {
    level: "error",
    event: "summarization.feed_failed",
    runId: "run-1",
    feedId: "feed-1",
    connectorId: "Telegram",
    itemCount: 117,
    errorMessage: "Summarizer timed out",
    ...overrides,
  };
}

test("appendOperationalLog writes redacted structured JSON lines", async () => {
  await resetDirectory();
  try {
    await appendOperationalLog(
      event({
        errorMessage:
          "Authorization: Bearer abcdefghijklmnopqrstuvwxyz and sk-1234567890abcdefghijklmnop",
      }),
      { path, now: () => 1_789_700_000_000 },
    );

    const lines = (await readFile(path, "utf8")).trim().split("\n");
    assertEquals(lines.length, 1);
    const parsed = JSON.parse(lines[0]);
    assertEquals(parsed.timestampMs, 1_789_700_000_000);
    assertEquals(parsed.event, "summarization.feed_failed");
    assertEquals(parsed.feedId, "feed-1");
    assertStringIncludes(parsed.errorMessage, "[REDACTED]");
    assertEquals(
      parsed.errorMessage.includes("abcdefghijklmnopqrstuvwxyz"),
      false,
    );
    assertEquals(parsed.errorMessage.includes("sk-1234567890"), false);
  } finally {
    await resetDirectory();
  }
});

test("appendOperationalLog keeps one bounded rotated file", async () => {
  await resetDirectory();
  try {
    await appendOperationalLog(
      event({ runId: "first-run", errorMessage: "first ".repeat(100) }),
      { path, maximumBytes: 300, now: () => 100 },
    );
    await appendOperationalLog(
      event({ runId: "second-run", errorMessage: "second ".repeat(100) }),
      { path, maximumBytes: 300, now: () => 200 },
    );

    const rotated = JSON.parse((await readFile(`${path}.1`, "utf8")).trim());
    const current = JSON.parse((await readFile(path, "utf8")).trim());
    assertEquals(rotated.runId, "first-run");
    assertEquals(current.runId, "second-run");
  } finally {
    await resetDirectory();
  }
});
