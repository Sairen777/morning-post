import { truncatePublicTables } from "../src/db/cleanup.ts";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";

const E2E_API_PORT = 3_100;
const E2E_WEB_ORIGIN = "http://127.0.0.1:5174";

type Environment = Record<string, string | undefined>;

export function resolveE2eDatabaseUrl(
  environment: Environment = Deno.env.toObject(),
): string {
  const explicitUrl = environment.E2E_DATABASE_URL?.trim() || undefined;
  const sourceUrl = explicitUrl ?? environment.TEST_DATABASE_URL?.trim() ??
    environment.DATABASE_URL?.trim();
  if (!sourceUrl) {
    throw new Error(
      "TEST_DATABASE_URL or DATABASE_URL is required for E2E tests",
    );
  }

  const parsedUrl = parsePostgresUrl(sourceUrl);
  const sourceDatabaseName = databaseName(parsedUrl);
  const e2eDatabaseName = explicitUrl
    ? sourceDatabaseName
    : `${sourceDatabaseName.replace(/_test$/, "")}_e2e`;
  if (!e2eDatabaseName.endsWith("_e2e")) {
    throw new Error("E2E database name must end with _e2e");
  }
  if (!/^[A-Za-z0-9_]+$/.test(e2eDatabaseName)) {
    throw new Error(
      "E2E database name may contain only letters, numbers, and underscores",
    );
  }

  parsedUrl.pathname = `/${encodeURIComponent(e2eDatabaseName)}`;
  const resolvedUrl = parsedUrl.toString();
  if (sameDatabase(resolvedUrl, environment.DATABASE_URL)) {
    throw new Error("E2E_DATABASE_URL must differ from DATABASE_URL");
  }
  if (sameDatabase(resolvedUrl, environment.TEST_DATABASE_URL)) {
    throw new Error("E2E_DATABASE_URL must differ from TEST_DATABASE_URL");
  }
  return resolvedUrl;
}

function parsePostgresUrl(value: string): URL {
  let parsedUrl: URL;
  try {
    parsedUrl = new URL(value);
  } catch {
    throw new Error("E2E database URL must be a valid URL");
  }
  if (
    parsedUrl.protocol !== "postgres:" && parsedUrl.protocol !== "postgresql:"
  ) {
    throw new Error("E2E database URL must use postgres or postgresql");
  }
  databaseName(parsedUrl);
  return parsedUrl;
}

function databaseName(url: URL): string {
  const name = decodeURIComponent(url.pathname.replace(/^\/+/, ""));
  if (!name) {
    throw new Error("E2E database URL must include a database name");
  }
  return name;
}

function sameDatabase(
  candidate: string,
  configured: string | undefined,
): boolean {
  const configuredUrlValue = configured?.trim();
  if (!configuredUrlValue) return false;
  const candidateUrl = parsePostgresUrl(candidate);
  const configuredUrl = parsePostgresUrl(configuredUrlValue);
  return candidateUrl.hostname === configuredUrl.hostname &&
    (candidateUrl.port || "5432") === (configuredUrl.port || "5432") &&
    databaseName(candidateUrl) === databaseName(configuredUrl);
}

function createClient(url: string) {
  const parsedUrl = parsePostgresUrl(url);
  const sslMode = Deno.env.get("DB_SSL_MODE") ?? "disable";
  if (
    sslMode !== "disable" && sslMode !== "require" && sslMode !== "verify-full"
  ) {
    throw new Error("DB_SSL_MODE must be disable, require, or verify-full");
  }
  return postgres(
    url,
    {
      max: 1,
      host: parsedUrl.hostname,
      port: Number(parsedUrl.port || 5432),
      database: databaseName(parsedUrl),
      username: decodeURIComponent(parsedUrl.username),
      password: decodeURIComponent(parsedUrl.password),
      idle_timeout: 5,
      connect_timeout: 10,
      ssl: sslMode === "disable" ? false : sslMode,
      max_lifetime: 45 * 60,
      max_pipeline: 100,
      backoff: (attemptNumber: number) =>
        (0.5 + Math.random() / 2) * Math.min(3 ** attemptNumber / 100, 20),
      keep_alive: 60,
      prepare: true,
      debug: false,
      fetch_types: true,
      publications: "alltables",
      target_session_attrs: "read-write",
    } as Parameters<typeof postgres>[1],
  );
}

async function ensureE2eDatabase(url: string): Promise<void> {
  const targetUrl = parsePostgresUrl(url);
  const targetDatabaseName = databaseName(targetUrl);
  const administrationUrl = new URL(targetUrl);
  administrationUrl.pathname = "/postgres";
  const client = createClient(administrationUrl.toString());
  try {
    const rows =
      await client`select 1 from pg_database where datname = ${targetDatabaseName}`;
    if (rows.length === 0) {
      await client.unsafe(`create database "${targetDatabaseName}"`);
    }
  } finally {
    await client.end();
  }
}

async function resetE2eDatabase(url: string): Promise<void> {
  const client = createClient(url);
  try {
    const database = drizzle(client);
    await migrate(database, { migrationsFolder: "./drizzle" });
    await truncatePublicTables(client);
  } finally {
    await client.end();
  }
}

async function prepareE2eDatabase(): Promise<string> {
  const url = resolveE2eDatabaseUrl();
  await ensureE2eDatabase(url);
  await resetE2eDatabase(url);
  return url;
}

async function startE2eApi(): Promise<void> {
  const databaseUrl = await prepareE2eDatabase();
  Deno.env.set("DATABASE_URL", databaseUrl);
  Deno.env.set("PORT", String(E2E_API_PORT));
  Deno.env.set("ALLOWED_ORIGINS", E2E_WEB_ORIGIN);
  const { bootServer } = await import("../src/server/main.ts");
  bootServer();
}

async function cleanupE2eDatabase(): Promise<void> {
  const url = resolveE2eDatabaseUrl();
  await ensureE2eDatabase(url);
  await resetE2eDatabase(url);
}

if (import.meta.main) {
  const command = Deno.args[0];
  if (command === "start-api") {
    await startE2eApi();
  } else if (command === "cleanup") {
    await cleanupE2eDatabase();
  } else {
    throw new Error("Expected start-api or cleanup");
  }
}
