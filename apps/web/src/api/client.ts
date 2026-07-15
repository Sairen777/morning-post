import type {
  ApiErrorBody,
  AvailableFeed,
  CursorPage,
  DigestRunDetail,
  DigestView,
  DisconnectSourceResponse,
  FeedKind,
  PublicDigest,
  PublicDigestRun,
  PublicFeed,
  PublicSource,
  PublicUser,
  TelegramLoginSessionStatus,
  TelegramLoginStart,
} from "./types.ts";

export class ApiClientError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
  ) {
    super(message);
    this.name = "ApiClientError";
  }
}

async function apiRequest<T>(path: string, options?: RequestInit): Promise<T> {
  const response = await fetch(path, {
    ...options,
    credentials: "include",
    headers: {
      ...(options?.body ? { "content-type": "application/json" } : {}),
      ...options?.headers,
    },
  });

  if (response.status === 204) {
    return undefined as T;
  }

  if (!response.ok) {
    let body: ApiErrorBody | undefined;
    try {
      body = await response.json();
    } catch {
      // ignore
    }
    throw new ApiClientError(
      response.status,
      body?.error?.code ?? "ERROR",
      body?.error?.message ?? `Request failed with status ${response.status}`,
    );
  }

  return response.json() as Promise<T>;
}

// Auth
export function getCurrentUser(): Promise<PublicUser> {
  return apiRequest<PublicUser>("/auth/me");
}

export function registerUser(input: {
  name: string;
  email: string;
  password: string;
}): Promise<PublicUser> {
  return apiRequest<PublicUser>("/auth/register", {
    method: "POST",
    body: JSON.stringify(input),
  });
}

export function loginUser(input: {
  email: string;
  password: string;
}): Promise<PublicUser> {
  return apiRequest<PublicUser>("/auth/login", {
    method: "POST",
    body: JSON.stringify(input),
  });
}

export function logoutUser(): Promise<void> {
  return apiRequest<void>("/auth/logout", { method: "POST" });
}

export function updateCurrentUser(input: {
  name?: string;
  systemPrompt?: string;
  defaultLanguage?: string | null;
}): Promise<PublicUser> {
  return apiRequest<PublicUser>("/auth/me", {
    method: "PATCH",
    body: JSON.stringify(input),
  });
}

// Telegram login
export function startTelegramLogin(): Promise<TelegramLoginStart> {
  return apiRequest<TelegramLoginStart>("/connectors/telegram/login", {
    method: "POST",
  });
}

export function getTelegramLoginStatus(
  loginSessionId: string,
): Promise<TelegramLoginSessionStatus> {
  return apiRequest<TelegramLoginSessionStatus>(
    `/connectors/telegram/login/${loginSessionId}`,
  );
}

export function submitTelegramTwoFactorAuthentication(
  loginSessionId: string,
  input: { password: string },
): Promise<TelegramLoginSessionStatus> {
  return apiRequest<TelegramLoginSessionStatus>(
    `/connectors/telegram/login/${loginSessionId}/2fa`,
    {
      method: "POST",
      body: JSON.stringify(input),
    },
  );
}

// Sources
export function listSources(): Promise<PublicSource[]> {
  return apiRequest<PublicSource[]>("/sources");
}

export function updateSource(
  id: string,
  input: { enabled?: boolean; position?: number | null },
): Promise<PublicSource> {
  return apiRequest<PublicSource>(`/sources/${id}`, {
    method: "PATCH",
    body: JSON.stringify(input),
  });
}

export function disconnectSource(
  id: string,
): Promise<DisconnectSourceResponse> {
  return apiRequest<DisconnectSourceResponse>(`/sources/${id}`, {
    method: "DELETE",
  });
}

// Feeds
export function listFeeds(): Promise<PublicFeed[]> {
  return apiRequest<PublicFeed[]>("/feeds");
}

export function listFeedsForSource(sourceId: string): Promise<PublicFeed[]> {
  return apiRequest<PublicFeed[]>(`/sources/${sourceId}/feeds`);
}

export function getFeed(id: string): Promise<PublicFeed> {
  return apiRequest<PublicFeed>(`/feeds/${id}`);
}

export function updateFeed(
  id: string,
  input: {
    kind?: FeedKind;
    customPrompt?: string | null;
    position?: number | null;
    enabled?: boolean;
  },
): Promise<PublicFeed> {
  return apiRequest<PublicFeed>(`/feeds/${id}`, {
    method: "PATCH",
    body: JSON.stringify(input),
  });
}

export function unsubscribeFeed(id: string): Promise<PublicFeed> {
  return apiRequest<PublicFeed>(`/feeds/${id}`, {
    method: "DELETE",
  });
}

export function listAvailableFeeds(sourceId: string): Promise<AvailableFeed[]> {
  return apiRequest<AvailableFeed[]>(`/sources/${sourceId}/available-feeds`);
}

export function subscribeFeed(
  sourceId: string,
  input: {
    externalId: string;
    name: string;
    kind: FeedKind;
    customPrompt?: string | null;
    position?: number | null;
  },
): Promise<PublicFeed> {
  return apiRequest<PublicFeed>(`/sources/${sourceId}/feeds`, {
    method: "POST",
    body: JSON.stringify(input),
  });
}

// Digests
export interface DigestListParams {
  cursor?: string;
  limit?: number;
}

export function listDigests(params?: DigestListParams): Promise<CursorPage<PublicDigest>> {
  const qs = params ? "?" + new URLSearchParams(
    Object.fromEntries(
      Object.entries(params).filter(([_, v]) => v !== undefined).map(([k, v]) => [k, String(v)]),
    ),
  ).toString() : "";
  return apiRequest<CursorPage<PublicDigest>>(`/digests${qs}`);
}

export function getDigest(id: string): Promise<DigestView> {
  return apiRequest<DigestView>(`/digests/${id}`);
}

export function deleteDigest(id: string): Promise<PublicDigest> {
  return apiRequest<PublicDigest>(`/digests/${id}`, { method: "DELETE" });
}

export function runDigest(input: {
  periodStartMs?: number;
  periodEndMs?: number;
}): Promise<DigestView> {
  return apiRequest<DigestView>("/digests/run", {
    method: "POST",
    body: JSON.stringify(input),
  });
}

// Digest runs
export function listDigestRuns(params?: DigestListParams): Promise<CursorPage<PublicDigestRun>> {
  const qs = params ? "?" + new URLSearchParams(
    Object.fromEntries(
      Object.entries(params).filter(([_, v]) => v !== undefined).map(([k, v]) => [k, String(v)]),
    ),
  ).toString() : "";
  return apiRequest<CursorPage<PublicDigestRun>>(`/digests/runs${qs}`);
}

export function getDigestRunDetail(id: string): Promise<DigestRunDetail> {
  return apiRequest<DigestRunDetail>(`/digests/runs/${id}`);
}
