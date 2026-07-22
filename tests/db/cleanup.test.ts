import { test } from "bun:test";
import { assertEquals, assertThrows } from "../assertions.ts"
import { resolveLocalDatabaseUrl } from "../../src/db/cleanup.ts";

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
