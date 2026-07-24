import type { ModelEndpointConfig } from "../config.ts";
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
  constructor(readonly status: number, message: string) {
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
}

export interface ModelAttemptTelemetry {
  attempt: number;
  durationMs: number;
  status: "success" | "retry" | "failure";
  usage?: ModelAttemptUsage;
}

export type ModelAttemptTelemetryCallback = (
  telemetry: ModelAttemptTelemetry,
) => Promise<void> | void;

export interface CompletionOptions {
  signal?: AbortSignal;
  requestTimeoutMs?: number;
  onAttempt?: ModelAttemptTelemetryCallback;
}

interface RequestDeadline {
  signal?: AbortSignal;
  dispose: () => void;
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
  return {
    promptTokens: values[0] as number,
    completionTokens: values[1] as number,
    totalTokens: values[2] as number,
  };
}

function reportAttempt(
  callback: ModelAttemptTelemetryCallback | undefined,
  telemetry: ModelAttemptTelemetry,
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
    const body = JSON.stringify({
      model: this.endpoint.model,
      stream: false,
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content },
      ],
    });

    const maximumAttempts = 3;
    let lastError: unknown;
    for (let attempt = 0; attempt < maximumAttempts; attempt++) {
      const attemptStartedAt = Date.now();
      options.signal?.throwIfAborted();

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
          reportAttempt(options.onAttempt, {
            attempt: attempt + 1,
            durationMs,
            status: "failure",
          });
          throw abortReason(options.signal);
        }
        const internalTimeout = deadline.signal?.aborted &&
          deadline.signal.reason instanceof DOMException &&
          deadline.signal.reason.name === "TimeoutError";
        const retryable = internalTimeout || requestError instanceof TypeError;
        const willRetry = retryable && attempt < maximumAttempts - 1;
        reportAttempt(options.onAttempt, {
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
        reportAttempt(options.onAttempt, {
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
        const message = firstChoice !== null &&
            typeof firstChoice === "object" &&
            !Array.isArray(firstChoice)
          ? (firstChoice as Record<string, unknown>).message
          : undefined;
        const result = message !== null && typeof message === "object" &&
            !Array.isArray(message)
          ? (message as Record<string, unknown>).content
          : undefined;
        if (typeof result !== "string") {
          reportAttempt(options.onAttempt, {
            attempt: attempt + 1,
            durationMs,
            status: "failure",
            usage: parseUsage(responseData),
          });
          throw new ModelApiError(0, "Model API: malformed completion");
        }
        reportAttempt(options.onAttempt, {
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
      reportAttempt(options.onAttempt, {
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
