import { test } from "bun:test";
import { assertEquals, assertThrows } from "./assertions.ts";
import {
  getConfig,
  getSummarizerBudgetConfig,
  getSummarizerRuntimeConfig,
  getTwexApiBaseUrl,
  resolveAllowRemoteSummarization,
  resolveAppSecurityOptions,
  resolveServerHostname,
} from "../src/config.ts";

const ENV_KEYS = [
  "PORT",
  "ALLOWED_ORIGINS",
  "TRUSTED_PROXY_COUNT",
  "MAX_REQUEST_BODY_BYTES",
  "DATABASE_PATH",
  "ALLOW_REMOTE_SUMMARIZATION",
  "CONNECTOR_TIMEOUT_MS",
  "TWEXAPI_BASE_URL",
  "SUMMARIZER_MODEL",
  "SUMMARIZER_BASE_URL",
  "SUMMARIZER_API_KEY",
  "ANALYSIS_MODEL",
  "ANALYSIS_BASE_URL",
  "ANALYSIS_API_KEY",
  "CLASSIFICATION_MODEL",
  "CLASSIFICATION_BASE_URL",
  "CLASSIFICATION_API_KEY",
  "SUMMARIZER_TEXT_BYTES_PER_CHUNK",
  "SUMMARIZER_UNCACHED_INPUT_USD_PER_MILLION_TOKENS",
  "SUMMARIZER_CACHED_INPUT_USD_PER_MILLION_TOKENS",
  "SUMMARIZER_OUTPUT_USD_PER_MILLION_TOKENS",
  "ANALYSIS_UNCACHED_INPUT_USD_PER_MILLION_TOKENS",
  "ANALYSIS_CACHED_INPUT_USD_PER_MILLION_TOKENS",
  "ANALYSIS_OUTPUT_USD_PER_MILLION_TOKENS",
  "CLASSIFICATION_UNCACHED_INPUT_USD_PER_MILLION_TOKENS",
  "CLASSIFICATION_CACHED_INPUT_USD_PER_MILLION_TOKENS",
  "CLASSIFICATION_OUTPUT_USD_PER_MILLION_TOKENS",
  "VISION_UNCACHED_INPUT_USD_PER_MILLION_TOKENS",
  "VISION_CACHED_INPUT_USD_PER_MILLION_TOKENS",
  "VISION_OUTPUT_USD_PER_MILLION_TOKENS",
  "SUMMARIZER_MAX_ITEMS_PER_CHUNK",
  "SUMMARIZER_MAX_IMAGE_BYTES",
  "SUMMARIZER_TIMEOUT_MS",
  "DIGEST_PROGRESS_LOGGING",
  "SUMMARIZATION_CONCURRENCY",
  "ANALYSIS_MAX_ITEMS_PER_REQUEST",
  "CLASSIFICATION_MAX_ITEMS_PER_REQUEST",
  "SUMMARY_BATCH_MAX_STORIES",
  "ANALYSIS_MAX_OUTPUT_TOKENS",
  "CLASSIFICATION_MAX_OUTPUT_TOKENS",
  "SUMMARY_MAX_OUTPUT_TOKENS",
  "SUMMARY_BATCH_MAX_OUTPUT_TOKENS",
  "MEDIA_MAX_OUTPUT_TOKENS",
  "ANALYSIS_MAX_ATTEMPTS",
  "CLASSIFICATION_MAX_ATTEMPTS",
  "SUMMARY_MAX_ATTEMPTS",
  "MEDIA_MAX_ATTEMPTS",
  "VISION_MODEL",
  "VISION_BASE_URL",
  "VISION_API_KEY",
  "MEDIA_TTL_MS",
  "MEDIA_QUOTA_BYTES",
  "DIGEST_RUN_STALE_AFTER_MS",
] as const;
type EnvKey = (typeof ENV_KEYS)[number];


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
  assertEquals(config.databasePath, "./data/morning-post.sqlite");
  assertEquals(config.allowRemoteSummarization, false);
  assertEquals(config.connectorTimeoutMs, 120_000);
  assertEquals(config.twexApiBaseUrl, "https://api.twexapi.io");
  assertEquals(config.summarizerTextBytesPerChunk, 120_000);
  assertEquals(config.summarizerMaxItemsPerChunk, 50);
  assertEquals(config.summarizerMaxImageBytes, 1_000_000);
  assertEquals(config.summarizerTimeoutMs, 120_000);
  assertEquals(config.digestProgressLogging, false);
  assertEquals(config.summarizationConcurrency, 2);
  assertEquals(config.mediaTtlMs, 604_800_000);
  assertEquals(config.mediaQuotaBytes, 524_288_000);
  assertEquals(config.digestRunStaleAfterMs, 900_000);
  assertEquals(config.analysisMaxItemsPerRequest, 50);
  assertEquals(config.classificationMaxItemsPerRequest, 100);
  assertEquals(config.summaryBatchMaxStories, 5);
  assertEquals(config.analysisMaxOutputTokens, 30_000);
  assertEquals(config.classificationMaxOutputTokens, 6_000);
  assertEquals(config.summaryMaxOutputTokens, 6_500);
  assertEquals(config.summaryBatchMaxOutputTokens, 6_500);
  assertEquals(config.mediaMaxOutputTokens, 1_200);
  assertEquals(config.analysisMaxAttempts, 3);
  assertEquals(config.classificationMaxAttempts, 3);
  assertEquals(config.summaryMaxAttempts, 2);
  assertEquals(config.mediaMaxAttempts, 2);
});

