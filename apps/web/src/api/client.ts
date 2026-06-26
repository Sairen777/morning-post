import type {
  ApiErrorBody,
  AvailableFeed,
  DigestView,
  FeedKind,
  PublicDigest,
  PublicFeed,
  PublicSource,
  PublicUser,
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

export function listFeeds(): Promise<PublicFeed[]> {
  return apiRequest<PublicFeed[]>("/feeds");
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

export function listDigests(): Promise<PublicDigest[]> {
  return apiRequest<PublicDigest[]>("/digests");
}

export function getDigest(id: string): Promise<DigestView> {
  return apiRequest<DigestView>(`/digests/${id}`);
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
