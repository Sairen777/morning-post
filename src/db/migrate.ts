import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";

const DEFAULT_IDLE_TIMEOUT_SECONDS = 20;
const DEFAULT_CONNECT_TIMEOUT_SECONDS = 30;

function positiveIntegerFromEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined) return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`${name} must be a positive integer`);
  }
  return value;
}

const url = process.env["DATABASE_URL"];
if (!url) {
  throw new Error("DATABASE_URL environment variable is not set");
}

const connectionUrl = new URL(url);
const databaseName = decodeURIComponent(connectionUrl.pathname.replace(/^\/+/, ""));
if (!databaseName) {
  throw new Error("DATABASE_URL must include a database name");
}

const sslMode = process.env["DB_SSL_MODE"] ?? "disable";
if (sslMode !== "disable" && sslMode !== "require" && sslMode !== "verify-full") {
  throw new Error("DB_SSL_MODE must be disable, require, or verify-full");
}

const client = postgres(url, {
  // Migrations are intentionally single-connection work.
  max: 1,
  host: connectionUrl.hostname,
  port: Number(connectionUrl.port || 5432),
  database: databaseName,
  username: decodeURIComponent(connectionUrl.username),
  password: decodeURIComponent(connectionUrl.password),
  idle_timeout: positiveIntegerFromEnv("DB_IDLE_TIMEOUT_SECONDS", DEFAULT_IDLE_TIMEOUT_SECONDS),
  connect_timeout: positiveIntegerFromEnv("DB_CONNECT_TIMEOUT_SECONDS", DEFAULT_CONNECT_TIMEOUT_SECONDS),
  ssl: sslMode === "disable" ? false : sslMode,
  // Set every postgres.js default that otherwise consults a PG* environment key.
  max_lifetime: 45 * 60,
  max_pipeline: 100,
  backoff: (attemptNum: number) => (0.5 + Math.random() / 2) * Math.min(3 ** attemptNum / 100, 20),
  keep_alive: 60,
  prepare: true,
  debug: false,
  fetch_types: true,
  publications: "alltables",
  target_session_attrs: "read-write",
} as Parameters<typeof postgres>[1]);
const database = drizzle(client);

try {
  await migrate(database, { migrationsFolder: "./drizzle" });
  console.log("Migrations applied.");
} finally {
  await client.end();
}
