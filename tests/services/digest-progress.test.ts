import { test } from "bun:test";
import { assertEquals } from "../assertions.ts";
import {
  createConsoleDigestProgressReporter,
  reportDigestModelAttempt,
  reportDigestProgress,
  type DigestModelUsageAggregate,
  type DigestProgressEvent,
} from "../../src/services/digest-progress.ts";

const event: DigestProgressEvent = {
  event: "analysis_checkpoint",
  runId: "run-1",
  elapsedMs: 17,
  batchIndex: 2,
  batchSize: 3,
  completedCount: 6,
  totalCount: 8,
  status: "complete",
};

test("disabled console progress reporter is silent", () => {
  const records: string[] = [];
  const reporter = createConsoleDigestProgressReporter(false, (record) => records.push(record));
  assertEquals(reporter, undefined);
  assertEquals(records, []);
});

test("console progress reporter emits only the closed structured event", () => {
  const records: string[] = [];
  const reporter = createConsoleDigestProgressReporter(true, (record) => records.push(record));
  reportDigestProgress(reporter, event);
  assertEquals(records.length, 1);
  assertEquals(JSON.parse(records[0]), event);
  assertEquals(Object.keys(JSON.parse(records[0])).sort(), [
    "batchIndex",
    "batchSize",
    "completedCount",
    "elapsedMs",
    "event",
    "runId",
    "status",
    "totalCount",
  ]);
});

test("reporter exceptions are isolated", () => {
  reportDigestProgress({ report: () => { throw new Error("logger unavailable"); } }, event);
});

test("model attempts emit stage-safe events and aggregate reported usage as lower bounds", () => {
  const events: DigestProgressEvent[] = [];
  const aggregate: DigestModelUsageAggregate = {
    attemptCount: 0,
    durationMs: 0,
    usageReportedAttemptCount: 0,
    promptTokensLowerBound: 0,
    completionTokensLowerBound: 0,
    totalTokensLowerBound: 0,
    saturated: false,
  };
  const reporter = { report: (reported: DigestProgressEvent) => events.push(reported) };
  reportDigestModelAttempt(reporter, "run-1", 20, "analysis", aggregate, {
    attempt: 1,
    durationMs: 12,
    status: "retry",
  });
  reportDigestModelAttempt(reporter, "run-1", 40, "media", aggregate, {
    attempt: 2,
    durationMs: 18,
    status: "success",
    usage: { promptTokens: 9, completionTokens: 4, totalTokens: 13 },
  });
  assertEquals(aggregate, {
    attemptCount: 2,
    durationMs: 30,
    usageReportedAttemptCount: 1,
    promptTokensLowerBound: 9,
    completionTokensLowerBound: 4,
    totalTokensLowerBound: 13,
    saturated: false,
  });
  assertEquals(events, [
    {
      event: "model_attempt",
      runId: "run-1",
      elapsedMs: 20,
      stage: "analysis",
      attempt: 1,
      durationMs: 12,
      status: "retry",
    },
    {
      event: "model_attempt",
      runId: "run-1",
      elapsedMs: 40,
      stage: "media",
      attempt: 2,
      durationMs: 18,
      status: "success",
      promptTokens: 9,
      completionTokens: 4,
      totalTokens: 13,
    },
  ]);
  const keys = events.flatMap((reported) => Object.keys(reported));
  for (const forbidden of [
    "prompt",
    "content",
    "url",
    "title",
    "credentials",
    "endpoint",
    "exception",
  ]) assertEquals(keys.includes(forbidden), false);
});

test("model usage aggregates remain exact below the safe-integer limit and saturate on overflow", () => {
  const maximum = Number.MAX_SAFE_INTEGER;
  const aggregate: DigestModelUsageAggregate = {
    attemptCount: maximum - 2,
    durationMs: maximum - 10,
    usageReportedAttemptCount: maximum - 2,
    promptTokensLowerBound: maximum - 10,
    completionTokensLowerBound: maximum - 10,
    totalTokensLowerBound: maximum - 10,
    saturated: false,
  };

  reportDigestModelAttempt(undefined, undefined, 0, "analysis", aggregate, {
    attempt: 1,
    durationMs: 9,
    status: "success",
    usage: { promptTokens: 9, completionTokens: 10, totalTokens: 11 },
  });
  assertEquals(aggregate, {
    attemptCount: maximum - 1,
    durationMs: maximum - 1,
    usageReportedAttemptCount: maximum - 1,
    promptTokensLowerBound: maximum - 1,
    completionTokensLowerBound: maximum,
    totalTokensLowerBound: maximum,
    saturated: true,
  });

  reportDigestModelAttempt(undefined, undefined, 0, "analysis", aggregate, {
    attempt: 2,
    durationMs: maximum,
    status: "failure",
    usage: {
      promptTokens: maximum,
      completionTokens: maximum,
      totalTokens: maximum,
    },
  });
  assertEquals(aggregate, {
    attemptCount: maximum,
    durationMs: maximum,
    usageReportedAttemptCount: maximum,
    promptTokensLowerBound: maximum,
    completionTokensLowerBound: maximum,
    totalTokensLowerBound: maximum,
    saturated: true,
  });
});

test("model attempt progress preserves every digest stage tag", () => {
  const stages = ["analysis", "classification", "summarization", "media"] as const;
  const events: DigestProgressEvent[] = [];
  for (const stage of stages) {
    reportDigestModelAttempt(
      { report: (reported) => events.push(reported) },
      "run-stages",
      1,
      stage,
      undefined,
      { attempt: 1, durationMs: 2, status: "success" },
    );
  }
  assertEquals(
    events.map((reported) =>
      reported.event === "model_attempt" ? reported.stage : undefined
    ),
    [...stages],
  );
});
