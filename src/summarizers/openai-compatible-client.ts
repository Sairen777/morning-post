import type { ModelEndpointConfig } from "../config.ts";
import type { ContentPart } from "./summarizer.types.ts";

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

interface CompletionOptions {
  signal?: AbortSignal;
  requestTimeoutMs?: number;
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

export class OpenAICompatibleChatClient {
  private readonly endpoint: ModelEndpointConfig;
  private readonly retryBaseDelayMs: number;

  constructor(
    endpoint: ModelEndpointConfig,
    options: { retryBaseDelayMs?: number; allowRemote?: boolean } = {},
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
      options.signal?.throwIfAborted();

      const deadline = createRequestDeadline(options);
      let response: Response | undefined;
      let responseData: unknown;
      let requestError: unknown;
      try {
        response = await fetch(
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

      if (requestError !== undefined) {
        if (options.signal?.aborted) {
          throw abortReason(options.signal);
        }
        const internalTimeout = deadline.signal?.aborted &&
          deadline.signal.reason instanceof DOMException &&
          deadline.signal.reason.name === "TimeoutError";
        if (!internalTimeout && !(requestError instanceof TypeError)) {
          throw requestError;
        }
        lastError = internalTimeout ? deadline.signal!.reason : requestError;
        if (attempt === maximumAttempts - 1) {
          throw lastError;
        }
        await delay(this.retryDelayMilliseconds(attempt), options.signal);
        continue;
      }

      if (response === undefined) {
        throw new ModelApiError(0, "Model API: missing response");
      }
      if (response.ok) {
        const data = responseData as {
          choices: Array<{ message: { content: string } }>;
        };
        return data.choices[0].message.content;
      }

      await this.cancelResponseBody(response);
      lastError = new ModelApiError(
        response.status,
        `Model API ${response.status}`,
      );

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
