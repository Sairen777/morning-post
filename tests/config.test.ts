import { test } from "bun:test";
import { assertEquals, assertThrows } from "./assertions.ts";
import {
  getConfig,
  getSummarizerBudgetConfig,
  getSummarizerRuntimeConfig,
  resolveAllowRemoteSummarization,
  resolveAppSecurityOptions,
  resolveServerHostname,
} from "../src/config.ts";

const ENV_KEYS = [
  "PORT",
  "ALLOWED_ORIGINS",
  "TRUSTED_PROXY_COUNT",
  "MAX_REQUEST_BODY_BYTES",
  "DB_POOL_MAX",
  "DB_IDLE_TIMEOUT_SECONDS",
  "DB_CONNECT_TIMEOUT_SECONDS",
  "DB_SSL_MODE",
  "ALLOW_REMOTE_SUMMARIZATION",
  "SUMMARIZER_MODEL",
  "SUMMARIZER_BASE_URL",
  "SUMMARIZER_API_KEY",
  "VISION_MODEL",
  "VISION_BASE_URL",
  "VISION_API_KEY",
  "CONNECTOR_TIMEOUT_MS",
  "SUMMARIZER_TEXT_BYTES_PER_CHUNK",
  "SUMMARIZER_MAX_ITEMS_PER_CHUNK",
  "SUMMARIZER_MAX_IMAGE_BYTES",
  "SUMMARIZER_TIMEOUT_MS",
  "DIGEST_PROGRESS_LOGGING",
  "SUMMARIZATION_CONCURRENCY",
  "MEDIA_TTL_MS",
  "MEDIA_QUOTA_BYTES",
  "DIGEST_RUN_STALE_AFTER_MS",
  "SCHEDULER_LEASE_MS",
] as const;
type EnvKey = (typeof ENV_KEYS)[number];

console.log("3");

