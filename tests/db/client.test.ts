import { test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { assertEquals, assertThrows } from "../assertions.ts";
import { openDatabase } from "../../src/db/sqlite.ts";

test("database opener configures in-memory SQLite safely", () => {
  const connection = openDatabase(":memory:");
  try {
    assertEquals(connection.sqlite.query("PRAGMA foreign_keys").get(), {
      foreign_keys: 1,
    });
    assertEquals(connection.sqlite.query("PRAGMA busy_timeout").get(), {
      timeout: 5000,
    });
    assertEquals(connection.sqlite.query("PRAGMA synchronous").get(), {
      synchronous: 2,
    });
  } finally {
    connection.close();
  }
});

test("database opener creates parent directories and enables WAL for files", () => {
  const root = mkdtempSync(join(tmpdir(), "morning-post-client-"));
  const databasePath = join(root, "nested", "app.sqlite");
  const connection = openDatabase(databasePath);
  try {
    assertEquals(connection.sqlite.query("PRAGMA journal_mode").get(), {
      journal_mode: "wal",
    });
  } finally {
    connection.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("database opener rejects network URLs", () => {
  assertThrows(
    () => openDatabase("https://example.test/app.sqlite"),
    Error,
    "local SQLite path",
  );
});
