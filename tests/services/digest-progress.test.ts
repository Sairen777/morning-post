import { test } from "bun:test";
import { assertEquals } from "../assertions.ts";
import {
  createConsoleDigestProgressReporter,
  reportDigestProgress,
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