function withClearedEnvironment<T>(
  keys: readonly string[],
  callback: () => T,
): T {
  const previousValues = new Map(
    keys.map((key) => [key, process.env[key]]),
  );
  try {
    for (const key of keys) delete process.env[key];
    return callback();
  } finally {
    for (const [key, value] of previousValues) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

test("config defaults cover runtime boundaries", () => {
  const config = withClearedEnvironment(ENV_KEYS, getConfig);
  assertEquals(config.port, 3000);
  assertEquals(config.allowedOrigins, [
    "http://127.0.0.1:5173",
    "http://localhost:5173",
  ]);
  assertEquals(config.trustedProxyCount, 0);
  assertEquals(config.maxRequestBodyBytes, 1_048_576);
  assertEquals(config.databasePoolMax, 10);
  assertEquals(config.databaseIdleTimeoutSeconds, 20);
  assertEquals(config.databaseConnectTimeoutSeconds, 30);
  assertEquals(config.databaseSslMode, "disable");
  assertEquals(config.allowRemoteSummarization, false);
  assertEquals(config.connectorTimeoutMs, 120_000);
  assertEquals(config.summarizerTextBytesPerChunk, 120_000);
  assertEquals(config.summarizerMaxItemsPerChunk, 50);
  assertEquals(config.summarizerMaxImageBytes, 1_000_000);
  assertEquals(config.summarizerTimeoutMs, 120_000);
  assertEquals(config.digestProgressLogging, false);
  assertEquals(config.summarizationConcurrency, 2);
  assertEquals(config.mediaTtlMs, 604_800_000);
  assertEquals(config.mediaQuotaBytes, 524_288_000);
  assertEquals(config.digestRunStaleAfterMs, 900_000);
  assertEquals(config.schedulerLeaseMs, 90_000);
});

test("summarizer budget resolver reads only scoped limit settings", () => {
  const budget = withClearedEnvironment(
    [
      "ALLOWED_ORIGINS",
      "SUMMARIZER_TEXT_BYTES_PER_CHUNK",
      "SUMMARIZER_MAX_ITEMS_PER_CHUNK",
      "SUMMARIZER_MAX_IMAGE_BYTES",
    ],
    () => {
      process.env["ALLOWED_ORIGINS"] = "not a valid origin list";
      process.env["SUMMARIZER_TEXT_BYTES_PER_CHUNK"] = "9000";
      process.env["SUMMARIZER_MAX_ITEMS_PER_CHUNK"] = "7";
      process.env["SUMMARIZER_MAX_IMAGE_BYTES"] = "8000";
      return getSummarizerBudgetConfig();
    },
  );

  assertEquals(budget, {
    summarizerTextBytesPerChunk: 9000,
    summarizerMaxItemsPerChunk: 7,
    summarizerMaxImageBytes: 8000,
  });
});

test("server hostname resolver uses loopback and strict precedence", () => {
  const previous = process.env["SERVER_HOSTNAME"];
  try {
    delete process.env["SERVER_HOSTNAME"];
    assertEquals(resolveServerHostname(), "127.0.0.1");

    process.env["SERVER_HOSTNAME"] = "  192.0.2.10  ";
    assertEquals(resolveServerHostname(), "192.0.2.10");

    assertEquals(resolveServerHostname(" 198.51.100.7 "), "198.51.100.7");

    process.env["SERVER_HOSTNAME"] = "   ";
    assertThrows(
      () => resolveServerHostname(),
      Error,
      "Invalid SERVER_HOSTNAME",
    );
    assertThrows(
      () => resolveServerHostname("   "),
      Error,
      "Invalid SERVER_HOSTNAME",
    );
  } finally {
    if (previous === undefined) delete process.env["SERVER_HOSTNAME"];
    else process.env["SERVER_HOSTNAME"] = previous;
  }
  assertEquals(process.env["SERVER_HOSTNAME"], previous);
});

test("environment values override defaults and parse strictly", () => {
  const previous = new Map(ENV_KEYS.map((key) => [key, process.env[key]]));
  try {
    const values: Record<EnvKey, string> = {
      PORT: "4310",
      ALLOWED_ORIGINS: "https://app.example, https://admin.example",
      TRUSTED_PROXY_COUNT: "2",
      MAX_REQUEST_BODY_BYTES: "2048",
      DB_POOL_MAX: "12",
      DB_IDLE_TIMEOUT_SECONDS: "25",
      DB_CONNECT_TIMEOUT_SECONDS: "35",
      DB_SSL_MODE: "verify-full",
      ALLOW_REMOTE_SUMMARIZATION: "true",
      SUMMARIZER_MODEL: "model-a",
      SUMMARIZER_BASE_URL: "http://localhost:1234/v1",
      SUMMARIZER_API_KEY: "key-a",
      VISION_MODEL: "model-b",
      VISION_BASE_URL: "http://localhost:4321/v1",
      VISION_API_KEY: "key-b",
      CONNECTOR_TIMEOUT_MS: "5000",
      SUMMARIZER_TEXT_BYTES_PER_CHUNK: "9000",
      SUMMARIZER_MAX_ITEMS_PER_CHUNK: "7",
      SUMMARIZER_MAX_IMAGE_BYTES: "8000",
      SUMMARIZER_TIMEOUT_MS: "6000",
      DIGEST_PROGRESS_LOGGING: "true",
      SUMMARIZATION_CONCURRENCY: "3",
      MEDIA_TTL_MS: "7000",
      MEDIA_QUOTA_BYTES: "9000",
      DIGEST_RUN_STALE_AFTER_MS: "10000",
      SCHEDULER_LEASE_MS: "11000",
    };
    for (const [key, value] of Object.entries(values)) process.env[key] = value;
    const config = getConfig();
    assertEquals(config.port, 4310);
    assertEquals(config.allowedOrigins, [
      "https://app.example",
      "https://admin.example",
    ]);
    assertEquals(config.trustedProxyCount, 2);
    assertEquals(config.maxRequestBodyBytes, 2048);
    assertEquals(config.databasePoolMax, 12);
    assertEquals(config.databaseIdleTimeoutSeconds, 25);
    assertEquals(config.databaseConnectTimeoutSeconds, 35);
    assertEquals(config.databaseSslMode, "verify-full");
    assertEquals(config.allowRemoteSummarization, true);
    assertEquals(config.connectorTimeoutMs, 5000);
    assertEquals(config.summarizerTextBytesPerChunk, 9000);
    assertEquals(config.summarizerMaxItemsPerChunk, 7);
    assertEquals(config.summarizerMaxImageBytes, 8000);
    assertEquals(config.summarizerTimeoutMs, 6000);
    assertEquals(config.digestProgressLogging, true);
    assertEquals(config.summarizationConcurrency, 3);
    assertEquals(config.mediaTtlMs, 7000);
    assertEquals(config.mediaQuotaBytes, 9000);
    assertEquals(config.digestRunStaleAfterMs, 10000);
    assertEquals(config.schedulerLeaseMs, 11000);
  } finally {
    for (const [key, value] of previous) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});

test("digest progress logging constructor override wins over environment", () => {
  withClearedEnvironment(["DIGEST_PROGRESS_LOGGING"], () => {
    process.env["DIGEST_PROGRESS_LOGGING"] = "true";
    assertEquals(getConfig({ digestProgressLogging: false }).digestProgressLogging, false);
  });
});

test("constructor values take precedence over environment", () => {
  const previous = new Map(
    [
      "PORT",
      "ALLOWED_ORIGINS",
      "MAX_REQUEST_BODY_BYTES",
      "DB_SSL_MODE",
      "ALLOW_REMOTE_SUMMARIZATION",
    ].map((key) => [key, process.env[key]]),
  );
  try {
    process.env["PORT"] = "4310";
    process.env["ALLOWED_ORIGINS"] = "https://env.example";
    process.env["MAX_REQUEST_BODY_BYTES"] = "100";
    process.env["DB_SSL_MODE"] = "require";
    process.env["ALLOW_REMOTE_SUMMARIZATION"] = "true";
    const config = getConfig({
      port: 4311,
      allowedOrigins: ["https://constructor.example"],
      maxRequestBodyBytes: 200,
      databaseSslMode: "verify-full",
      allowRemoteSummarization: false,
    });
    assertEquals(config.port, 4311);
    assertEquals(config.allowedOrigins, ["https://constructor.example"]);
    assertEquals(config.maxRequestBodyBytes, 200);
    assertEquals(config.databaseSslMode, "verify-full");
    assertEquals(config.allowRemoteSummarization, false);
    assertEquals(resolveAppSecurityOptions({ maxRequestBodyBytes: 300 }), {
      allowedOrigins: ["https://env.example"],
      maxRequestBodyBytes: 300,
    });
  } finally {
    for (const [key, value] of previous) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});

test("invalid numeric and boolean values fail at startup", () => {
  for (const key of ENV_KEYS) {
    const previous = process.env[key];
    try {
      if (
        key === "ALLOWED_ORIGINS" ||
        key === "DB_SSL_MODE" ||
        key === "ALLOW_REMOTE_SUMMARIZATION" ||
        key === "SUMMARIZER_MODEL" ||
        key === "SUMMARIZER_BASE_URL" ||
        key === "SUMMARIZER_API_KEY" ||
        key === "VISION_MODEL" ||
        key === "VISION_BASE_URL" ||
        key === "VISION_API_KEY"
      ) continue;
      process.env[key] = "not-a-number";
      assertThrows(() => getConfig(), Error, `Invalid ${key}`);
    } finally {
      if (previous === undefined) delete process.env[key];
      else process.env[key] = previous;
    }
  }
  const previous = process.env["ALLOW_REMOTE_SUMMARIZATION"];
  try {
    process.env["ALLOW_REMOTE_SUMMARIZATION"] = "yes";
    assertThrows(
      () => getConfig(),
      Error,
      "Invalid ALLOW_REMOTE_SUMMARIZATION",
    );
  } finally {
    if (previous === undefined) delete process.env["ALLOW_REMOTE_SUMMARIZATION"];
    else process.env["ALLOW_REMOTE_SUMMARIZATION"] = previous;
  }
});

test("database SSL mode accepts only supported values", () => {
  const previous = process.env["DB_SSL_MODE"];
  try {
    for (const mode of ["disable", "require", "verify-full"] as const) {
      assertEquals(getConfig({ databaseSslMode: mode }).databaseSslMode, mode);
      process.env["DB_SSL_MODE"] = mode;
      assertEquals(getConfig().databaseSslMode, mode);
    }
    process.env["DB_SSL_MODE"] = "prefer";
    assertThrows(() => getConfig(), Error, "Invalid DB_SSL_MODE");
    assertThrows(
      () => getConfig({ databaseSslMode: "prefer" as never }),
      Error,
      "Invalid DB_SSL_MODE",
    );
  } finally {
    if (previous === undefined) delete process.env["DB_SSL_MODE"];
    else process.env["DB_SSL_MODE"] = previous;
  }
});

test("summarizer runtime resolver validates and normalizes provider settings", () => {
  const keys = [
    "SUMMARIZER_MODEL",
    "SUMMARIZER_BASE_URL",
    "SUMMARIZER_API_KEY",
    "VISION_MODEL",
    "VISION_BASE_URL",
    "VISION_API_KEY",
  ];
  const previous = new Map(keys.map((key) => [key, process.env[key]]));
  try {
    for (const key of keys) delete process.env[key];
    assertEquals(getSummarizerRuntimeConfig(), {
      summarizer: {
        model: "local-model",
        baseUrl: "http://127.0.0.1:1234/v1",
      },
      vision: {
        model: "local-model",
        baseUrl: "http://127.0.0.1:1234/v1",
      },
      sameModel: true,
    });

    const requiredValues = {
      SUMMARIZER_MODEL: "summary",
      SUMMARIZER_BASE_URL: "http://localhost:1234/v1",
      VISION_MODEL: "vision",
    };
    for (const key of Object.keys(requiredValues)) {
      for (
        const [requiredKey, requiredValue] of Object.entries(requiredValues)
      ) {
        process.env[requiredKey] = requiredValue;
      }
      process.env[key] = "   ";
      assertThrows(() => getSummarizerRuntimeConfig(), Error, `Invalid ${key}`);
    }

    process.env["SUMMARIZER_MODEL"] = "summary";
    process.env["SUMMARIZER_BASE_URL"] = "http://localhost:1234/v1";
    process.env["VISION_MODEL"] = "vision";

    process.env["SUMMARIZER_MODEL"] = " summary-model ";
    process.env["SUMMARIZER_BASE_URL"] = " https://summary.example/v1/// ";
    process.env["SUMMARIZER_API_KEY"] = " summary-key ";
    process.env["VISION_MODEL"] = " vision-model ";
    process.env["VISION_BASE_URL"] = " https://vision.example/v1/// ";
    process.env["VISION_API_KEY"] = " vision-key ";
    assertEquals(getSummarizerRuntimeConfig(), {
      summarizer: {
        model: "summary-model",
        baseUrl: "https://summary.example/v1",
        apiKey: "summary-key",
      },
      vision: {
        model: "vision-model",
        baseUrl: "https://vision.example/v1",
        apiKey: "vision-key",
      },
      sameModel: false,
    });

    process.env["VISION_MODEL"] = " summary-model ";
    process.env["VISION_BASE_URL"] = "   ";
    process.env["VISION_API_KEY"] = "   ";
    assertEquals(getSummarizerRuntimeConfig().vision, {
      model: "summary-model",
      baseUrl: "https://summary.example/v1",
      apiKey: "summary-key",
    });

    process.env["VISION_BASE_URL"] = "https://summary.example/v1";
    assertThrows(
      () => getSummarizerRuntimeConfig(),
      Error,
      "Invalid VISION_BASE_URL",
    );
    process.env["VISION_BASE_URL"] = "   ";
    process.env["VISION_API_KEY"] = "different-key";
    assertThrows(
      () => getSummarizerRuntimeConfig(),
      Error,
      "Invalid VISION_API_KEY",
    );

    process.env["VISION_MODEL"] = "vision-model";
    delete process.env["VISION_BASE_URL"];
    assertThrows(
      () => getSummarizerRuntimeConfig(),
      Error,
      "Invalid VISION_BASE_URL",
    );
  } finally {
    for (const [key, value] of previous) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});

test("remote summarization resolver honors override and strict environment values", () => {
  const previous = process.env["ALLOW_REMOTE_SUMMARIZATION"];
  try {
    process.env["ALLOW_REMOTE_SUMMARIZATION"] = "true";
    assertEquals(resolveAllowRemoteSummarization(), true);
    assertEquals(resolveAllowRemoteSummarization(false), false);
    process.env["ALLOW_REMOTE_SUMMARIZATION"] = "false";
    assertEquals(resolveAllowRemoteSummarization(), false);
    process.env["ALLOW_REMOTE_SUMMARIZATION"] = "yes";
    assertThrows(
      () => resolveAllowRemoteSummarization(),
      Error,
      "Invalid ALLOW_REMOTE_SUMMARIZATION",
    );
  } finally {
    if (previous === undefined) delete process.env["ALLOW_REMOTE_SUMMARIZATION"];
    else process.env["ALLOW_REMOTE_SUMMARIZATION"] = previous;
  }
});
