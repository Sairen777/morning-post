import type { XBrowserChannel } from "./connectors/x/x.types.ts";


export interface ModelPricingSnapshot {
  uncachedInputUsdPerMillionTokens: number;
  cachedInputUsdPerMillionTokens: number;
  outputUsdPerMillionTokens: number;
}

export interface ModelEndpointConfig {
  model: string;
  baseUrl: string;
  apiKey?: string;
  pricing?: ModelPricingSnapshot;
}

export interface SummarizerRuntimeConfig {
  summarizer: ModelEndpointConfig;
  analysis: ModelEndpointConfig;
  classification: ModelEndpointConfig;
  vision: ModelEndpointConfig;
  sameModel: boolean;
}

export interface SummarizerRuntimeConfigOverrides {
  summarizer?: Partial<ModelEndpointConfig>;
  analysis?: Partial<ModelEndpointConfig>;
  classification?: Partial<ModelEndpointConfig>;
  vision?: Partial<ModelEndpointConfig>;
}

export interface SummarizerBudgetConfig {
  summarizerTextBytesPerChunk: number;
  summarizerMaxItemsPerChunk: number;
  summarizerMaxImageBytes: number;
  analysisMaxItemsPerRequest: number;
  classificationMaxItemsPerRequest: number;
  summaryBatchMaxStories: number;
  analysisMaxOutputTokens: number;
  classificationMaxOutputTokens: number;
  summaryMaxOutputTokens: number;
  summaryBatchMaxOutputTokens: number;
  mediaMaxOutputTokens: number;
  analysisMaxAttempts: number;
  classificationMaxAttempts: number;
  summaryMaxAttempts: number;
  mediaMaxAttempts: number;
}

export interface XBrowserConfig {
  profileRoot: string;
  loginTimeoutMs: number;
  browserChannel: XBrowserChannel;
}

export interface Config {
  databasePath: string;
  port: number;
  allowedOrigins: string[];
  trustedProxyCount: number;
  maxRequestBodyBytes: number;
  allowRemoteSummarization: boolean;
  connectorTimeoutMs: number;
  summarizerTextBytesPerChunk: number;
  summarizerMaxItemsPerChunk: number;
  summarizerMaxImageBytes: number;
  analysisMaxItemsPerRequest: number;
  classificationMaxItemsPerRequest: number;
  summaryBatchMaxStories: number;
  analysisMaxOutputTokens: number;
  classificationMaxOutputTokens: number;
  summaryMaxOutputTokens: number;
  summaryBatchMaxOutputTokens: number;
  mediaMaxOutputTokens: number;
  analysisMaxAttempts: number;
  classificationMaxAttempts: number;
  summaryMaxAttempts: number;
  mediaMaxAttempts: number;
  summarizerTimeoutMs: number;
  digestProgressLogging: boolean;
  summarizationConcurrency: number;
  mediaTtlMs: number;
  mediaQuotaBytes: number;
  digestRunStaleAfterMs: number;
  xBrowserProfileRoot?: string;
  xBrowserLoginTimeoutMs?: number;
  xBrowserChannel?: XBrowserChannel;
}

export interface AppSecurityOptions {
  allowedOrigins: string[];
  maxRequestBodyBytes: number;
}

