import { resolve } from "node:path";
import { getConfig } from "../config.ts";
import { openDatabase } from "./sqlite.ts";

type Environment = Record<string, string | undefined>;

export function resolveLocalDatabasePath(
  environment: Environment = {
    DATABASE_PATH: process.env["DATABASE_PATH"],
    TEST_DATABASE_PATH: process.env["TEST_DATABASE_PATH"],
    E2E_DATABASE_PATH: process.env["E2E_DATABASE_PATH"],
  },
): string {
  const configuredPath = environment.DATABASE_PATH?.trim() ||
    "./data/morning-post.sqlite";
  if (configuredPath === ":memory:" || /^[a-z][a-z\d+.-]*:\/\//i.test(configuredPath)) {
    throw new Error("Local database cleanup requires a local SQLite file path");
  }

  const databasePath = resolve(configuredPath);
  for (const protectedPath of [
    environment.TEST_DATABASE_PATH,
    environment.E2E_DATABASE_PATH,
  ]) {
    if (protectedPath?.trim() && resolve(protectedPath.trim()) === databasePath) {
      throw new Error("Local database cleanup refuses test and E2E database files");
    }
  }
  if (/(?:^|[._-])(test|e2e)(?:[._-]|$)/i.test(databasePath.split("/").at(-1) ?? "")) {
    throw new Error("Local database cleanup refuses test and E2E database files");
  }
  return databasePath;
}

export function cleanupLocalDatabase(
  databasePath = resolveLocalDatabasePath(),
): void {
  const safePath = resolveLocalDatabasePath({
    DATABASE_PATH: databasePath,
    TEST_DATABASE_PATH: process.env["TEST_DATABASE_PATH"],
    E2E_DATABASE_PATH: process.env["E2E_DATABASE_PATH"],
  });
  const connection = openDatabase(safePath);
  try {
    const tableNames = connection.sqlite.query<
      { name: string },
      []
    >("SELECT name FROM sqlite_schema WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name <> '__drizzle_migrations' ORDER BY name").all();
    connection.sqlite.transaction(() => {
      connection.sqlite.exec("PRAGMA defer_foreign_keys = ON");
      for (const { name } of tableNames) {
        connection.sqlite.exec(`DELETE FROM "${name.replaceAll('"', '""')}"`);
      }
      const hasSequence = connection.sqlite.query<{ present: number }, []>(
        "SELECT 1 AS present FROM sqlite_schema WHERE type = 'table' AND name = 'sqlite_sequence'",
      ).get();
      if (hasSequence) connection.sqlite.exec("DELETE FROM sqlite_sequence");
    }).immediate();
  } finally {
    connection.close();
  }
}

if (import.meta.main) {
  const databasePath = resolveLocalDatabasePath({
    DATABASE_PATH: getConfig().databasePath,
    TEST_DATABASE_PATH: process.env["TEST_DATABASE_PATH"],
    E2E_DATABASE_PATH: process.env["E2E_DATABASE_PATH"],
  });
  cleanupLocalDatabase(databasePath);
  console.log(`Cleared local database ${databasePath}`);
}
