import { existsSync, unlinkSync } from "node:fs";
import { getConfig } from "../config.ts";
import { resolveLocalDatabasePath } from "./cleanup.ts";

export function resetLocalDatabase(
  databasePath = resolveLocalDatabasePath(),
): void {
  const safePath = resolveLocalDatabasePath({
    DATABASE_PATH: databasePath,
    TEST_DATABASE_PATH: process.env["TEST_DATABASE_PATH"],
    E2E_DATABASE_PATH: process.env["E2E_DATABASE_PATH"],
  });
  for (const path of [safePath, `${safePath}-wal`, `${safePath}-shm`]) {
    if (existsSync(path)) unlinkSync(path);
  }
}

if (import.meta.main) {
  const databasePath = resolveLocalDatabasePath({
    DATABASE_PATH: getConfig().databasePath,
    TEST_DATABASE_PATH: process.env["TEST_DATABASE_PATH"],
    E2E_DATABASE_PATH: process.env["E2E_DATABASE_PATH"],
  });
  resetLocalDatabase(databasePath);
  console.log(`Reset local database ${databasePath}`);
}
