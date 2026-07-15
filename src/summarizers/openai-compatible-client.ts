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

function delay(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) {
    return Promise.reject(new DOMException("Aborted", "AbortError"));
  }
  return new Promise<void>((resolve, reject) => {
    const timer = setTimeout(resolve, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(new DOMException("Aborted", "AbortError"));
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
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
    signal?: AbortSignal,
  ): Promise<string> {
    const body = JSON.stringify({
      model: this.endpoint.model,
      stream: false,
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content },
      ],
    });

    const maxRetries = 3;
    let lastError: ModelApiError | null = null;
    for (let attempt = 0; attempt < maxRetries; attempt++) {
      if (signal?.aborted) {
        throw new DOMException("Aborted", "AbortError");
      }

      const response = await fetch(`${this.endpoint.baseUrl}/chat/completions`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(this.endpoint.apiKey && { Authorization: `Bearer ${this.endpoint.apiKey}` }),
        },
        body,
        signal,
      });

      if (response.ok) {
        const data = await response.json();
        return data.choices[0].message.content as string;
      }

      let responseBody = "";
      try {
        responseBody = await response.text();
      } catch {
        // The status is sufficient when the response body cannot be read.
      }
      lastError = new ModelApiError(
        response.status,
        `Model API ${response.status} — ${responseBody.slice(0, 300)}`,
      );

      if ((response.status === 429 || response.status === 503) && attempt < maxRetries - 1) {
        let retryAfterMs = Math.pow(2, attempt) * this.retryBaseDelayMs;
        const retryAfterHeader = response.headers.get("Retry-After");
        if (retryAfterHeader) {
          const parsed = parseInt(retryAfterHeader, 10);
          if (!isNaN(parsed) && parsed > 0) {
            retryAfterMs = Math.min(parsed * 1000, 30_000);
          }
        }
        await delay(retryAfterMs, signal);
        continue;
      }

      throw lastError;
    }

    throw lastError ?? new ModelApiError(0, "Model API: unexpected retry exhaustion");
  }
}
