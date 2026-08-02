import type { ModelEndpointConfig, ModelPricingSnapshot } from "../config.ts";
import type { ContentPart } from "./summarizer.types.ts";

/**
 * A callable fetch-compatible function. Intentionally narrower than
 * `typeof fetch` — exposes only the request/response contract, not
 * fetch-static properties (e.g. Bun's `preconnect`).
 */
export type FetchFunction = (
  input: RequestInfo | URL,
  init?: RequestInit,
) => Promise<Response>;

export class ModelApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly kind: "api" | "output_limit" = "api",
  ) {
    super(message);
    this.name = "ModelApiError";
  }
}

function isLoopbackUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    return parsed.hostname === "localhost" ||
      parsed.hostname === "127.0.0.1" ||
      parsed.hostname === "::1";
  } catch {
    return false;
  }
}

function abortReason(signal: AbortSignal): unknown {
  return signal.reason ?? new DOMException("Aborted", "AbortError");
}

function delay(milliseconds: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) {
    return Promise.reject(abortReason(signal));
  }
  return new Promise<void>((resolve, reject) => {
    const onAbort = () => {
      clearTimeout(timer);
      reject(abortReason(signal!));
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, milliseconds);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

export interface ModelAttemptUsage {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  promptCacheHitTokens?: number;
  promptCacheMissTokens?: number;
}

export interface ModelAttemptTelemetry {
  model?: string;
  attempt: number;
  durationMs: number;
  status: "success" | "retry" | "failure";
  usage?: ModelAttemptUsage;
  pricing?: ModelPricingSnapshot;
}

export type ModelAttemptTelemetryCallback = (
  telemetry: ModelAttemptTelemetry,
) => Promise<void> | void;

export interface CompletionOptions {
  signal?: AbortSignal;
  requestTimeoutMs?: number;
  onAttempt?: ModelAttemptTelemetryCallback;
  /**
   * Synchronous pre-flight gate invoked on every attempt, immediately after
   * the abort check and immediately before the deadline is set up and the
   * request is dispatched. A throw here aborts the request without any
   * outbound fetch (including transport and HTTP retries). Unlike onAttempt,
   * exceptions are never swallowed: the throw propagates to the caller.
   */
  beforeAttempt?: () => void;
  maxOutputTokens?: number;
  maxAttempts?: number;
  jsonOutput?: boolean;
}

interface RequestDeadline {
  signal?: AbortSignal;
  dispose: () => void;
}

function isConnectionResetError(error: unknown): boolean {
  if (typeof error !== "object" || error === null) return false;
  try {
    return "code" in error &&
      typeof error.code === "string" &&
      error.code === "ECONNRESET";
  } catch {
    return false;
  }
}

function createRequestDeadline(options: CompletionOptions): RequestDeadline {
  if (options.requestTimeoutMs === undefined) {
    return { signal: options.signal, dispose: () => {} };
  }
  if (
    !Number.isFinite(options.requestTimeoutMs) || options.requestTimeoutMs <= 0
  ) {
    throw new RangeError("Summarizer request timeout must be positive");
  }

  const controller = new AbortController();
  const onParentAbort = () => controller.abort(options.signal?.reason);
  if (options.signal?.aborted) {
    controller.abort(options.signal.reason);
  } else {
    options.signal?.addEventListener("abort", onParentAbort, { once: true });
  }
  const timer = setTimeout(
    () =>
      controller.abort(
        new DOMException("Summarizer timed out", "TimeoutError"),
      ),
    options.requestTimeoutMs,
  );

  return {
    signal: controller.signal,
    dispose: () => {
      clearTimeout(timer);
      options.signal?.removeEventListener("abort", onParentAbort);
    },
  };
}

function parseUsage(data: unknown): ModelAttemptUsage | undefined {
  if (data === null || typeof data !== "object") return undefined;
  const usage = (data as Record<string, unknown>).usage;
  if (usage === null || typeof usage !== "object") return undefined;
  const record = usage as Record<string, unknown>;
  const values = [
    record.prompt_tokens,
    record.completion_tokens,
    record.total_tokens,
  ];
  if (
    !values.every((value) =>
      typeof value === "number" && Number.isSafeInteger(value) && value >= 0
    ) ||
    values[2] !== (values[0] as number) + (values[1] as number)
  ) return undefined;
  const promptCacheHitTokens = record.prompt_cache_hit_tokens;
  const promptCacheMissTokens = record.prompt_cache_miss_tokens;
  const validOptionalTokenCount = (value: unknown) =>
    value === undefined ||
    (typeof value === "number" && Number.isSafeInteger(value) && value >= 0);
  if (
    !validOptionalTokenCount(promptCacheHitTokens) ||
    !validOptionalTokenCount(promptCacheMissTokens)
  ) return undefined;
  const promptTokens = values[0] as number;
  if (
    (typeof promptCacheHitTokens === "number" &&
      promptCacheHitTokens > promptTokens) ||
    (typeof promptCacheMissTokens === "number" &&
      promptCacheMissTokens > promptTokens) ||
    (typeof promptCacheHitTokens === "number" &&
      typeof promptCacheMissTokens === "number" &&
      promptCacheHitTokens + promptCacheMissTokens !== promptTokens)
  ) return undefined;
  return {
    promptTokens,
    completionTokens: values[1] as number,
    totalTokens: values[2] as number,
    ...(typeof promptCacheHitTokens === "number"
      ? { promptCacheHitTokens }
      : {}),
    ...(typeof promptCacheMissTokens === "number"
      ? { promptCacheMissTokens }
      : {}),
  };
}

function reportAttempt(
  callback:
    | ((telemetry: Omit<ModelAttemptTelemetry, "model" | "pricing">) => Promise<void> | void)
    | undefined,
  telemetry: Omit<ModelAttemptTelemetry, "model" | "pricing">,
): void {
  if (!callback) return;
  try {
    Promise.resolve(callback(telemetry)).catch(() => {});
  } catch {
    // Attempt telemetry is observational and must not affect requests.
  }
}

export class OpenAICompatibleChatClient {
  private readonly endpoint: ModelEndpointConfig;
  private readonly retryBaseDelayMs: number;
  private readonly _fetch: FetchFunction;

  constructor(
    endpoint: ModelEndpointConfig,
    options: { retryBaseDelayMs?: number; allowRemote?: boolean; fetch?: FetchFunction } = {},
  ) {
    const baseUrl = endpoint.baseUrl.replace(/\/+$/, "");
    const allowRemote = options.allowRemote ?? false;
    if (!isLoopbackUrl(baseUrl) && !allowRemote) {
      throw new Error(
        `Remote model base URL "${baseUrl}" requires ALLOW_REMOTE_SUMMARIZATION=true`,
      );
    }
    this.endpoint = { ...endpoint, baseUrl };
    this.retryBaseDelayMs = options.retryBaseDelayMs ?? 1000;
    this._fetch = options.fetch ?? globalThis.fetch;
  }
  public async complete(
    systemPrompt: string,
    content: ContentPart[] | string,
    options: CompletionOptions = {},
  ): Promise<string> {
    if (
      options.maxOutputTokens !== undefined &&
      (!Number.isSafeInteger(options.maxOutputTokens) ||
        options.maxOutputTokens <= 0)
    ) {
      throw new RangeError("Model output token limit must be a positive integer");
    }
    if (
      options.maxAttempts !== undefined &&
      (!Number.isSafeInteger(options.maxAttempts) || options.maxAttempts <= 0)
    ) {
      throw new RangeError("Model maximum attempts must be a positive integer");
    }
    const body = JSON.stringify({
      model: this.endpoint.model,
      stream: false,
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content },
      ],
      ...(options.maxOutputTokens === undefined
        ? {}
        : { max_tokens: options.maxOutputTokens }),
      ...(options.jsonOutput
        ? { response_format: { type: "json_object" } }
        : {}),
    });

    const maximumAttempts = options.maxAttempts ?? 3;
    const attemptCallback = options.onAttempt
      ? (telemetry: Omit<ModelAttemptTelemetry, "model" | "pricing">) =>
        options.onAttempt!({
          ...telemetry,
          model: this.endpoint.model,
          ...(this.endpoint.pricing === undefined
            ? {}
            : { pricing: { ...this.endpoint.pricing } }),
        })
      : undefined;
    let lastError: unknown;
    for (let attempt = 0; attempt < maximumAttempts; attempt++) {
      const attemptStartedAt = Date.now();
      options.signal?.throwIfAborted();
      options.beforeAttempt?.();

      const deadline = createRequestDeadline(options);
      let response: Response | undefined;
      let responseData: unknown;
      let requestError: unknown;
      try {
        response = await this._fetch(
          `${this.endpoint.baseUrl}/chat/completions`,
          {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              ...(this.endpoint.apiKey && {
                Authorization: `Bearer ${this.endpoint.apiKey}`,
              }),
            },
            body,
            signal: deadline.signal,
          },
        );
        if (response.ok) {
          responseData = await response.json();
        }
      } catch (error) {
        requestError = error;
      } finally {
        deadline.dispose();
      }

      const durationMs = Math.max(0, Date.now() - attemptStartedAt);
      if (requestError !== undefined) {
        if (options.signal?.aborted) {
          reportAttempt(attemptCallback, {
            attempt: attempt + 1,
            durationMs,
            status: "failure",
          });
          throw abortReason(options.signal);
        }
        const internalTimeout = deadline.signal?.aborted &&
          deadline.signal.reason instanceof DOMException &&
          deadline.signal.reason.name === "TimeoutError";
        const retryable = internalTimeout || requestError instanceof TypeError ||
          isConnectionResetError(requestError);
        const willRetry = retryable && attempt < maximumAttempts - 1;
        reportAttempt(attemptCallback, {
          attempt: attempt + 1,
          durationMs,
          status: willRetry ? "retry" : "failure",
        });
        if (!retryable) throw requestError;
        lastError = internalTimeout ? deadline.signal!.reason : requestError;
        if (!willRetry) throw lastError;
        await delay(this.retryDelayMilliseconds(attempt), options.signal);
        continue;
      }

      if (response === undefined) {
        reportAttempt(attemptCallback, {
          attempt: attempt + 1,
          durationMs,
          status: "failure",
        });
        throw new ModelApiError(0, "Model API: missing response");
      }
      if (response.ok) {
        const data = responseData !== null &&
            typeof responseData === "object" &&
            !Array.isArray(responseData)
          ? responseData as Record<string, unknown>
          : undefined;
        const choices = data?.choices;
        const firstChoice = Array.isArray(choices) ? choices[0] : undefined;
        const choice = firstChoice !== null &&
            typeof firstChoice === "object" &&
            !Array.isArray(firstChoice)
          ? firstChoice as Record<string, unknown>
          : undefined;
        const rawMessage = choice?.message;
        const message = rawMessage !== null && typeof rawMessage === "object" &&
            !Array.isArray(rawMessage)
          ? rawMessage as Record<string, unknown>
          : undefined;
        const result = message?.content;
        const rawFinishReason = choice?.finish_reason;
        const outputLimitExhausted = rawFinishReason === "length";
        if (
          outputLimitExhausted ||
          typeof result !== "string" ||
          result.trim() === ""
        ) {
          const finishReason = typeof rawFinishReason === "string"
            ? rawFinishReason.replace(/[^\p{L}\p{N}_-]+/gu, "").slice(0, 32) ||
              "unknown"
            : "unknown";
          const refusalPresent = typeof message?.refusal === "string" &&
            message.refusal.trim().length > 0;
          const toolCallCount = Array.isArray(message?.tool_calls)
            ? message.tool_calls.length
            : 0;
          const malformed = typeof result !== "string";
          const error = new ModelApiError(
            0,
            outputLimitExhausted
              ? `Model API exhausted output token limit (finish_reason=length, max_tokens=${options.maxOutputTokens ?? "provider-default"})`
              : malformed
              ? "Model API: malformed completion"
              : `Model API returned empty completion (finish_reason=${finishReason}, refusal=${refusalPresent}, tool_calls=${toolCallCount})`,
            outputLimitExhausted ? "output_limit" : "api",
          );
          const willRetry = !malformed && !outputLimitExhausted &&
            attempt < maximumAttempts - 1;
          const usage = parseUsage(responseData);
          reportAttempt(attemptCallback, {
            attempt: attempt + 1,
            durationMs,
            status: willRetry ? "retry" : "failure",
            usage,
          });
          lastError = error;
          if (!willRetry) throw error;
          await delay(this.retryDelayMilliseconds(attempt), options.signal);
          continue;
        }
        reportAttempt(attemptCallback, {
          attempt: attempt + 1,
          durationMs,
          status: "success",
          usage: parseUsage(responseData),
        });
        return result;
      }

      await this.cancelResponseBody(response);
      lastError = new ModelApiError(
        response.status,
        `Model API ${response.status}`,
      );

      const willRetry = (response.status === 429 || response.status === 503) &&
        attempt < maximumAttempts - 1;
      reportAttempt(attemptCallback, {
        attempt: attempt + 1,
        durationMs,
        status: willRetry ? "retry" : "failure",
      });
      if (
        (response.status === 429 || response.status === 503) &&
        attempt < maximumAttempts - 1
      ) {
        await delay(
          this.retryDelayMilliseconds(attempt, response),
          options.signal,
        );
        continue;
      }

      throw lastError;
    }

    throw lastError ??
      new ModelApiError(0, "Model API: unexpected retry exhaustion");
  }

  private retryDelayMilliseconds(attempt: number, response?: Response): number {
    const retryAfterHeader = response?.headers.get("Retry-After");
    if (retryAfterHeader) {
      const retryAfterSeconds = parseInt(retryAfterHeader, 10);
      if (!isNaN(retryAfterSeconds) && retryAfterSeconds > 0) {
        return Math.min(retryAfterSeconds * 1000, 30_000);
      }
    }
    return Math.pow(2, attempt) * this.retryBaseDelayMs;
  }

  private async cancelResponseBody(response: Response): Promise<void> {
    try {
      await response.body?.cancel();
    } catch {
      // Response status is sufficient for operational errors.
    }
  }
}
