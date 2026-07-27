import type postgres from "postgres";
import {
  createLocalDatabaseClient,
  resolveLocalDatabaseUrl,
} from "./cleanup.ts";

const SCHEMA_RESET_OPERATIONS = [
  "drop schema if exists public cascade",
  "drop schema if exists drizzle cascade",
  "create schema public",
] as const;

export async function resetApplicationSchemas(
  client: Pick<postgres.Sql, "begin">,
): Promise<void> {
  await client.begin(async (transaction) => {
    for (const operation of SCHEMA_RESET_OPERATIONS) {
      await transaction.unsafe(operation);
    }
  });
}

export async function resetLocalDatabase(
  databaseUrl = resolveLocalDatabaseUrl(),
): Promise<void> {
  const client = createLocalDatabaseClient(databaseUrl);
  try {
    await resetApplicationSchemas(client);
  } finally {
    await client.end();
  }
}

if (import.meta.main) {
  const databaseUrl = resolveLocalDatabaseUrl();
  await resetLocalDatabase(databaseUrl);
  const databaseName = decodeURIComponent(
    new URL(databaseUrl).pathname.replace(/^\/+/, ""),
  );
  console.log(`Reset local database ${databaseName}`);
}
