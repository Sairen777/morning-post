import { drizzle, type PostgresJsDatabase } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { getConfig, type Config, type DatabaseSslMode } from "../config.ts";

export interface DatabaseClientOptions {
  max: number;
  idle_timeout: number;
  connect_timeout: number;
  ssl: false | Exclude<DatabaseSslMode, "disable">;
  max_lifetime: number | null;
  backoff: boolean | ((attemptNum: number) => number);
  keep_alive: number | null;
  prepare: boolean;
  debug: boolean;
  fetch_types: boolean;
  publications: string;
  target_session_attrs: undefined;
}

const LOOPBACK_HOSTS = new Set(["", "localhost", "127.0.0.1", "::1"]);

function isLoopbackDatabaseUrl(url: string): boolean {
  try {
    const hostname = new URL(url).hostname.replace(/^\[|\]$/g, "").toLowerCase();
    return LOOPBACK_HOSTS.has(hostname);
  } catch {
    return false;
  }
}

function assertRemoteDatabaseTls(config: Pick<Config, "databaseUrl" | "databaseSslMode">): void {
  if (config.databaseSslMode === "disable" && !isLoopbackDatabaseUrl(config.databaseUrl)) {
    throw new Error("DB_SSL_MODE must require TLS for remote databases");
  }
}

export function getDatabaseClientOptions(
  config: Pick<
    Config,
    "databaseUrl" | "databasePoolMax" | "databaseIdleTimeoutSeconds" | "databaseConnectTimeoutSeconds" | "databaseSslMode"
  >,
): DatabaseClientOptions {
  assertRemoteDatabaseTls(config);
  return {
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
  };
}

const config = getConfig();
const url = config.databaseUrl;
if (!url) {
  throw new Error("DATABASE_URL environment variable is not set");
}
const pool = postgres(url, {
  ...getDatabaseClientOptions(config),
  // postgres.js reads this default through PGMAX_PIPELINE unless supplied.
  max_pipeline: 100,
} as Parameters<typeof postgres>[1]);

export const database = drizzle(pool);

export type Database = PostgresJsDatabase;
