import postgres from "postgres";

const LOCAL_DATABASE_HOSTS = new Set(["localhost", "127.0.0.1", "::1"]);
const PROTECTED_DATABASE_NAMES = new Set([
  "postgres",
  "template0",
  "template1",
]);

type Environment = Record<string, string | undefined>;

export function resolveLocalDatabaseUrl(
  environment: Environment = { DATABASE_URL: process.env["DATABASE_URL"] },
): string {
  const configuredUrl = environment.DATABASE_URL?.trim();
  if (!configuredUrl) {
    throw new Error("DATABASE_URL is required to clean the local database");
  }

  let parsedUrl: URL;
  try {
    parsedUrl = new URL(configuredUrl);
  } catch {
    throw new Error("DATABASE_URL must be a valid URL");
  }
  if (
    parsedUrl.protocol !== "postgres:" && parsedUrl.protocol !== "postgresql:"
  ) {
    throw new Error("DATABASE_URL must use postgres or postgresql");
  }

  const hostname = parsedUrl.hostname.replace(/^\[|\]$/g, "").toLowerCase();
  if (!LOCAL_DATABASE_HOSTS.has(hostname)) {
    throw new Error(
      "Local database cleanup refuses non-loopback DATABASE_URL hosts",
    );
  }

  const databaseName = decodeURIComponent(
    parsedUrl.pathname.replace(/^\/+/, ""),
  );
  if (!databaseName) {
    throw new Error("DATABASE_URL must include a database name");
  }
  if (PROTECTED_DATABASE_NAMES.has(databaseName)) {
    throw new Error(
      `Local database cleanup refuses protected database ${databaseName}`,
    );
  }
  if (databaseName.endsWith("_test") || databaseName.endsWith("_e2e")) {
    throw new Error("Local database cleanup refuses test and E2E databases");
  }

  if (!parsedUrl.username) {
    throw new Error("DATABASE_URL must include a username");
  }

  return parsedUrl.toString();
}

export async function truncatePublicTables(
  client: postgres.Sql,
): Promise<void> {
  const tables = await client<{ tablename: string }[]>`
    select tablename
    from pg_tables
    where schemaname = 'public'
    order by tablename
  `;
  if (tables.length === 0) return;

  const tableNames = tables.map(({ tablename }) =>
    `"${tablename.replaceAll('"', '""')}"`
  ).join(", ");
  await client.unsafe(`truncate table ${tableNames} restart identity cascade`);
}

export async function cleanupLocalDatabase(
  databaseUrl = resolveLocalDatabaseUrl(),
): Promise<void> {
  const parsedUrl = new URL(databaseUrl);
  const client = postgres(
    databaseUrl,
    {
      host: parsedUrl.hostname,
      port: Number(parsedUrl.port || 5432),
      database: decodeURIComponent(parsedUrl.pathname.replace(/^\/+/, "")),
      user: decodeURIComponent(parsedUrl.username),
      pass: () => decodeURIComponent(parsedUrl.password),
      max: 1,
      ssl: false,
      idle_timeout: 0,
      connect_timeout: 30,
      max_lifetime: 0,
      max_pipeline: 100,
      backoff: false,
      keep_alive: 60,
      prepare: true,
      debug: false,
      fetch_types: true,
      publications: "alltables",
      target_session_attrs: "read-write",
    } as Parameters<typeof postgres>[1],
  );
  try {
    await truncatePublicTables(client);
  } finally {
    await client.end();
  }
}

if (import.meta.main) {
  const databaseUrl = resolveLocalDatabaseUrl();
  await cleanupLocalDatabase(databaseUrl);
  const databaseName = decodeURIComponent(
    new URL(databaseUrl).pathname.replace(/^\/+/, ""),
  );
  console.log(`Cleared local database ${databaseName}`);
}
