import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";
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
    client = postgres(url);

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