const DEFAULT_ALLOWED_ORIGINS = [
  "http://127.0.0.1:5173",
  "http://localhost:5173",
];
const DEFAULT_PORT = 3000;
const DEFAULT_SERVER_HOSTNAME = "127.0.0.1";
const DEFAULT_MAX_REQUEST_BODY_BYTES = 1_048_576;
const DEFAULT_CONNECTOR_TIMEOUT_MS = 120_000;
const DEFAULT_SUMMARIZER_TEXT_BYTES_PER_CHUNK = 120_000;
const DEFAULT_SUMMARIZER_MAX_ITEMS_PER_CHUNK = 50;
const DEFAULT_SUMMARIZER_MAX_IMAGE_BYTES = 1_000_000;
const DEFAULT_ANALYSIS_MAX_ITEMS_PER_REQUEST = 50;
const DEFAULT_CLASSIFICATION_MAX_ITEMS_PER_REQUEST = 100;
const DEFAULT_SUMMARY_BATCH_MAX_STORIES = 5;
const DEFAULT_ANALYSIS_MAX_OUTPUT_TOKENS = 30_000;
const DEFAULT_CLASSIFICATION_MAX_OUTPUT_TOKENS = 6_000;
const DEFAULT_SUMMARY_MAX_OUTPUT_TOKENS = 6_500;
const DEFAULT_SUMMARY_BATCH_MAX_OUTPUT_TOKENS = 6_500;
const DEFAULT_MEDIA_MAX_OUTPUT_TOKENS = 1_200;
const DEFAULT_ANALYSIS_MAX_ATTEMPTS = 3;
const DEFAULT_CLASSIFICATION_MAX_ATTEMPTS = 3;
const DEFAULT_SUMMARY_MAX_ATTEMPTS = 2;
const DEFAULT_MEDIA_MAX_ATTEMPTS = 2;
const DEFAULT_SUMMARIZER_TIMEOUT_MS = 120_000;
const DEFAULT_SUMMARIZATION_CONCURRENCY = 2;
const DEFAULT_MEDIA_TTL_MS = 7 * 24 * 60 * 60 * 1_000;
const DEFAULT_MEDIA_QUOTA_BYTES = 500 * 1024 * 1024;
const DEFAULT_DIGEST_RUN_STALE_AFTER_MS = 15 * 60 * 1_000;
const DEFAULT_X_BROWSER_PROFILE_ROOT = ".x-browser-profiles";
const DEFAULT_X_BROWSER_LOGIN_TIMEOUT_MS = 15 * 60 * 1_000;
const DEFAULT_X_BROWSER_CHANNEL: XBrowserChannel = "chrome";
const DEFAULT_SUMMARIZER_MODEL = "local-model";
const DEFAULT_SUMMARIZER_BASE_URL = "http://127.0.0.1:1234/v1";

function invalidConfig(name: string, message: string): Error {
  return new Error(`Invalid ${name}: ${message}`);
}

function parsePositiveInteger(name: string, value: number | string): number {
  const parsed = typeof value === "number"
    ? value
    : value.trim() === ""
    ? Number.NaN
    : Number(value);
  if (!Number.isFinite(parsed) || !Number.isInteger(parsed) || parsed <= 0) {
    throw invalidConfig(name, "expected a positive integer");
  }
  return parsed;
}

function parseNonNegativeInteger(name: string, value: number | string): number {
  const parsed = typeof value === "number"
    ? value
    : value.trim() === ""
    ? Number.NaN
    : Number(value);
  if (!Number.isFinite(parsed) || !Number.isInteger(parsed) || parsed < 0) {
    throw invalidConfig(name, "expected a non-negative integer");
  }
  return parsed;
}

function numberSetting(
  name: string,
  envName: string,
  override: number | undefined,
  fallback: number,
  allowZero = false,
): number {
  if (override !== undefined) {
    return allowZero
      ? parseNonNegativeInteger(name, override)
      : parsePositiveInteger(name, override);
  }
  const raw = process.env[envName];
  if (raw === undefined) return fallback;
  return allowZero
    ? parseNonNegativeInteger(name, raw)
    : parsePositiveInteger(name, raw);
}

function budgetSetting(
  name: string,
  override: number | undefined,
  fallback: number,
): number {
  return numberSetting(name, name, override, fallback);
}

function optionalPriceSetting(
  name: string,
  override: number | undefined,
): number | undefined {
  const raw = override ?? process.env[name];
  if (raw === undefined) return undefined;
  const parsed = typeof raw === "number"
    ? raw
    : raw.trim() === ""
    ? Number.NaN
    : Number(raw);
  if (!Number.isFinite(parsed) || parsed < 0) {
    throw invalidConfig(name, "expected a non-negative finite number");
  }
  return parsed;
}

