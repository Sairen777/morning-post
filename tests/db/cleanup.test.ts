import { assertEquals, assertThrows } from "@std/assert";
import { resolveLocalDatabaseUrl } from "../../src/db/cleanup.ts";

Deno.test("local database cleanup resolves a loopback development database", () => {
  assertEquals(
    resolveLocalDatabaseUrl({
      DATABASE_URL: "  postgres://user:password@localhost:5432/morningpost  ",
    }),
    "postgres://user:password@localhost:5432/morningpost",
  );
});

Deno.test({
  name: "local database cleanup reads only its permitted environment variable",
  permissions: { env: ["DATABASE_URL"] },
  fn() {
    const originalDatabaseUrl = Deno.env.get("DATABASE_URL");
    try {
      Deno.env.set(
        "DATABASE_URL",
        "postgres://user:password@localhost:5432/morningpost",
      );
      assertEquals(
        resolveLocalDatabaseUrl(),
        "postgres://user:password@localhost:5432/morningpost",
      );
    } finally {
      if (originalDatabaseUrl === undefined) {
        Deno.env.delete("DATABASE_URL");
      } else {
        Deno.env.set("DATABASE_URL", originalDatabaseUrl);
      }
    }
  },
});

Deno.test("local database cleanup rejects missing, remote, system, and test databases", () => {
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
