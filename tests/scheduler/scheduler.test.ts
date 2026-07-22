import { test } from "bun:test";
import { type Cron, scheduledJobs } from "croner";
import {
  assert,
  assertEquals,
  assertThrows,
} from "../assertions.ts";
import { CronScheduler } from "../../src/scheduler/scheduler.ts";

function registeredJob(name: string) {
  const job = scheduledJobs.find((candidate) => candidate.name === name);
  assert(job, `Expected scheduled job ${name}`);
  return job;
}

test("CronScheduler requires unique job names", () => {
  const scheduler = new CronScheduler();
  try {
    scheduler.schedule("unique-name", "0 * * * *", () => {});
    assertThrows(
      () => scheduler.schedule("unique-name", "5 * * * *", () => {}),
      Error,
      'A scheduled job named "unique-name" is already registered',
    );
  } finally {
    scheduler.stop();
  }
});

test("CronScheduler strictly accepts five-field expressions", () => {
  const scheduler = new CronScheduler();
  try {
    assertThrows(
      () => scheduler.schedule("six-fields", "0 0 * * * *", () => {}),
      Error,
    );
  } finally {
    scheduler.stop();
  }
});

test("CronScheduler evaluates schedules in UTC", () => {
  const scheduler = new CronScheduler();
  try {
    scheduler.schedule("utc-job", "0 0 * * *", () => {});
    const next = registeredJob("utc-job").nextRun(
      new Date("2026-01-01T12:34:56.000Z"),
    );
    assertEquals(next?.toISOString(), "2026-01-02T00:00:00.000Z");
  } finally {
    scheduler.stop();
  }
});

test("CronScheduler enables async overlap protection", () => {
  let protect: unknown;
  const scheduler = new CronScheduler((_pattern, options) => {
    protect = options.protect;
    return { stop() {} } as Cron;
  });

  scheduler.schedule("protected-job", "0 * * * *", async () => {});
  assertEquals(protect, true);
  scheduler.stop();
});

test("CronScheduler logs failures and continues later schedules", async () => {
  const scheduler = new CronScheduler();
  const originalError = console.error;
  const errors: unknown[][] = [];
  let calls = 0;
  console.error = (...args: unknown[]) => {
    errors.push(args);
  };

  try {
    scheduler.schedule("recovering-job", "0 * * * *", async () => {
      calls++;
      if (calls === 1) throw new Error("scheduler secret failure");
    });
    const job = registeredJob("recovering-job");
    await job.trigger();
    await job.trigger();
    assertEquals(calls, 2);
    assert(
      errors.some((args) =>
        String(args[0]) ===
          'Scheduled job "recovering-job" failed: scheduler secret failure'
      ),
    );
  } finally {
    console.error = originalError;
    scheduler.stop();
  }
});

test("CronScheduler stop is idempotent and removes registered jobs", () => {
  const scheduler = new CronScheduler();
  scheduler.schedule("stopped-job", "0 * * * *", () => {});
  assert(registeredJob("stopped-job"));
  scheduler.stop();
  scheduler.stop();
  assertEquals(
    scheduledJobs.some((job) => job.name === "stopped-job"),
    false,
  );
});
