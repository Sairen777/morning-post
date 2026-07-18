export type DatabaseSslMode = "disable" | "require" | "verify-full";

export interface ModelEndpointConfig {
  model: string;
  baseUrl: string;
  apiKey?: string;
}

export interface SummarizerRuntimeConfig {
  summarizer: ModelEndpointConfig;
  vision: ModelEndpointConfig;
  sameModel: boolean;
}

export interface SummarizerRuntimeConfigOverrides {
  summarizer?: Partial<ModelEndpointConfig>;
  vision?: Partial<ModelEndpointConfig>;
}

export interface Config {
  databaseUrl: string;
  port: number;
  allowedOrigins: string[];
  trustedProxyCount: number;
  maxRequestBodyBytes: number;
  databasePoolMax: number;
  databaseIdleTimeoutSeconds: number;
  databaseConnectTimeoutSeconds: number;
  databaseSslMode: DatabaseSslMode;
  allowRemoteSummarization: boolean;
  connectorTimeoutMs: number;
  summarizerTextBytesPerChunk: number;
  summarizerMaxItemsPerChunk: number;
  summarizerMaxImageBytes: number;
  summarizerTimeoutMs: number;
  summarizationConcurrency: number;
  mediaTtlMs: number;
  mediaQuotaBytes: number;
  digestRunStaleAfterMs: number;
  schedulerLeaseMs: number;
}

export interface AppSecurityOptions {
  allowedOrigins: string[];
  maxRequestBodyBytes: number;
}

const DEFAULT_ALLOWED_ORIGINS = ["http://127.0.0.1:5173", "http://localhost:5173"];
const DEFAULT_PORT = 3000;
const DEFAULT_SERVER_HOSTNAME = "127.0.0.1";
const DEFAULT_MAX_REQUEST_BODY_BYTES = 1_048_576;
const DEFAULT_DATABASE_POOL_MAX = 10;
const DEFAULT_DATABASE_IDLE_TIMEOUT_SECONDS = 20;
const DEFAULT_DATABASE_CONNECT_TIMEOUT_SECONDS = 30;
const DEFAULT_CONNECTOR_TIMEOUT_MS = 120_000;
const DEFAULT_SUMMARIZER_TEXT_BYTES_PER_CHUNK = 120_000;
const DEFAULT_SUMMARIZER_MAX_ITEMS_PER_CHUNK = 50;
const DEFAULT_SUMMARIZER_MAX_IMAGE_BYTES = 1_000_000;
const DEFAULT_SUMMARIZER_TIMEOUT_MS = 120_000;
const DEFAULT_SUMMARIZATION_CONCURRENCY = 2;
const DEFAULT_MEDIA_TTL_MS = 7 * 24 * 60 * 60 * 1_000;
const DEFAULT_MEDIA_QUOTA_BYTES = 500 * 1024 * 1024;
const DEFAULT_DIGEST_RUN_STALE_AFTER_MS = 15 * 60 * 1_000;
const DEFAULT_SCHEDULER_LEASE_MS = 90_000;
const DEFAULT_SUMMARIZER_MODEL = "local-model";
const DEFAULT_SUMMARIZER_BASE_URL = "http://127.0.0.1:1234/v1";

function invalidConfig(name: string, message: string): Error {
  return new Error(`Invalid ${name}: ${message}`);
}

function parsePositiveInteger(name: string, value: number | string): number {
  const parsed = typeof value === "number"
    ? value
    : value.trim() === "" ? Number.NaN : Number(value);
  if (!Number.isFinite(parsed) || !Number.isInteger(parsed) || parsed <= 0) {
    throw invalidConfig(name, "expected a positive integer");
  }
  return parsed;
}

function parseNonNegativeInteger(name: string, value: number | string): number {
  const parsed = typeof value === "number"
    ? value
    : value.trim() === "" ? Number.NaN : Number(value);
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
    return allowZero ? parseNonNegativeInteger(name, override) : parsePositiveInteger(name, override);
  }
  const raw = Deno.env.get(envName);
  if (raw === undefined) return fallback;
  return allowZero ? parseNonNegativeInteger(name, raw) : parsePositiveInteger(name, raw);
}

