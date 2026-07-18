import { readBoundedResponse } from "./publication-reader.ts";

const SUBSTACK_ORIGIN = "https://substack.com";
const MAX_RESPONSE_BYTES = 5 * 1024 * 1024;
const COOKIE_VALUE = /^[\x21\x23-\x2B\x2D-\x3A\x3C-\x5B\x5D-\x7E]+$/;

type FetchLike = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

export interface SubstackSessionCredentials {
  substackSessionId: string;
  connectSessionId?: string;
}

export interface SubstackPrivatePost {
  id: number;
  publicationId: number;
  bodyHtml: string | null;
}

export class SubstackSessionExpiredError extends Error {
  constructor() {
    super("Substack session expired; reconnect required");
    this.name = "SubstackSessionExpiredError";
  }
}

export function validateSessionCookieValue(value: string): string {
  if (value.length < 1 || value.length > 4_096 || !COOKIE_VALUE.test(value)) {
    throw new Error("Substack session cookie value is invalid");
  }
  return value;
}

export class SubstackSessionClient {
  private readonly cookieHeader: string;

  constructor(
    credentials: SubstackSessionCredentials,
    private readonly fetcher: FetchLike = fetch,
  ) {
    const substackSessionId = validateSessionCookieValue(credentials.substackSessionId);
    const cookies = [`substack.sid=${substackSessionId}`];
    if (credentials.connectSessionId !== undefined) {
      cookies.push(`connect.sid=${validateSessionCookieValue(credentials.connectSessionId)}`);
    }
    this.cookieHeader = cookies.join("; ");
  }

  public async validateSession(signal?: AbortSignal): Promise<{ userId: number }> {
    const value = await this.getJson("/api/v1/user-settings", signal);
    if (!isRecord(value) || !isPositiveInteger(value.user_id)) {
      throw new Error("Substack returned an invalid response");
    }
    return { userId: value.user_id };
  }

  public async getPostById(
    postId: number,
    signal?: AbortSignal,
  ): Promise<SubstackPrivatePost | null> {
    if (!isPositiveInteger(postId)) {
      throw new Error("Substack post ID must be a positive integer");
    }
    const value = await this.getJson(`/api/v1/posts/by-id/${postId}`, signal, true);
    if (value === null) return null;
    if (!isRecord(value) || !isRecord(value.post)) {
      throw new Error("Substack returned an invalid response");
    }
    const post = value.post;
    if (
      !isPositiveInteger(post.id) ||
      !isPositiveInteger(post.publication_id) ||
      !(typeof post.body_html === "string" || post.body_html === null)
    ) {
      throw new Error("Substack returned an invalid response");
    }
    return {
      id: post.id,
      publicationId: post.publication_id,
      bodyHtml: post.body_html,
    };
  }

  private async getJson(
    path: string,
    signal?: AbortSignal,
    allowUnavailable = false,
  ): Promise<unknown | null> {
    const url = new URL(path, SUBSTACK_ORIGIN);
    if (url.origin !== SUBSTACK_ORIGIN) {
      throw new Error("Substack request origin is invalid");
    }
    const response = await this.fetcher(url, {
      method: "GET",
      redirect: "manual",
      signal,
      headers: {
        accept: "application/json",
        cookie: this.cookieHeader,
      },
    });
    if (response.status >= 300 && response.status < 400) {
      await response.body?.cancel().catch(() => undefined);
      throw new Error("Substack returned an unexpected redirect");
    }
    if (response.status === 401) {
      await response.body?.cancel().catch(() => undefined);
      throw new SubstackSessionExpiredError();
    }
    if (allowUnavailable && (response.status === 403 || response.status === 404)) {
      await response.body?.cancel().catch(() => undefined);
      return null;
    }
    if (!response.ok) {
      await response.body?.cancel().catch(() => undefined);
      throw new Error(`Substack request failed with status ${response.status}`);
    }
    const body = await readBoundedResponse(response, MAX_RESPONSE_BYTES, signal);
    try {
      return JSON.parse(new TextDecoder().decode(body));
    } catch {
      throw new Error("Substack returned an invalid response");
    }
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function isPositiveInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}
