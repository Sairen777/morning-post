import { migrate } from "drizzle-orm/bun-sqlite/migrator";
import { openDatabase, type Database } from "./sqlite.ts";

/**
 * Runs `fn` against a freshly migrated in-memory SQLite database.
 *
 * Each call owns its database and connection, so tests are isolated without
 * holding an asynchronous callback open inside a native SQLite transaction.
 */
export async function withTestDb<T>(
  fn: (database: Database) => Promise<T>,
): Promise<T> {
  const connection = openDatabase(":memory:");
  try {
    migrate(connection.database, { migrationsFolder: "./drizzle" });
    return await fn(connection.database);
  } finally {
    connection.close();
  }
}
