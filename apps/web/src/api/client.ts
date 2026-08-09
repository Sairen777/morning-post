import type {
  ApiErrorBody,
  AvailableFeed,
  CursorPage,
  DigestRunDetail,
  DigestSort,
  DigestView,
  DisconnectSourceResponse,
  FeedKind,
  PublicDigest,
  PublicDigestRun,
  PublicFeed,
  PublicInterestRule,
  PublicSource,
  PublicUser,
  SetupStatus,
  RelevanceFilterMode,
  RelevanceFilterOverride,
  StoryDetailLevel,
  SummarizationMode,
  SubstackPublicationInput,
  SubstackPublicationResponse,
  SubstackSessionInput,
  SubstackSessionResponse,
  StoryFeedbackInput,
  StoryFeedbackResponse,
  TelegramLoginSessionStatus,
  TelegramLoginStart,
  XLoginStartResponse,
  XLoginStatusResponse,
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

export function getSetupStatus(): Promise<SetupStatus> {
  return apiRequest<SetupStatus>("/auth/setup");
}

export function setupOwner(input: {
  name: string;
}): Promise<PublicUser> {
  return apiRequest<PublicUser>("/auth/setup", {
    method: "POST",
    body: JSON.stringify(input),
  });
}

export function loginUser(input: {
  password?: string;
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
  summaryPrompt?: string;
  defaultLanguage?: string | null;
  defaultRelevanceFilterMode?: RelevanceFilterMode;
  storyDetailLevel?: StoryDetailLevel;
  relevanceThreshold?: number;
  maximumStoriesPerDigest?: number | null;
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

export function regenerateTelegramLogin(
  loginSessionId: string,
): Promise<TelegramLoginStart> {
  return apiRequest<TelegramLoginStart>(
    `/connectors/telegram/login/${encodeURIComponent(loginSessionId)}/regenerate`,
    { method: "POST" },
  );
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
// X browser login
export function startXLogin(): Promise<XLoginStartResponse> {
  return apiRequest<XLoginStartResponse>("/connectors/x/login", {
    method: "POST",
  });
}

export function getXLoginStatus(
  sessionId: string,
): Promise<XLoginStatusResponse> {
  return apiRequest<XLoginStatusResponse>(
    `/connectors/x/login/${encodeURIComponent(sessionId)}`,
  );
}

export function verifyXLogin(
  sessionId: string,
): Promise<XLoginStatusResponse> {
  return apiRequest<XLoginStatusResponse>(
    `/connectors/x/login/${encodeURIComponent(sessionId)}/verify`,
    { method: "POST" },
  );
}

export function cancelXLogin(sessionId: string): Promise<void> {
  return apiRequest<void>(
    `/connectors/x/login/${encodeURIComponent(sessionId)}`,
    { method: "DELETE" },
  );
}

export function addXTarget(input: {
  sourceId: string;
  url: string;
}): Promise<PublicFeed> {
  return apiRequest<PublicFeed>("/connectors/x/targets", {
    method: "POST",
    body: JSON.stringify(input),
  });
}


// Substack
export function connectSubstackSession(
  input: SubstackSessionInput,
): Promise<SubstackSessionResponse> {
  return apiRequest<SubstackSessionResponse>("/connectors/substack/session", {
    method: "POST",
    body: JSON.stringify(input),
  });
}

export function addSubstackPublication(
  input: SubstackPublicationInput,
): Promise<SubstackPublicationResponse> {
  return apiRequest<SubstackPublicationResponse>(
    "/connectors/substack/publications",
    {
      method: "POST",
      body: JSON.stringify(input),
    },
  );
}
export function listSubstackPublications(): Promise<AvailableFeed[]> {
  return apiRequest<AvailableFeed[]>("/connectors/substack/publications");
}

// Sources
export function listSources(): Promise<PublicSource[]> {
  return apiRequest<PublicSource[]>("/sources");
}

export function updateSource(
  id: string,
  input: {
    enabled?: boolean;
    position?: number | null;
    showPaidPostTitles?: boolean;
    relevanceFilterMode?: RelevanceFilterOverride;
  },
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
// Interests
export function listInterests(): Promise<PublicInterestRule[]> {
  return apiRequest<PublicInterestRule[]>("/interests");
}

export function createInterest(input: {
  label: string;
  kind: PublicInterestRule["kind"];
  disposition: PublicInterestRule["disposition"];
  strength?: number;
  expiresAt?: number | null;
}): Promise<PublicInterestRule> {
  return apiRequest<PublicInterestRule>("/interests", {
    method: "POST",
    body: JSON.stringify(input),
  });
}

export function updateInterest(
  id: string,
  input: Partial<{
    label: string;
    kind: PublicInterestRule["kind"];
    disposition: PublicInterestRule["disposition"];
    strength: number;
    expiresAt: number | null;
  }>,
): Promise<PublicInterestRule> {
  return apiRequest<PublicInterestRule>(`/interests/${id}`, {
    method: "PATCH",
    body: JSON.stringify(input),
  });
}

export function deleteInterest(id: string): Promise<PublicInterestRule> {
  return apiRequest<PublicInterestRule>(`/interests/${id}`, {
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
    relevanceFilterMode?: RelevanceFilterOverride;
    summarizationMode?: SummarizationMode;
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
    summarizationMode?: SummarizationMode;
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
  /** Defaults to `requested_desc` (newest-requested first) on the server. */
  sort?: DigestSort;
}

export function listDigests(
  params?: DigestListParams,
): Promise<CursorPage<PublicDigest>> {
  const qs = params
    ? "?" + new URLSearchParams(
      Object.fromEntries(
        Object.entries(params).filter(([_, v]) => v !== undefined).map((
          [k, v],
        ) => [k, String(v)]),
      ),
    ).toString()
    : "";
  return apiRequest<CursorPage<PublicDigest>>(`/digests${qs}`);
}

/** Absolute API path for an item's media attached to a digest. */
export function digestItemMediaUrl(digestId: string, itemId: string): string {
  return `/digests/${encodeURIComponent(digestId)}/items/${encodeURIComponent(itemId)}/media`;
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

export function submitStoryFeedback(
  storyId: string,
  input: StoryFeedbackInput,
): Promise<StoryFeedbackResponse> {
  return apiRequest<StoryFeedbackResponse>(
    `/stories/${encodeURIComponent(storyId)}/feedback`,
    {
      method: "POST",
      body: JSON.stringify(input),
    },
  );
}

// Digest runs
export interface DigestRunListParams {
  cursor?: string;
  limit?: number;
}

export function listDigestRuns(
  params?: DigestRunListParams,
): Promise<CursorPage<PublicDigestRun>> {
  const qs = params
    ? "?" + new URLSearchParams(
      Object.fromEntries(
        Object.entries(params).filter(([_, v]) => v !== undefined).map((
          [k, v],
        ) => [k, String(v)]),
      ),
    ).toString()
    : "";
  return apiRequest<CursorPage<PublicDigestRun>>(`/digests/runs${qs}`);
}

export function getDigestRunDetail(id: string): Promise<DigestRunDetail> {
  return apiRequest<DigestRunDetail>(`/digests/runs/${id}`);
}