function pricingSetting(
  prefix: "SUMMARIZER" | "ANALYSIS" | "CLASSIFICATION" | "VISION",
  override: Partial<ModelPricingSnapshot> | undefined,
): ModelPricingSnapshot | undefined {
  const uncachedInputUsdPerMillionTokens = optionalPriceSetting(
    `${prefix}_UNCACHED_INPUT_USD_PER_MILLION_TOKENS`,
    override?.uncachedInputUsdPerMillionTokens,
  );
  const cachedInputUsdPerMillionTokens = optionalPriceSetting(
    `${prefix}_CACHED_INPUT_USD_PER_MILLION_TOKENS`,
    override?.cachedInputUsdPerMillionTokens,
  );
  const outputUsdPerMillionTokens = optionalPriceSetting(
    `${prefix}_OUTPUT_USD_PER_MILLION_TOKENS`,
    override?.outputUsdPerMillionTokens,
  );
  const values = [
    uncachedInputUsdPerMillionTokens,
    cachedInputUsdPerMillionTokens,
    outputUsdPerMillionTokens,
  ];
  if (values.every((value) => value === undefined)) return undefined;
  if (values.some((value) => value === undefined)) {
    throw invalidConfig(`${prefix}_PRICING`, "expected all three model prices");
  }
  return {
    uncachedInputUsdPerMillionTokens: uncachedInputUsdPerMillionTokens!,
    cachedInputUsdPerMillionTokens: cachedInputUsdPerMillionTokens!,
    outputUsdPerMillionTokens: outputUsdPerMillionTokens!,
  };
}

function booleanSetting(
  name: string,
  envName: string,
  override: boolean | undefined,
  fallback: boolean,
): boolean {
  if (override !== undefined) {
    if (typeof override !== "boolean") {
      throw invalidConfig(name, "expected true or false");
    }
    return override;
  }
  const raw = process.env[envName];
  if (raw === undefined) return fallback;
  const normalized = raw.trim().toLowerCase();
  if (normalized === "true") return true;
  if (normalized === "false") return false;
  throw invalidConfig(name, "expected true or false");
}

function normalizeEndpointRoot(value: string): string {
  return value.trim().replace(/\/+$/, "");
}

function requiredStringSetting(
  name: string,
  override: string | undefined,
  fallback: string,
): string {
  const raw = override ?? process.env[name];
  if (raw === undefined) {
    return fallback;
  }
  const value = raw.trim();
  if (value === "") {
    throw invalidConfig(name, "expected a non-empty value");
  }
  return value;
}

function optionalStringSetting(
  name: string,
  override: string | undefined,
): { value: string | undefined; explicitlyConfigured: boolean } {
  const raw = override ?? process.env[name];
  const value = raw?.trim() ?? "";
  return {
    value: value === "" ? undefined : value,
    explicitlyConfigured: value !== "",
  };
}

function inheritedModelEndpoint(
  prefix: "ANALYSIS" | "CLASSIFICATION",
  override: Partial<ModelEndpointConfig> | undefined,
  fallback: ModelEndpointConfig,
): ModelEndpointConfig {
  const model = requiredStringSetting(
    `${prefix}_MODEL`,
    override?.model,
    fallback.model,
  );
  const baseUrl = optionalStringSetting(
    `${prefix}_BASE_URL`,
    override?.baseUrl,
  ).value;
  const apiKey = optionalStringSetting(
    `${prefix}_API_KEY`,
    override?.apiKey,
  ).value ?? fallback.apiKey;
  const pricing = pricingSetting(prefix, override?.pricing);
  return {
    model,
    baseUrl: normalizeEndpointRoot(baseUrl ?? fallback.baseUrl),
    ...(apiKey === undefined ? {} : { apiKey }),
    ...(pricing === undefined ? {} : { pricing }),
  };
}

