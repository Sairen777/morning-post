import { drizzle, type PostgresJsDatabase } from "drizzle-orm/postgres-js";
import postgres from "postgres";

const url = Deno.env.get("DATABASE_URL");
if (!url) {
  throw new Error("DATABASE_URL environment variable is not set");
}

const pool = postgres(url);

export const database = drizzle(pool);

export type Database = PostgresJsDatabase;
