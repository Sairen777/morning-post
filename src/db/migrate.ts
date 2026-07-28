import { migrate } from "drizzle-orm/bun-sqlite/migrator";
import { getConfig } from "../config.ts";
import { openDatabase } from "./sqlite.ts";

export function migrateDatabase(databasePath = getConfig().databasePath): void {
  const connection = openDatabase(databasePath);
  try {
    migrate(connection.database, { migrationsFolder: "./drizzle" });
  } finally {
    connection.close();
  }
}

if (import.meta.main) {
  const databasePath = getConfig().databasePath;
  migrateDatabase(databasePath);
  console.log(`Migrations applied to ${databasePath}.`);
}