export function getSummarizerRuntimeConfig(
  overrides: SummarizerRuntimeConfigOverrides = {},
): SummarizerRuntimeConfig {
  const summarizerModel = requiredStringSetting(
    "SUMMARIZER_MODEL",
    overrides.summarizer?.model,
    DEFAULT_SUMMARIZER_MODEL,
  );
  const summarizerBaseUrl = normalizeEndpointRoot(
    requiredStringSetting(
      "SUMMARIZER_BASE_URL",
      overrides.summarizer?.baseUrl,
      DEFAULT_SUMMARIZER_BASE_URL,
    ),
  );
  const summarizerApiKey = optionalStringSetting(
    "SUMMARIZER_API_KEY",
    overrides.summarizer?.apiKey,
  ).value;
  const summarizerPricing = pricingSetting(
    "SUMMARIZER",
    overrides.summarizer?.pricing,
  );
  const visionModel = requiredStringSetting(
    "VISION_MODEL",
    overrides.vision?.model,
    summarizerModel,
  );
  const visionBaseUrlSetting = optionalStringSetting(
    "VISION_BASE_URL",
    overrides.vision?.baseUrl,
  );
  const visionApiKeySetting = optionalStringSetting(
    "VISION_API_KEY",
    overrides.vision?.apiKey,
  );
  const visionPricing = pricingSetting("VISION", overrides.vision?.pricing);
  const sameModel = summarizerModel === visionModel;

  if (sameModel) {
    if (visionBaseUrlSetting.explicitlyConfigured) {
      throw invalidConfig(
        "VISION_BASE_URL",
        "must be omitted when SUMMARIZER_MODEL and VISION_MODEL match",
      );
    }
    if (
      visionApiKeySetting.value !== undefined &&
      visionApiKeySetting.value !== summarizerApiKey
    ) {
      throw invalidConfig(
        "VISION_API_KEY",
        "must match SUMMARIZER_API_KEY when SUMMARIZER_MODEL and VISION_MODEL match",
      );
    }
  } else if (visionBaseUrlSetting.value === undefined) {
    throw invalidConfig("VISION_BASE_URL", "expected a non-empty value");
  }

  const summarizer = {
    model: summarizerModel,
    baseUrl: summarizerBaseUrl,
    ...(summarizerApiKey === undefined ? {} : { apiKey: summarizerApiKey }),
    ...(summarizerPricing === undefined ? {} : { pricing: summarizerPricing }),
  };

  return {
    summarizer,
    analysis: inheritedModelEndpoint("ANALYSIS", overrides.analysis, summarizer),
    classification: inheritedModelEndpoint(
      "CLASSIFICATION",
      overrides.classification,
      summarizer,
    ),
    vision: {
      model: visionModel,
      baseUrl: normalizeEndpointRoot(
        visionBaseUrlSetting.value ?? summarizerBaseUrl,
      ),
      ...(sameModel
        ? summarizerApiKey === undefined ? {} : { apiKey: summarizerApiKey }
        : visionApiKeySetting.value === undefined
        ? {}
        : { apiKey: visionApiKeySetting.value }),
      ...(visionPricing === undefined ? {} : { pricing: visionPricing }),
    },
    sameModel,
  };
}

export function resolveAllowRemoteSummarization(override?: boolean): boolean {
  return booleanSetting(
    "ALLOW_REMOTE_SUMMARIZATION",
    "ALLOW_REMOTE_SUMMARIZATION",
    override,
    false,
  );
}

function xBrowserChannelSetting(
  override: XBrowserChannel | undefined,
): XBrowserChannel {
  const value = override ?? process.env["X_BROWSER_CHANNEL"] ??
    DEFAULT_X_BROWSER_CHANNEL;
  if (value !== "chromium" && value !== "chrome") {
    throw invalidConfig(
      "X_BROWSER_CHANNEL",
      'expected "chromium" or "chrome"',
    );
  }
  return value;
}

export function getXBrowserConfig(
  overrides: Partial<XBrowserConfig> = {},
): XBrowserConfig {
  return {
    profileRoot: requiredStringSetting(
      "X_BROWSER_PROFILE_ROOT",
      overrides.profileRoot,
      DEFAULT_X_BROWSER_PROFILE_ROOT,
    ),
    loginTimeoutMs: numberSetting(
      "X_BROWSER_LOGIN_TIMEOUT_MS",
      "X_BROWSER_LOGIN_TIMEOUT_MS",
      overrides.loginTimeoutMs,
      DEFAULT_X_BROWSER_LOGIN_TIMEOUT_MS,
    ),
    browserChannel: xBrowserChannelSetting(overrides.browserChannel),
  };
}

function originsSetting(override: string[] | undefined): string[] {
  if (override !== undefined) {
    if (
      !Array.isArray(override) ||
      override.some((origin) =>
        typeof origin !== "string" || origin.trim() === ""
      )
    ) {
      throw invalidConfig(
        "ALLOWED_ORIGINS",
        "expected a non-empty origin list",
      );
    }
    return override.map((origin) => origin.trim());
  }
  const raw = process.env["ALLOWED_ORIGINS"];
  if (raw === undefined) return [...DEFAULT_ALLOWED_ORIGINS];
  const origins = raw.split(",").map((origin) => origin.trim());
  if (origins.length === 0 || origins.some((origin) => origin === "")) {
    throw invalidConfig(
      "ALLOWED_ORIGINS",
      "expected a comma-separated origin list",
    );
  }
  return origins;
}


