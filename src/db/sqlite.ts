import { Database as SQLiteDatabase } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { drizzle, type BunSQLiteDatabase } from "drizzle-orm/bun-sqlite";
import * as schema from "./schema/index.ts";

export type Database = BunSQLiteDatabase<typeof schema>;

export interface OpenDatabaseResult {
  sqlite: SQLiteDatabase;
  database: Database;
  close: () => void;
}

function isMemoryDatabase(databasePath: string): boolean {
  return databasePath === ":memory:" || databasePath.startsWith("file::memory:");
}

export function configureSQLite(
  sqlite: SQLiteDatabase,
  databasePath: string,
): void {
  sqlite.exec("PRAGMA foreign_keys = ON");
  if (!isMemoryDatabase(databasePath)) {
    sqlite.exec("PRAGMA journal_mode = WAL");
  }
  sqlite.exec("PRAGMA busy_timeout = 5000");
  sqlite.exec("PRAGMA synchronous = FULL");
}

export function openDatabase(databasePath: string): OpenDatabaseResult {
  const normalizedPath = databasePath.trim();
  if (!normalizedPath) {
    throw new Error("DATABASE_PATH must be a non-empty local SQLite path");
  }
  if (/^[a-z][a-z\d+.-]*:\/\//i.test(normalizedPath)) {
    throw new Error("DATABASE_PATH must be a local SQLite path, not a URL");
  }
  if (!isMemoryDatabase(normalizedPath)) {
    mkdirSync(dirname(resolve(normalizedPath)), { recursive: true });
  }

  const sqlite = new SQLiteDatabase(normalizedPath, {
    create: true,
    strict: true,
  });
  try {
    configureSQLite(sqlite, normalizedPath);
    const database = drizzle(sqlite, { schema });
    return {
      sqlite,
      database,
      close: () => sqlite.close(),
    };
  } catch (error) {
    sqlite.close();
    throw error;
  }
}