test("summarizer budgets use constructor, environment, then default precedence", () => {
  const budgetKeys = [
    "SUMMARIZER_TEXT_BYTES_PER_CHUNK",
    "SUMMARIZER_MAX_ITEMS_PER_CHUNK",
    "SUMMARIZER_MAX_IMAGE_BYTES",
    "ANALYSIS_MAX_ITEMS_PER_REQUEST",
    "CLASSIFICATION_MAX_ITEMS_PER_REQUEST",
    "SUMMARY_BATCH_MAX_STORIES",
    "ANALYSIS_MAX_OUTPUT_TOKENS",
    "CLASSIFICATION_MAX_OUTPUT_TOKENS",
    "SUMMARY_MAX_OUTPUT_TOKENS",
    "SUMMARY_BATCH_MAX_OUTPUT_TOKENS",
    "MEDIA_MAX_OUTPUT_TOKENS",
    "ANALYSIS_MAX_ATTEMPTS",
    "CLASSIFICATION_MAX_ATTEMPTS",
    "SUMMARY_MAX_ATTEMPTS",
    "MEDIA_MAX_ATTEMPTS",
  ] as const;

  withClearedEnvironment(budgetKeys, () => {
    for (const key of budgetKeys) process.env[key] = "1";

    assertEquals(getSummarizerBudgetConfig(), {
      summarizerTextBytesPerChunk: 1,
      summarizerMaxItemsPerChunk: 1,
      summarizerMaxImageBytes: 1,
      analysisMaxItemsPerRequest: 1,
      classificationMaxItemsPerRequest: 1,
      summaryBatchMaxStories: 1,
      analysisMaxOutputTokens: 1,
      classificationMaxOutputTokens: 1,
      summaryMaxOutputTokens: 1,
      summaryBatchMaxOutputTokens: 1,
      mediaMaxOutputTokens: 1,
      analysisMaxAttempts: 1,
      classificationMaxAttempts: 1,
      summaryMaxAttempts: 1,
      mediaMaxAttempts: 1,
    });

    const overridden = getSummarizerBudgetConfig({
      summaryMaxOutputTokens: 4_000,
      mediaMaxOutputTokens: 600,
    });
    assertEquals(overridden.summaryMaxOutputTokens, 4_000);
    assertEquals(overridden.mediaMaxOutputTokens, 600);
    assertThrows(
      () => getSummarizerBudgetConfig({ summaryMaxOutputTokens: 0 }),
      Error,
      "Invalid SUMMARY_MAX_OUTPUT_TOKENS",
    );
    assertThrows(
      () => getSummarizerBudgetConfig({ mediaMaxOutputTokens: -1 }),
      Error,
      "Invalid MEDIA_MAX_OUTPUT_TOKENS",
    );
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

test("environment values override supported configuration defaults", () => {
  const previous = new Map(ENV_KEYS.map((key) => [key, process.env[key]]));
  try {
    const values: Record<EnvKey, string> = {
      PORT: "4310",
      ALLOWED_ORIGINS: "https://app.example, https://admin.example",
      TRUSTED_PROXY_COUNT: "2",
      MAX_REQUEST_BODY_BYTES: "2048",
      DATABASE_PATH: "./data/environment.sqlite",
      ALLOW_REMOTE_SUMMARIZATION: "true",
      SUMMARIZER_MODEL: "model-a",
      SUMMARIZER_BASE_URL: "http://localhost:1234/v1",
      SUMMARIZER_API_KEY: "key-a",
      ANALYSIS_MODEL: "analysis-model",
      ANALYSIS_BASE_URL: "http://localhost:1234/v1",
      ANALYSIS_API_KEY: "analysis-key",
      CLASSIFICATION_MODEL: "classification-model",
      CLASSIFICATION_BASE_URL: "http://localhost:1234/v1",
      CLASSIFICATION_API_KEY: "classification-key",
      SUMMARIZER_UNCACHED_INPUT_USD_PER_MILLION_TOKENS: "1",
      SUMMARIZER_CACHED_INPUT_USD_PER_MILLION_TOKENS: "0.1",
      SUMMARIZER_OUTPUT_USD_PER_MILLION_TOKENS: "2",
      ANALYSIS_UNCACHED_INPUT_USD_PER_MILLION_TOKENS: "1",
      ANALYSIS_CACHED_INPUT_USD_PER_MILLION_TOKENS: "0.1",
      ANALYSIS_OUTPUT_USD_PER_MILLION_TOKENS: "2",
      CLASSIFICATION_UNCACHED_INPUT_USD_PER_MILLION_TOKENS: "1",
      CLASSIFICATION_CACHED_INPUT_USD_PER_MILLION_TOKENS: "0.1",
      CLASSIFICATION_OUTPUT_USD_PER_MILLION_TOKENS: "2",
      VISION_UNCACHED_INPUT_USD_PER_MILLION_TOKENS: "1",
      VISION_CACHED_INPUT_USD_PER_MILLION_TOKENS: "0.1",
      VISION_OUTPUT_USD_PER_MILLION_TOKENS: "2",
      VISION_MODEL: "model-b",
      VISION_BASE_URL: "http://localhost:4321/v1",
      VISION_API_KEY: "key-b",
      CONNECTOR_TIMEOUT_MS: "5000",
      TWEXAPI_BASE_URL: " https://twex.example/api/// ",
      SUMMARIZER_TEXT_BYTES_PER_CHUNK: "9000",
      SUMMARIZER_MAX_ITEMS_PER_CHUNK: "7",
      SUMMARIZER_MAX_IMAGE_BYTES: "8000",
      SUMMARIZER_TIMEOUT_MS: "6000",
      DIGEST_PROGRESS_LOGGING: "true",
      SUMMARIZATION_CONCURRENCY: "3",
      MEDIA_TTL_MS: "7000",
      MEDIA_QUOTA_BYTES: "9000",
      DIGEST_RUN_STALE_AFTER_MS: "10000",
      ANALYSIS_MAX_ITEMS_PER_REQUEST: "42",
      CLASSIFICATION_MAX_ITEMS_PER_REQUEST: "84",
      SUMMARY_BATCH_MAX_STORIES: "25",
      ANALYSIS_MAX_OUTPUT_TOKENS: "8000",
      CLASSIFICATION_MAX_OUTPUT_TOKENS: "4000",
      SUMMARY_MAX_OUTPUT_TOKENS: "1000",
      SUMMARY_BATCH_MAX_OUTPUT_TOKENS: "3000",
      MEDIA_MAX_OUTPUT_TOKENS: "200",
      ANALYSIS_MAX_ATTEMPTS: "6",
      CLASSIFICATION_MAX_ATTEMPTS: "6",
      SUMMARY_MAX_ATTEMPTS: "4",
      MEDIA_MAX_ATTEMPTS: "4",
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
    assertEquals(config.databasePath, "./data/environment.sqlite");
    assertEquals(config.allowRemoteSummarization, true);
    assertEquals(config.connectorTimeoutMs, 5000);
    assertEquals(config.twexApiBaseUrl, "https://twex.example/api");
    assertEquals(config.summarizerTextBytesPerChunk, 9000);
    assertEquals(config.summarizerMaxItemsPerChunk, 7);
    assertEquals(config.summarizerMaxImageBytes, 8000);
    assertEquals(config.summarizerTimeoutMs, 6000);
    assertEquals(config.digestProgressLogging, true);
    assertEquals(config.summarizationConcurrency, 3);
    assertEquals(config.mediaTtlMs, 7000);
    assertEquals(config.mediaQuotaBytes, 9000);
    assertEquals(config.digestRunStaleAfterMs, 10000);
    assertEquals(config.analysisMaxItemsPerRequest, 42);
    assertEquals(config.classificationMaxItemsPerRequest, 84);
    assertEquals(config.summaryBatchMaxStories, 25);
    assertEquals(config.analysisMaxOutputTokens, 8000);
    assertEquals(config.classificationMaxOutputTokens, 4000);
    assertEquals(config.summaryMaxOutputTokens, 1000);
    assertEquals(config.summaryBatchMaxOutputTokens, 3000);
    assertEquals(config.mediaMaxOutputTokens, 200);
    assertEquals(config.analysisMaxAttempts, 6);
    assertEquals(config.classificationMaxAttempts, 6);
    assertEquals(config.summaryMaxAttempts, 4);
    assertEquals(config.mediaMaxAttempts, 4);
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
      "DATABASE_PATH",
      "ALLOW_REMOTE_SUMMARIZATION",
      "TWEXAPI_BASE_URL",
    ].map((key) => [key, process.env[key]]),
  );
  try {
    process.env["PORT"] = "4310";
    process.env["ALLOWED_ORIGINS"] = "https://env.example";
    process.env["MAX_REQUEST_BODY_BYTES"] = "100";
    process.env["DATABASE_PATH"] = "./data/environment.sqlite";
    process.env["ALLOW_REMOTE_SUMMARIZATION"] = "true";
    process.env["TWEXAPI_BASE_URL"] = "https://env.example/api";
    const config = getConfig({
      port: 4311,
      allowedOrigins: ["https://constructor.example"],
      maxRequestBodyBytes: 200,
      databasePath: "./data/constructor.sqlite",
      allowRemoteSummarization: false,
      twexApiBaseUrl: " https://constructor.example/api/// ",
    });
    assertEquals(config.port, 4311);
    assertEquals(config.allowedOrigins, ["https://constructor.example"]);
    assertEquals(config.maxRequestBodyBytes, 200);
    assertEquals(config.databasePath, "./data/constructor.sqlite");
    assertEquals(config.allowRemoteSummarization, false);
    assertEquals(config.twexApiBaseUrl, "https://constructor.example/api");
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
        key === "DATABASE_PATH" ||
        key === "ALLOW_REMOTE_SUMMARIZATION" ||
        key.endsWith("_MODEL") ||
        key.endsWith("_BASE_URL") ||
        key.endsWith("_API_KEY")
      ) continue;
      process.env[key] = "not-a-number";
      assertThrows(
        () => key.includes("_USD_PER_MILLION_TOKENS")
          ? getSummarizerRuntimeConfig()
          : getConfig(),
        Error,
        `Invalid ${key}`,
      );
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
test("Twex API base URL follows default, environment, then constructor precedence", () => {
  withClearedEnvironment(["TWEXAPI_BASE_URL"], () => {
    assertEquals(getTwexApiBaseUrl(), "https://api.twexapi.io");

    process.env["TWEXAPI_BASE_URL"] = " https://twex.example/api/// ";
    assertEquals(getTwexApiBaseUrl(), "https://twex.example/api");

    assertEquals(
      getTwexApiBaseUrl("https://constructor.example/api//"),
      "https://constructor.example/api",
    );

    process.env["TWEXAPI_BASE_URL"] = "   ";
    assertThrows(
      () => getTwexApiBaseUrl(),
      Error,
      "Invalid TWEXAPI_BASE_URL",
    );
    assertThrows(
      () => getTwexApiBaseUrl("   "),
      Error,
      "Invalid TWEXAPI_BASE_URL",
    );
  });
});



test("Twex API base URL rejects non-HTTPS, relative, credentialed, query, and fragment URLs", () => {
  withClearedEnvironment(["TWEXAPI_BASE_URL"], () => {
    for (const bad of [
      "http://twex.example",
      "ftp://twex.example",
      "twex.example",
      "/just/a/path",
      "https://",
      "https://user:pass@twex.example",
      "https://twex.example?token=secret",
      "https://twex.example#fragment",
    ]) {
      assertThrows(
        () => getTwexApiBaseUrl(bad),
        Error,
        "Invalid TWEXAPI_BASE_URL",
        `override ${JSON.stringify(bad)} must be rejected`,
      );
    }

    process.env["TWEXAPI_BASE_URL"] = "http://insecure.example";
    assertThrows(
      () => getTwexApiBaseUrl(),
      Error,
      "Invalid TWEXAPI_BASE_URL",
    );
    process.env["TWEXAPI_BASE_URL"] = "https://user:pass@example.com";
    assertThrows(
      () => getTwexApiBaseUrl(),
      Error,
      "Invalid TWEXAPI_BASE_URL",
    );
    process.env["TWEXAPI_BASE_URL"] = "twex.example";
    assertThrows(
      () => getConfig(),
      Error,
      "Invalid TWEXAPI_BASE_URL",
    );
    assertThrows(
      () => getConfig({ twexApiBaseUrl: "https://twex.example?token=secret" }),
      Error,
      "Invalid TWEXAPI_BASE_URL",
    );

    // Accepted HTTPS paths normalize trailing slashes on every source.
    assertEquals(
      getTwexApiBaseUrl(" https://twex.example/api/// "),
      "https://twex.example/api",
    );
    process.env["TWEXAPI_BASE_URL"] = "https://env.example/api///";
    assertEquals(getTwexApiBaseUrl(), "https://env.example/api");
    assertEquals(getConfig().twexApiBaseUrl, "https://env.example/api");
  });
});



test("summarizer runtime resolver validates and normalizes provider settings", () => {
  const keys = [
    "SUMMARIZER_MODEL",
    "SUMMARIZER_BASE_URL",
    "SUMMARIZER_API_KEY",
    "ANALYSIS_MODEL",
    "ANALYSIS_BASE_URL",
    "ANALYSIS_API_KEY",
    "CLASSIFICATION_MODEL",
    "CLASSIFICATION_BASE_URL",
    "CLASSIFICATION_API_KEY",
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
      analysis: {
        model: "local-model",
        baseUrl: "http://127.0.0.1:1234/v1",
      },
      classification: {
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
      analysis: {
        model: "summary-model",
        baseUrl: "https://summary.example/v1",
        apiKey: "summary-key",
      },
      classification: {
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
    process.env["VISION_BASE_URL"] = "https://vision.example/v1";

    process.env["ANALYSIS_MODEL"] = "analysis-override";
    process.env["ANALYSIS_BASE_URL"] = "https://analysis.example/v1";
    process.env["ANALYSIS_API_KEY"] = "analysis-key";
    assertEquals(getSummarizerRuntimeConfig().analysis, {
      model: "analysis-override",
      baseUrl: "https://analysis.example/v1",
      apiKey: "analysis-key",
    });

    delete process.env["ANALYSIS_BASE_URL"];
    assertEquals(getSummarizerRuntimeConfig().analysis, {
      model: "analysis-override",
      baseUrl: "https://summary.example/v1",
      apiKey: "analysis-key",
    });

    delete process.env["ANALYSIS_API_KEY"];
    assertEquals(getSummarizerRuntimeConfig().analysis, {
      model: "analysis-override",
      baseUrl: "https://summary.example/v1",
      apiKey: "summary-key",
    });

    delete process.env["ANALYSIS_MODEL"];
    assertEquals(getSummarizerRuntimeConfig().analysis, {
      model: "summary-model",
      baseUrl: "https://summary.example/v1",
      apiKey: "summary-key",
    });

    process.env["CLASSIFICATION_MODEL"] = "clf-override";
    assertEquals(getSummarizerRuntimeConfig().classification, {
      model: "clf-override",
      baseUrl: "https://summary.example/v1",
      apiKey: "summary-key",
    });
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

test("model pricing uses constructor then explicit stage environment then no default", () => {
  const keys = [
    "ANALYSIS_UNCACHED_INPUT_USD_PER_MILLION_TOKENS",
    "ANALYSIS_CACHED_INPUT_USD_PER_MILLION_TOKENS",
    "ANALYSIS_OUTPUT_USD_PER_MILLION_TOKENS",
  ] as const;
  const previous = keys.map((key) => [key, process.env[key]] as const);
  try {
    process.env[keys[0]] = "1";
    process.env[keys[1]] = "0.1";
    process.env[keys[2]] = "2";
    assertEquals(getSummarizerRuntimeConfig().analysis.pricing, {
      uncachedInputUsdPerMillionTokens: 1,
      cachedInputUsdPerMillionTokens: 0.1,
      outputUsdPerMillionTokens: 2,
    });
    assertEquals(getSummarizerRuntimeConfig({
      analysis: { pricing: {
        uncachedInputUsdPerMillionTokens: 3,
        cachedInputUsdPerMillionTokens: 0.3,
        outputUsdPerMillionTokens: 4,
      } },
    }).analysis.pricing?.outputUsdPerMillionTokens, 4);
  } finally {
    for (const [key, value] of previous) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
  assertEquals(getSummarizerRuntimeConfig().analysis.pricing, undefined);
});

test("model pricing rejects partial, negative, and nonfinite values", () => {
  for (const value of ["-1", "Infinity"]) {
    const key = "SUMMARIZER_UNCACHED_INPUT_USD_PER_MILLION_TOKENS";
    const previous = process.env[key];
    try {
      process.env[key] = value;
      assertThrows(() => getSummarizerRuntimeConfig(), Error, `Invalid ${key}`);
    } finally {
      if (previous === undefined) delete process.env[key];
      else process.env[key] = previous;
    }
  }
});