function booleanSetting(name: string, envName: string, override: boolean | undefined, fallback: boolean): boolean {
  if (override !== undefined) {
    if (typeof override !== "boolean") {
      throw invalidConfig(name, "expected true or false");
    }
    return override;
  }
  const raw = Deno.env.get(envName);
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
  const raw = override ?? Deno.env.get(name);
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
  const raw = override ?? Deno.env.get(name);
  const value = raw?.trim() ?? "";
  return {
    value: value === "" ? undefined : value,
    explicitlyConfigured: value !== "",
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
  const visionModel = requiredStringSetting("VISION_MODEL", overrides.vision?.model, summarizerModel);
  const visionBaseUrlSetting = optionalStringSetting("VISION_BASE_URL", overrides.vision?.baseUrl);
  const visionApiKeySetting = optionalStringSetting("VISION_API_KEY", overrides.vision?.apiKey);
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

  return {
    summarizer: {
      model: summarizerModel,
      baseUrl: summarizerBaseUrl,
      ...(summarizerApiKey === undefined ? {} : { apiKey: summarizerApiKey }),
    },
    vision: {
      model: visionModel,
      baseUrl: normalizeEndpointRoot(visionBaseUrlSetting.value ?? summarizerBaseUrl),
      ...(sameModel
        ? summarizerApiKey === undefined ? {} : { apiKey: summarizerApiKey }
        : visionApiKeySetting.value === undefined ? {} : { apiKey: visionApiKeySetting.value }),
    },
    sameModel,
  };
}

export function resolveAllowRemoteSummarization(override?: boolean): boolean {
  return booleanSetting("ALLOW_REMOTE_SUMMARIZATION", "ALLOW_REMOTE_SUMMARIZATION", override, false);
}

function originsSetting(override: string[] | undefined): string[] {
  if (override !== undefined) {
    if (!Array.isArray(override) || override.some((origin) => typeof origin !== "string" || origin.trim() === "")) {
      throw invalidConfig("ALLOWED_ORIGINS", "expected a non-empty origin list");
    }
    return override.map((origin) => origin.trim());
  }
  const raw = Deno.env.get("ALLOWED_ORIGINS");
  if (raw === undefined) return [...DEFAULT_ALLOWED_ORIGINS];
  const origins = raw.split(",").map((origin) => origin.trim());
  if (origins.length === 0 || origins.some((origin) => origin === "")) {
    throw invalidConfig("ALLOWED_ORIGINS", "expected a comma-separated origin list");
  }
  return origins;
}

function sslModeSetting(override: DatabaseSslMode | undefined): DatabaseSslMode {
  const raw = override ?? Deno.env.get("DB_SSL_MODE") ?? "disable";
  if (raw === "disable" || raw === "require" || raw === "verify-full") return raw;
  throw invalidConfig("DB_SSL_MODE", "expected disable, require, or verify-full");
}

export function resolveServerHostname(override?: string): string {
  const serverHostname = override ?? Deno.env.get("SERVER_HOSTNAME") ?? DEFAULT_SERVER_HOSTNAME;
  const normalizedServerHostname = serverHostname.trim();
  if (normalizedServerHostname === "") {
    throw invalidConfig("SERVER_HOSTNAME", "expected a non-empty hostname");
  }
  return normalizedServerHostname;
}

export function getConfig(overrides: Partial<Config> = {}): Config {
  const port = numberSetting("PORT", "PORT", overrides.port, DEFAULT_PORT);
  if (port > 65_535) throw invalidConfig("PORT", "expected a valid TCP port");
  return {
    databaseUrl: overrides.databaseUrl ?? Deno.env.get("DATABASE_URL") ?? "",
    port,
    allowedOrigins: originsSetting(overrides.allowedOrigins),
    trustedProxyCount: numberSetting("TRUSTED_PROXY_COUNT", "TRUSTED_PROXY_COUNT", overrides.trustedProxyCount, 0, true),
    maxRequestBodyBytes: numberSetting(
      "MAX_REQUEST_BODY_BYTES",
      "MAX_REQUEST_BODY_BYTES",
      overrides.maxRequestBodyBytes,
      DEFAULT_MAX_REQUEST_BODY_BYTES,
    ),
    databasePoolMax: numberSetting("DB_POOL_MAX", "DB_POOL_MAX", overrides.databasePoolMax, DEFAULT_DATABASE_POOL_MAX),
    databaseIdleTimeoutSeconds: numberSetting(
      "DB_IDLE_TIMEOUT_SECONDS",
      "DB_IDLE_TIMEOUT_SECONDS",
      overrides.databaseIdleTimeoutSeconds,
      DEFAULT_DATABASE_IDLE_TIMEOUT_SECONDS,
    ),
    databaseConnectTimeoutSeconds: numberSetting(
      "DB_CONNECT_TIMEOUT_SECONDS",
      "DB_CONNECT_TIMEOUT_SECONDS",
      overrides.databaseConnectTimeoutSeconds,
      DEFAULT_DATABASE_CONNECT_TIMEOUT_SECONDS,
    ),
    databaseSslMode: sslModeSetting(overrides.databaseSslMode),
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
    summarizerTextBytesPerChunk: numberSetting(
      "SUMMARIZER_TEXT_BYTES_PER_CHUNK",
      "SUMMARIZER_TEXT_BYTES_PER_CHUNK",
      overrides.summarizerTextBytesPerChunk,
      DEFAULT_SUMMARIZER_TEXT_BYTES_PER_CHUNK,
    ),
    summarizerMaxItemsPerChunk: numberSetting(
      "SUMMARIZER_MAX_ITEMS_PER_CHUNK",
      "SUMMARIZER_MAX_ITEMS_PER_CHUNK",
      overrides.summarizerMaxItemsPerChunk,
      DEFAULT_SUMMARIZER_MAX_ITEMS_PER_CHUNK,
    ),
    summarizerMaxImageBytes: numberSetting(
      "SUMMARIZER_MAX_IMAGE_BYTES",
      "SUMMARIZER_MAX_IMAGE_BYTES",
      overrides.summarizerMaxImageBytes,
      DEFAULT_SUMMARIZER_MAX_IMAGE_BYTES,
    ),
    summarizerTimeoutMs: numberSetting(
      "SUMMARIZER_TIMEOUT_MS",
      "SUMMARIZER_TIMEOUT_MS",
      overrides.summarizerTimeoutMs,
      DEFAULT_SUMMARIZER_TIMEOUT_MS,
    ),
    summarizationConcurrency: numberSetting(
      "SUMMARIZATION_CONCURRENCY",
      "SUMMARIZATION_CONCURRENCY",
      overrides.summarizationConcurrency,
      DEFAULT_SUMMARIZATION_CONCURRENCY,
    ),
    mediaTtlMs: numberSetting("MEDIA_TTL_MS", "MEDIA_TTL_MS", overrides.mediaTtlMs, DEFAULT_MEDIA_TTL_MS),
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
    schedulerLeaseMs: numberSetting(
      "SCHEDULER_LEASE_MS",
      "SCHEDULER_LEASE_MS",
      overrides.schedulerLeaseMs,
      DEFAULT_SCHEDULER_LEASE_MS,
    ),
  };
}

export function resolveAppSecurityOptions(
  overrides: Partial<Pick<Config, "allowedOrigins" | "maxRequestBodyBytes">> = {},
): AppSecurityOptions {
  const config = getConfig(overrides);
  return {
    allowedOrigins: config.allowedOrigins,
    maxRequestBodyBytes: config.maxRequestBodyBytes,
  };
}
