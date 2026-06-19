import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";

const url = Deno.env.get("DATABASE_URL");
if (!url) {
  console.error("DATABASE_URL environment variable is not set");
  Deno.exit(1);
}

const client = postgres(url);
const database = drizzle(client);

await migrate(database, { migrationsFolder: "./drizzle" });

console.log("Migrations applied.");
Deno.exit(0);