export function resolveServerHostname(override?: string): string {
  const serverHostname = override ?? process.env["SERVER_HOSTNAME"] ??
    DEFAULT_SERVER_HOSTNAME;
  const normalizedServerHostname = serverHostname.trim();
  if (normalizedServerHostname === "") {
    throw invalidConfig("SERVER_HOSTNAME", "expected a non-empty hostname");
  }
  return normalizedServerHostname;
}

export function getSummarizerBudgetConfig(
  overrides: Partial<SummarizerBudgetConfig> = {},
): SummarizerBudgetConfig {
  return {
    summarizerTextBytesPerChunk: budgetSetting(
      "SUMMARIZER_TEXT_BYTES_PER_CHUNK",
      overrides.summarizerTextBytesPerChunk,
      DEFAULT_SUMMARIZER_TEXT_BYTES_PER_CHUNK,
    ),
    summarizerMaxItemsPerChunk: budgetSetting(
      "SUMMARIZER_MAX_ITEMS_PER_CHUNK",
      overrides.summarizerMaxItemsPerChunk,
      DEFAULT_SUMMARIZER_MAX_ITEMS_PER_CHUNK,
    ),
    summarizerMaxImageBytes: budgetSetting(
      "SUMMARIZER_MAX_IMAGE_BYTES",
      overrides.summarizerMaxImageBytes,
      DEFAULT_SUMMARIZER_MAX_IMAGE_BYTES,
    ),
    analysisMaxItemsPerRequest: budgetSetting(
      "ANALYSIS_MAX_ITEMS_PER_REQUEST",
      overrides.analysisMaxItemsPerRequest,
      DEFAULT_ANALYSIS_MAX_ITEMS_PER_REQUEST,
    ),
    classificationMaxItemsPerRequest: budgetSetting(
      "CLASSIFICATION_MAX_ITEMS_PER_REQUEST",
      overrides.classificationMaxItemsPerRequest,
      DEFAULT_CLASSIFICATION_MAX_ITEMS_PER_REQUEST,
    ),
    summaryBatchMaxStories: budgetSetting(
      "SUMMARY_BATCH_MAX_STORIES",
      overrides.summaryBatchMaxStories,
      DEFAULT_SUMMARY_BATCH_MAX_STORIES,
    ),
    analysisMaxOutputTokens: budgetSetting(
      "ANALYSIS_MAX_OUTPUT_TOKENS",
      overrides.analysisMaxOutputTokens,
      DEFAULT_ANALYSIS_MAX_OUTPUT_TOKENS,
    ),
    classificationMaxOutputTokens: budgetSetting(
      "CLASSIFICATION_MAX_OUTPUT_TOKENS",
      overrides.classificationMaxOutputTokens,
      DEFAULT_CLASSIFICATION_MAX_OUTPUT_TOKENS,
    ),
    summaryMaxOutputTokens: budgetSetting(
      "SUMMARY_MAX_OUTPUT_TOKENS",
      overrides.summaryMaxOutputTokens,
      DEFAULT_SUMMARY_MAX_OUTPUT_TOKENS,
    ),
    summaryBatchMaxOutputTokens: budgetSetting(
      "SUMMARY_BATCH_MAX_OUTPUT_TOKENS",
      overrides.summaryBatchMaxOutputTokens,
      DEFAULT_SUMMARY_BATCH_MAX_OUTPUT_TOKENS,
    ),
    mediaMaxOutputTokens: budgetSetting(
      "MEDIA_MAX_OUTPUT_TOKENS",
      overrides.mediaMaxOutputTokens,
      DEFAULT_MEDIA_MAX_OUTPUT_TOKENS,
    ),
    analysisMaxAttempts: budgetSetting(
      "ANALYSIS_MAX_ATTEMPTS",
      overrides.analysisMaxAttempts,
      DEFAULT_ANALYSIS_MAX_ATTEMPTS,
    ),
    classificationMaxAttempts: budgetSetting(
      "CLASSIFICATION_MAX_ATTEMPTS",
      overrides.classificationMaxAttempts,
      DEFAULT_CLASSIFICATION_MAX_ATTEMPTS,
    ),
    summaryMaxAttempts: budgetSetting(
      "SUMMARY_MAX_ATTEMPTS",
      overrides.summaryMaxAttempts,
      DEFAULT_SUMMARY_MAX_ATTEMPTS,
    ),
    mediaMaxAttempts: budgetSetting(
      "MEDIA_MAX_ATTEMPTS",
      overrides.mediaMaxAttempts,
      DEFAULT_MEDIA_MAX_ATTEMPTS,
    ),
  };
}

