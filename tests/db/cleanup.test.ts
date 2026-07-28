import { test } from "bun:test";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { assertEquals, assertThrows } from "../assertions.ts";
import {
  cleanupLocalDatabase,
  resolveLocalDatabasePath,
} from "../../src/db/cleanup.ts";
import { openDatabase } from "../../src/db/sqlite.ts";
import { resetLocalDatabase } from "../../src/db/reset.ts";

test("local cleanup resolves the configured development file", () => {
  assertEquals(
    resolveLocalDatabasePath({ DATABASE_PATH: " ./data/app.sqlite " }),
    resolve("./data/app.sqlite"),
  );
});

test("local cleanup rejects URLs, memory, and test or E2E files", () => {
  for (const databasePath of [
    "https://example.test/app.sqlite",
    ":memory:",
    "./data/app.test.sqlite",
    "./data/app-e2e.sqlite",
  ]) {
    assertThrows(
      () => resolveLocalDatabasePath({ DATABASE_PATH: databasePath }),
      Error,
    );
  }
  assertThrows(
    () =>
      resolveLocalDatabasePath({
        DATABASE_PATH: "./data/app.sqlite",
        TEST_DATABASE_PATH: "./data/app.sqlite",
      }),
    Error,
    "refuses test and E2E",
  );
});

test("cleanup removes application rows while retaining migration state", () => {
  const root = mkdtempSync(join(tmpdir(), "morning-post-cleanup-"));
  const databasePath = join(root, "app.sqlite");
  const connection = openDatabase(databasePath);
  connection.sqlite.exec(
    "CREATE TABLE app_rows (id INTEGER PRIMARY KEY); CREATE TABLE __drizzle_migrations (id INTEGER PRIMARY KEY); INSERT INTO app_rows VALUES (1); INSERT INTO __drizzle_migrations VALUES (1)",
  );
  connection.close();
  try {
    cleanupLocalDatabase(databasePath);
    const reopened = openDatabase(databasePath);
    try {
      assertEquals(reopened.sqlite.query("SELECT * FROM app_rows").all(), []);
      assertEquals(
        reopened.sqlite.query("SELECT * FROM __drizzle_migrations").all(),
        [{ id: 1 }],
      );
    } finally {
      reopened.close();
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("reset removes the database and its WAL companions", () => {
  const root = mkdtempSync(join(tmpdir(), "morning-post-reset-"));
  const databasePath = join(root, "app.sqlite");
  for (const path of [databasePath, `${databasePath}-wal`, `${databasePath}-shm`]) {
    writeFileSync(path, "fixture");
  }
  try {
    resetLocalDatabase(databasePath);
    assertEquals(existsSync(databasePath), false);
    assertEquals(existsSync(`${databasePath}-wal`), false);
    assertEquals(existsSync(`${databasePath}-shm`), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
