import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";
import { getConfig } from "../config.ts";
import type { Database } from "./client.ts";

let migrationPromise: Promise<void> | null = null;

class TestRollback extends Error {
  constructor() {
    super("test transaction rollback marker");
  }
}

/**
 * Runs `fn` inside a Postgres transaction that is always rolled back.
 *
 * The test database is migrated once per process. Every call starts a fresh
 * connection, passes a Drizzle `Database` to `fn`, and rolls back when `fn`
 * returns — so tests are isolated and order-independent. Errors in `fn`
 * propagate normally; the rollback still happens.
 */
export async function withTestDb<T>(
  fn: (database: Database) => Promise<T>,
): Promise<T> {
  const url = Deno.env.get("TEST_DATABASE_URL");
  if (!url) {
    throw new Error("TEST_DATABASE_URL environment variable is not set");
  }

  let client: postgres.Sql | undefined;
  try {
    const config = getConfig({ databaseUrl: url });
    client = postgres(url, {
      max: config.databasePoolMax,
      idle_timeout: config.databaseIdleTimeoutSeconds,
      connect_timeout: config.databaseConnectTimeoutSeconds,
      ssl: config.databaseSslMode === "disable" ? false : config.databaseSslMode,
      max_lifetime: 45 * 60,
      backoff: (attemptNum) => (0.5 + Math.random() / 2) * Math.min(3 ** attemptNum / 100, 20),
      keep_alive: 60,
      prepare: true,
      debug: false,
      fetch_types: true,
      publications: "alltables",
      target_session_attrs: undefined,
      // postgres.js reads this default through PGMAX_PIPELINE unless supplied.
      max_pipeline: 100,
    } as Parameters<typeof postgres>[1]);
    const database = drizzle(client);

    migrationPromise ??= migrate(database, { migrationsFolder: "./drizzle" });
    await migrationPromise;

    let result: T;
    try {
      await database.transaction(async (transaction) => {
        result = await fn(transaction as Database);
        throw new TestRollback();
      });
    } catch (error) {
      if (error instanceof TestRollback) {
        return result!;
      }
      throw error;
    }

    // TypeScript cannot prove the inner try always returns or throws.
    throw new Error("unreachable — transaction is always rolled back");
  } finally {
    await client?.end();
  }
}
