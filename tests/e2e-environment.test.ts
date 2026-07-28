import { test } from "bun:test";
import { resolve } from "node:path";
import { resolveE2eDatabasePath } from "../scripts/e2e-environment.ts";
import { assertEquals, assertThrows } from "./assertions.ts";

test("resolveE2eDatabasePath uses a dedicated local SQLite file by default", () => {
  assertEquals(
    resolveE2eDatabasePath({}),
    resolve("./data/morning-post-e2e.sqlite"),
  );
});

test("resolveE2eDatabasePath accepts a dedicated explicit override", () => {
  assertEquals(
    resolveE2eDatabasePath({
      DATABASE_PATH: "./data/morning-post.sqlite",
      TEST_DATABASE_PATH: "./data/morning-post-test.sqlite",
      E2E_DATABASE_PATH: "./tmp/browser-e2e.sqlite",
    }),
    resolve("./tmp/browser-e2e.sqlite"),
  );
});

test("resolveE2eDatabasePath rejects unsafe or shared paths", () => {
  assertThrows(
    () => resolveE2eDatabasePath({ E2E_DATABASE_PATH: ":memory:" }),
    Error,
    "local SQLite file path",
  );
  assertThrows(
    () =>
      resolveE2eDatabasePath({
        DATABASE_PATH: "./tmp/browser-e2e.sqlite",
        E2E_DATABASE_PATH: "./tmp/browser-e2e.sqlite",
      }),
    Error,
    "must differ from DATABASE_PATH",
  );
  assertThrows(
    () =>
      resolveE2eDatabasePath({
        TEST_DATABASE_PATH: "./tmp/browser-e2e.sqlite",
        E2E_DATABASE_PATH: "./tmp/browser-e2e.sqlite",
      }),
    Error,
    "must differ from TEST_DATABASE_PATH",
  );
  assertThrows(
    () => resolveE2eDatabasePath({ E2E_DATABASE_PATH: "./tmp/browser.sqlite" }),
    Error,
    "identify an E2E database",
  );
  assertThrows(
    () => resolveE2eDatabasePath({ E2E_DATABASE_PATH: "./tmp/browser-e2e.db" }),
    Error,
    "must end with .sqlite",
  );
});
