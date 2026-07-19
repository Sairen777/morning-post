import { readBoundedResponse } from "./publication-reader.ts";

const SUBSTACK_ORIGIN = "https://substack.com";
const MAX_RESPONSE_BYTES = 5 * 1024 * 1024;
const COOKIE_VALUE = /^[\x21\x23-\x2B\x2D-\x3A\x3C-\x5B\x5D-\x7E]+$/;

type FetchLike = (
  input: RequestInfo | URL,
  init?: RequestInit,
) => Promise<Response>;

export interface SubstackSessionCredentials {
  substackSessionId: string;
  connectSessionId?: string;
}

export interface SubstackPrivatePost {
  id: number;
  publicationId: number;
  bodyHtml: string | null;
}
export interface SubstackSubscriptionPublication {
  id: number;
  name: string | null;
  subdomain: string | null;
  customDomain: string | null;
}

export class SubstackSessionExpiredError extends Error {
  constructor() {
    super("Substack session expired; reconnect required");
    this.name = "SubstackSessionExpiredError";
  }
}

export class SubstackSessionUpstreamError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SubstackSessionUpstreamError";
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
    const substackSessionId = validateSessionCookieValue(
      credentials.substackSessionId,
    );
    const cookies = [`substack.sid=${substackSessionId}`];
    if (credentials.connectSessionId !== undefined) {
      cookies.push(
        `connect.sid=${
          validateSessionCookieValue(credentials.connectSessionId)
        }`,
      );
    }
    this.cookieHeader = cookies.join("; ");
  }

  public async validateSession(
    signal?: AbortSignal,
  ): Promise<{ userId: number }> {
    const value = await this.getJson("/api/v1/user-settings", signal);
    const userId = extractSubstackUserId(value);
    if (userId === null) {
      throw new SubstackSessionUpstreamError(
        "Substack returned an invalid response",
      );
    }
    return { userId };
  }

  public async listSubscribedPublications(
    signal?: AbortSignal,
  ): Promise<SubstackSubscriptionPublication[]> {
    const publications: SubstackSubscriptionPublication[] = [];
    const seenPublicationIds = new Set<number>();
    const seenCursors = new Set<string>();
    let cursor: string | undefined;
    do {
      const page = parseSubscriptionPage(
        await this.getJson(subscriptionPagePath(cursor), signal),
      );
      appendSubscribedPublications(page, publications, seenPublicationIds);
      cursor = page.nextCursor || undefined;
      if (cursor !== undefined && seenCursors.has(cursor)) {
        throw new SubstackSessionUpstreamError(
          "Substack returned a repeated pagination cursor",
        );
      }
      if (cursor !== undefined) seenCursors.add(cursor);
    } while (cursor !== undefined);
    return publications;
  }

  public async getPostById(
    postId: number,
    signal?: AbortSignal,
  ): Promise<SubstackPrivatePost | null> {
    if (!isPositiveInteger(postId)) {
      throw new Error("Substack post ID must be a positive integer");
    }
    const value = await this.getJson(
      `/api/v1/posts/by-id/${postId}`,
      signal,
      true,
    );
    if (value === null) return null;
    if (!isRecord(value) || !isRecord(value.post)) {
      throw new SubstackSessionUpstreamError(
        "Substack returned an invalid response",
      );
    }
    const post = value.post;
    if (
      !isPositiveInteger(post.id) ||
      !isPositiveInteger(post.publication_id) ||
      !(typeof post.body_html === "string" || post.body_html === null)
    ) {
      throw new SubstackSessionUpstreamError(
        "Substack returned an invalid response",
      );
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
    let response: Response;
    try {
      response = await this.fetcher(url, {
        method: "GET",
        redirect: "manual",
        signal,
        headers: {
          accept: "application/json",
          cookie: this.cookieHeader,
        },
      });
    } catch (error) {
      if (signal?.aborted) throw error;
      throw new SubstackSessionUpstreamError("Substack request failed");
    }
    if (response.status >= 300 && response.status < 400) {
      await response.body?.cancel().catch(() => undefined);
      throw new SubstackSessionUpstreamError(
        "Substack returned an unexpected redirect",
      );
    }
    if (response.status === 401) {
      await response.body?.cancel().catch(() => undefined);
      throw new SubstackSessionExpiredError();
    }
    if (
      allowUnavailable && (response.status === 403 || response.status === 404)
    ) {
      await response.body?.cancel().catch(() => undefined);
      return null;
    }
    if (!response.ok) {
      await response.body?.cancel().catch(() => undefined);
      throw new SubstackSessionUpstreamError(
        `Substack request failed with status ${response.status}`,
      );
    }
    let body: Uint8Array;
    try {
      body = await readBoundedResponse(
        response,
        MAX_RESPONSE_BYTES,
        signal,
      );
    } catch {
      if (signal?.aborted) throw signal.reason;
      throw new SubstackSessionUpstreamError(
        "Substack response body could not be read",
      );
    }
    try {
      return JSON.parse(new TextDecoder().decode(body));
    } catch {
      throw new SubstackSessionUpstreamError(
        "Substack returned an invalid response",
      );
    }
  }
}