export function getConfig(overrides: Partial<Config> = {}): Config {
  const port = numberSetting("PORT", "PORT", overrides.port, DEFAULT_PORT);
  if (port > 65_535) throw invalidConfig("PORT", "expected a valid TCP port");
  const xBrowserConfig = getXBrowserConfig({
    profileRoot: overrides.xBrowserProfileRoot,
    loginTimeoutMs: overrides.xBrowserLoginTimeoutMs,
    browserChannel: overrides.xBrowserChannel,
  });
  return {
    databasePath: overrides.databasePath ?? process.env["DATABASE_PATH"] ??
      "./data/morning-post.sqlite",
    port,
    allowedOrigins: originsSetting(overrides.allowedOrigins),
    trustedProxyCount: numberSetting(
      "TRUSTED_PROXY_COUNT",
      "TRUSTED_PROXY_COUNT",
      overrides.trustedProxyCount,
      0,
      true,
    ),
    maxRequestBodyBytes: numberSetting(
      "MAX_REQUEST_BODY_BYTES",
      "MAX_REQUEST_BODY_BYTES",
      overrides.maxRequestBodyBytes,
      DEFAULT_MAX_REQUEST_BODY_BYTES,
    ),
    allowRemoteSummarization: booleanSetting(
      "ALLOW_REMOTE_SUMMARIZATION",
      "ALLOW_REMOTE_SUMMARIZATION",
      overrides.allowRemoteSummarization,
      false,
    ),
    connectorTimeoutMs: numberSetting(
      "CONNECTOR_TIMEOUT_MS",
      "CONNECTOR_TIMEOUT_MS",
      overrides.connectorTimeoutMs,
      DEFAULT_CONNECTOR_TIMEOUT_MS,
    ),
    ...getSummarizerBudgetConfig(overrides),
    summarizerTimeoutMs: numberSetting(
      "SUMMARIZER_TIMEOUT_MS",
      "SUMMARIZER_TIMEOUT_MS",
      overrides.summarizerTimeoutMs,
      DEFAULT_SUMMARIZER_TIMEOUT_MS,
    ),
    digestProgressLogging: booleanSetting(
      "DIGEST_PROGRESS_LOGGING",
      "DIGEST_PROGRESS_LOGGING",
      overrides.digestProgressLogging,
      false,
    ),
    summarizationConcurrency: numberSetting(
      "SUMMARIZATION_CONCURRENCY",
      "SUMMARIZATION_CONCURRENCY",
      overrides.summarizationConcurrency,
      DEFAULT_SUMMARIZATION_CONCURRENCY,
    ),
    mediaTtlMs: numberSetting(
      "MEDIA_TTL_MS",
      "MEDIA_TTL_MS",
      overrides.mediaTtlMs,
      DEFAULT_MEDIA_TTL_MS,
    ),
    mediaQuotaBytes: numberSetting(
      "MEDIA_QUOTA_BYTES",
      "MEDIA_QUOTA_BYTES",
      overrides.mediaQuotaBytes,
      DEFAULT_MEDIA_QUOTA_BYTES,
    ),
    digestRunStaleAfterMs: numberSetting(
      "DIGEST_RUN_STALE_AFTER_MS",
      "DIGEST_RUN_STALE_AFTER_MS",
      overrides.digestRunStaleAfterMs,
      DEFAULT_DIGEST_RUN_STALE_AFTER_MS,
    ),
    xBrowserProfileRoot: xBrowserConfig.profileRoot,
    xBrowserLoginTimeoutMs: xBrowserConfig.loginTimeoutMs,
    xBrowserChannel: xBrowserConfig.browserChannel,
  };
}

export function resolveAppSecurityOptions(
  overrides: Partial<Pick<Config, "allowedOrigins" | "maxRequestBodyBytes">> =
    {},
): AppSecurityOptions {
  const config = getConfig(overrides);
  return {
    allowedOrigins: config.allowedOrigins,
    maxRequestBodyBytes: config.maxRequestBodyBytes,
  };
}
