import { test } from "bun:test";
import { assertEquals, assertThrows } from "../assertions.ts"
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
