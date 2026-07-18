import { assertEquals, assertThrows } from "@std/assert";
import { resolveE2eDatabaseUrl } from "../scripts/e2e-environment.ts";

Deno.test("resolveE2eDatabaseUrl derives a dedicated database from the backend test URL", () => {
  assertEquals(
    resolveE2eDatabaseUrl({
      DATABASE_URL: "postgres://user:password@localhost:5432/morningpost",
      TEST_DATABASE_URL:
        "postgres://user:password@localhost:5432/morningpost_test",
    }),
    "postgres://user:password@localhost:5432/morningpost_e2e",
  );
});

Deno.test("resolveE2eDatabaseUrl ignores a blank explicit override", () => {
  assertEquals(
    resolveE2eDatabaseUrl({
      TEST_DATABASE_URL:
        "postgres://user:password@localhost:5432/morningpost_test",
      E2E_DATABASE_URL: "  ",
    }),
    "postgres://user:password@localhost:5432/morningpost_e2e",
  );
});

Deno.test("resolveE2eDatabaseUrl ignores blank comparison URLs", () => {
  assertEquals(
    resolveE2eDatabaseUrl({
      DATABASE_URL: "  ",
      TEST_DATABASE_URL:
        "postgres://user:password@localhost:5432/morningpost_test",
    }),
    "postgres://user:password@localhost:5432/morningpost_e2e",
  );
  assertEquals(
    resolveE2eDatabaseUrl({
      DATABASE_URL: "  ",
      TEST_DATABASE_URL: "\t",
      E2E_DATABASE_URL: "postgres://user:password@localhost:5432/browser_e2e",
    }),
    "postgres://user:password@localhost:5432/browser_e2e",
  );
});

Deno.test("resolveE2eDatabaseUrl accepts a dedicated explicit override", () => {
  assertEquals(
    resolveE2eDatabaseUrl({
      DATABASE_URL: "postgres://user:password@localhost:5432/morningpost",
      TEST_DATABASE_URL:
        "postgres://user:password@localhost:5432/morningpost_test",
      E2E_DATABASE_URL: "postgres://user:password@localhost:5432/browser_e2e",
    }),
    "postgres://user:password@localhost:5432/browser_e2e",
  );
});

Deno.test("resolveE2eDatabaseUrl rejects shared or ambiguously named databases", () => {
  assertThrows(
    () =>
      resolveE2eDatabaseUrl({
        DATABASE_URL: "postgres://user:password@localhost:5432/morningpost_e2e",
        E2E_DATABASE_URL:
          "postgres://user:password@localhost:5432/morningpost_e2e",
      }),
    Error,
    "must differ from DATABASE_URL",
  );
  assertThrows(
    () =>
      resolveE2eDatabaseUrl({
        E2E_DATABASE_URL: "postgres://user:password@localhost:5432/morningpost",
      }),
    Error,
    "must end with _e2e",
  );
  assertThrows(
    () => resolveE2eDatabaseUrl({}),
    Error,
    "TEST_DATABASE_URL or DATABASE_URL is required",
  );
});
