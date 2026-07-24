import { test } from "bun:test";
import postgres from "postgres";
import { assertEquals, assertThrows } from "../assertions.ts";
import { getDatabaseClientOptions } from "../../src/db/client.ts";

const base = {
  databasePoolMax: 12,
  databaseIdleTimeoutSeconds: 25,
  databaseConnectTimeoutSeconds: 35,
};

test("database client maps pool and SSL settings explicitly", () => {
  const options = getDatabaseClientOptions({
    ...base,
    databaseUrl: "postgres://localhost:5432/app",
    databaseSslMode: "disable",
  });
  assertEquals(
    {
      max: options.max,
      idle_timeout: options.idle_timeout,
      connect_timeout: options.connect_timeout,
      ssl: options.ssl,
    },
    {
      max: 12,
      idle_timeout: 25,
      connect_timeout: 35,
      ssl: false,
    },
  );
  assertEquals(options.max_lifetime, 45 * 60);
  assertEquals(options.keep_alive, 60);
  assertEquals(options.prepare, true);
  assertEquals(options.fetch_types, true);
  assertEquals(options.publications, "alltables");
  assertEquals(options.target_session_attrs, undefined);
  assertEquals(typeof options.backoff, "function");

  assertEquals(
    getDatabaseClientOptions({
      ...base,
      databaseUrl: "postgres://localhost:5432/app",
      databaseSslMode: "require",
    }).ssl,
    "require",
  );
  assertEquals(
    getDatabaseClientOptions({
      ...base,
      databaseUrl: "postgres://localhost:5432/app",
      databaseSslMode: "verify-full",
    }).ssl,
    "verify-full",
  );
});

test("remote database rejects disabled TLS", () => {
  assertThrows(
    () =>
      getDatabaseClientOptions({
        ...base,
        databaseUrl: "postgres://db.example.test:5432/app",
        databaseSslMode: "disable",
      }),
    Error,
    "DB_SSL_MODE must require TLS",
  );
  assertEquals(
    getDatabaseClientOptions({
      ...base,
      databaseUrl: "postgres://db.example.test:5432/app",
      databaseSslMode: "verify-full",
    }).ssl,
    "verify-full",
  );
});

test("postgres client reconnects after an idle connection closes without a negative timeout warning", async () => {
  const databaseUrl = process.env.TEST_DATABASE_URL;
  if (!databaseUrl) {
    throw new Error("TEST_DATABASE_URL environment variable is not set");
  }

  const warnings: Error[] = [];
  const captureWarning = (warning: Error) => warnings.push(warning);
  const client = postgres(databaseUrl, {
    max: 1,
    idle_timeout: 1,
  });

  process.on("warning", captureWarning);
  try {
    const first = await client<{ value: number }[]>`select 1::int as value`;
    assertEquals(first[0]?.value, 1);

    // This live integration test must let postgres.js's real idle timer close the socket.
    await Bun.sleep(1_250);

    const second = await client<{ value: number }[]>`select 2::int as value`;
    assertEquals(second[0]?.value, 2);
    await Bun.sleep(0);
    assertEquals(
      warnings.filter((warning) => warning.name === "TimeoutNegativeWarning"),
      [],
    );
  } finally {
    process.removeListener("warning", captureWarning);
    await client.end();
  }
});
