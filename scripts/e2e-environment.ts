import { rm } from "node:fs/promises";
import { resolve } from "node:path";
import { migrate } from "drizzle-orm/bun-sqlite/migrator";
import { openDatabase } from "../src/db/sqlite.ts";

const E2E_API_PORT = 3_100;
const E2E_WEB_ORIGIN = "http://127.0.0.1:5174";

type Environment = Record<string, string | undefined>;

export function resolveE2eDatabasePath(
  environment: Environment = process.env,
): string {
  const configured = environment.E2E_DATABASE_PATH?.trim() ||
    "./data/morning-post-e2e.sqlite";
  if (configured === ":memory:" || configured.startsWith("file:")) {
    throw new Error("E2E_DATABASE_PATH must be a local SQLite file path");
  }

  const resolvedPath = resolve(configured);
  if (!resolvedPath.toLowerCase().endsWith(".sqlite")) {
    throw new Error("E2E_DATABASE_PATH must end with .sqlite");
  }
  if (!resolvedPath.toLowerCase().includes("e2e")) {
    throw new Error("E2E_DATABASE_PATH must identify an E2E database");
  }

  for (
    const [name, value] of [
      ["DATABASE_PATH", environment.DATABASE_PATH],
      ["TEST_DATABASE_PATH", environment.TEST_DATABASE_PATH],
    ] as const
  ) {
    const otherPath = value?.trim();
    if (otherPath && otherPath !== ":memory:" && resolve(otherPath) === resolvedPath) {
      throw new Error(`E2E_DATABASE_PATH must differ from ${name}`);
    }
  }
  return resolvedPath;
}

async function removeSqliteFiles(databasePath: string): Promise<void> {
  await Promise.all(
    [databasePath, `${databasePath}-wal`, `${databasePath}-shm`].map((path) =>
      rm(path, { force: true })
    ),
  );
}

async function resetE2eDatabase(databasePath: string): Promise<void> {
  await removeSqliteFiles(databasePath);
  const connection = openDatabase(databasePath);
  try {
    migrate(connection.database, { migrationsFolder: "./drizzle" });
  } finally {
    connection.close();
  }
}

async function prepareE2eDatabase(): Promise<string> {
  const databasePath = resolveE2eDatabasePath();
  await resetE2eDatabase(databasePath);
  return databasePath;
}


async function startE2eApi(): Promise<void> {
  const databasePath = await prepareE2eDatabase();
  process.env.DATABASE_PATH = databasePath;
  process.env.PORT = String(E2E_API_PORT);
  process.env.ALLOWED_ORIGINS = E2E_WEB_ORIGIN;
  const { bootServer } = await import("../src/server/main.ts");
  await bootServer();
}

async function cleanupE2eDatabase(): Promise<void> {
  await removeSqliteFiles(resolveE2eDatabasePath());
}

if (import.meta.main) {
  const command = process.argv[2];
  if (command === "start-api") {
    await startE2eApi();
  } else if (command === "cleanup") {
    await cleanupE2eDatabase();
  } else {
    throw new Error("Expected start-api or cleanup");
  }
}