interface SubscriptionPage {
  publications: unknown[];
  subscriptions: unknown[];
  nextCursor?: string;
}

function subscriptionPagePath(cursor?: string): string {
  const url = new URL("/api/v1/subscriptions/page_v2", SUBSTACK_ORIGIN);
  if (cursor !== undefined) url.searchParams.set("cursor", cursor);
  return `${url.pathname}${url.search}`;
}

function parseSubscriptionPage(value: unknown): SubscriptionPage {
  if (
    !isRecord(value) ||
    !Array.isArray(value.publications) ||
    !Array.isArray(value.subscriptions) ||
    !(value.nextCursor === undefined || typeof value.nextCursor === "string")
  ) {
    throw new SubstackSessionUpstreamError(
      "Substack returned an invalid response",
    );
  }
  return {
    publications: value.publications,
    subscriptions: value.subscriptions,
    nextCursor: value.nextCursor,
  };
}

function appendSubscribedPublications(
  page: SubscriptionPage,
  publications: SubstackSubscriptionPublication[],
  seenPublicationIds: Set<number>,
): void {
  const subscribedPublicationIds = new Set<number>();
  for (const subscription of page.subscriptions) {
    if (
      isRecord(subscription) && isPositiveInteger(subscription.publication_id)
    ) {
      subscribedPublicationIds.add(subscription.publication_id);
    }
  }
  for (const value of page.publications) {
    const publication = parseSubscriptionPublication(value);
    if (
      publication === null ||
      !subscribedPublicationIds.has(publication.id) ||
      seenPublicationIds.has(publication.id)
    ) {
      continue;
    }
    seenPublicationIds.add(publication.id);
    publications.push(publication);
  }
}

function parseSubscriptionPublication(
  value: unknown,
): SubstackSubscriptionPublication | null {
  if (
    !isRecord(value) ||
    !isPositiveInteger(value.id) ||
    !isNullableString(value.name) ||
    !isNullableString(value.subdomain) ||
    !isNullableString(value.custom_domain)
  ) {
    return null;
  }
  return {
    id: value.id,
    name: value.name,
    subdomain: value.subdomain,
    customDomain: value.custom_domain,
  };
}

function extractSubstackUserId(value: unknown): number | null {
  if (!isRecord(value)) return null;
  const userSettings = value.userSettings ?? value.user_settings;
  if (!Array.isArray(userSettings) || !isRecord(userSettings[0])) return null;
  return isPositiveInteger(userSettings[0].user_id)
    ? userSettings[0].user_id
    : null;
}

function isNullableString(value: unknown): value is string | null {
  return typeof value === "string" || value === null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function isPositiveInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}
