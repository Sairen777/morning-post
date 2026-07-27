import { test } from "bun:test";
import { assertEquals, assertRejects, assertThrows } from "../assertions.ts";
import { resolveLocalDatabaseUrl } from "../../src/db/cleanup.ts";
import {
  resetApplicationSchemas,
  resetLocalDatabase,
} from "../../src/db/reset.ts";

test("local database cleanup resolves a loopback development database", () => {
  assertEquals(
    resolveLocalDatabaseUrl({
      DATABASE_URL: "  postgres://user:password@localhost:5432/morningpost  ",
    }),
    "postgres://user:password@localhost:5432/morningpost",
  );
});

test("local database cleanup reads only its scoped environment variable", () => {
  const originalDatabaseUrl = process.env.DATABASE_URL;
  try {
    process.env.DATABASE_URL =
      "postgres://user:password@localhost:5432/morningpost";
    assertEquals(
      resolveLocalDatabaseUrl(),
      "postgres://user:password@localhost:5432/morningpost",
    );
  } finally {
    if (originalDatabaseUrl === undefined) {
      delete process.env.DATABASE_URL;
    } else {
      process.env.DATABASE_URL = originalDatabaseUrl;
    }
  }
});

test("local database cleanup rejects missing, remote, system, and test databases", () => {
  assertThrows(
    () => resolveLocalDatabaseUrl({ DATABASE_URL: "  " }),
    Error,
    "DATABASE_URL is required",
  );
  assertThrows(
    () =>
      resolveLocalDatabaseUrl({
        DATABASE_URL:
          "postgres://user:password@database.example.com/morningpost",
      }),
    Error,
    "refuses non-loopback",
  );
  assertThrows(
    () =>
      resolveLocalDatabaseUrl({
        DATABASE_URL: "postgres://localhost/morningpost",
      }),
    Error,
    "must include a username",
  );
  assertThrows(
    () =>
      resolveLocalDatabaseUrl({
        DATABASE_URL: "postgres://user:password@localhost/postgres",
      }),
    Error,
    "refuses protected database",
  );
  assertThrows(
    () =>
      resolveLocalDatabaseUrl({
        DATABASE_URL: "postgres://user:password@localhost/morningpost_test",
      }),
    Error,
    "refuses test and E2E databases",
  );
  assertThrows(
    () =>
      resolveLocalDatabaseUrl({
        DATABASE_URL: "postgres://user:password@localhost/morningpost_e2e",
      }),
    Error,
    "refuses test and E2E databases",
  );
});

test("local database reset drops both application schemas and recreates public transactionally", async () => {
  const operations: string[] = [];
  let transactionCount = 0;
  const client = {
    async begin(
      callback: (
        transaction: { unsafe(operation: string): Promise<unknown> },
      ) => Promise<void>,
    ): Promise<void> {
      transactionCount += 1;
      await callback({
        async unsafe(operation: string): Promise<unknown> {
          operations.push(operation);
          return [];
        },
      });
    },
  } as unknown as Parameters<typeof resetApplicationSchemas>[0];

  await resetApplicationSchemas(client);

  assertEquals(transactionCount, 1);
  assertEquals(operations, [
    "drop schema if exists public cascade",
    "drop schema if exists drizzle cascade",
    "create schema public",
  ]);
});

test("local database reset applies cleanup's safety guard before connecting", async () => {
  await assertRejects(
    () =>
      resetLocalDatabase(
        "postgres://user:password@database.example.com/morningpost",
      ),
    Error,
    "refuses non-loopback",
  );
});
