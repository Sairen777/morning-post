import { z } from "zod";
import { getTwexApiBaseUrl } from "../../config.ts";
import { throwIfAborted } from "./abort.ts";
import { X_ORIGIN } from "./targets.ts";
import type {
  TwexConversation,
  TwexList,
  TwexUserInfo,
  XCredentials,
  XRawChatMessage,
  XRawPost,
} from "./x.types.ts";

const DEFAULT_PIN = "1234";
const DM_HISTORY_PAGE_COUNT = 200;
const LIST_TWEETS_PAGE_LIMIT = 500;
const DM_HISTORY_PAGE_LIMIT = 500;

/** Error raised for any upstream failure: non-2xx HTTP, non-JSON body,
 * non-success envelope code, or a response that fails schema validation.
 * Aborts are re-thrown as their original AbortError, never wrapped. */
export class TwexApiError extends Error {
  constructor(
    message: string,
    readonly status?: number,
    readonly code?: number,
  ) {
    super(message);
    this.name = "TwexApiError";
  }
}

export interface XApiClient {
  getUserInfo(signal?: AbortSignal): Promise<TwexUserInfo>;
  searchLists(query: string, targetCount: number, signal?: AbortSignal): Promise<TwexList[]>;
  getConversations(signal?: AbortSignal): Promise<TwexConversation[]>;
  getListPosts(listId: string, from: number, to: number, signal?: AbortSignal): Promise<XRawPost[]>;
  getChatMessages(conversationId: string, from: number, to: number, signal?: AbortSignal): Promise<XRawChatMessage[]>;
}

export type TwexFetch = (
  input: RequestInfo | URL,
  init?: RequestInit,
) => Promise<Response>;

const twexUserInfoSchema = z.object({
  code: z.number(),
  msg: z.string(),
  data: z.object({
    userId: z.string(),
    username: z.string(),
    name: z.string(),
    description: z.string(),
    location: z.string(),
    profileImageUrlHttps: z.string(),
    createdAt: z.string(),
    verified: z.boolean(),
    protected: z.boolean(),
    isBlueVerified: z.boolean(),
    defaultProfile: z.boolean(),
    defaultProfileImage: z.boolean(),
    fastFollowersCount: z.number(),
    favouritesCount: z.number(),
    followersCount: z.number(),
    followingCount: z.number(),
    hasCustomTimelines: z.boolean(),
    isTranslator: z.boolean(),
    listedCount: z.number(),
    mediaCount: z.number(),
    normalFollowersCount: z.number(),
    possiblySensitive: z.boolean(),
    statusesCount: z.number(),
  }).nullable(),
});

const twexSearchListSchema = z.object({
  code: z.number(),
  msg: z.string(),
  data: z.array(z.object({
    id: z.string(),
    name: z.string(),
    description: z.string(),
    is_private: z.boolean(),
    member_count: z.number(),
    subscriber_count: z.number(),
  })),
});

const twexConversationsSchema = z.object({
  code: z.number(),
  msg: z.string(),
  data: z.array(z.object({
    conversation_id: z.string(),
    type: z.enum(["direct", "group"]),
    is_muted: z.boolean(),
    participants: z.array(z.string()),
  })),
});

const twexTweetUserSchema = z.object({
  id: z.string(),
  name: z.string(),
  screen_name: z.string(),
});

const twexTweetSchema = z.object({
  tweet_id: z.string(),
  text: z.string(),
  full_text: z.string().nullable().optional(),
  created_at_datetime: z.string().nullable().optional(),
  created_at: z.string().nullable().optional(),
  favorite_count: z.number().nullable().optional(),
  reply_count: z.number().nullable().optional(),
  retweet_count: z.number().nullable().optional(),
  view_count: z.string().nullable().optional(),
  user: twexTweetUserSchema.nullable().optional(),
});

const twexListTweetsPageSchema = z.object({
  code: z.number(),
  msg: z.string(),
  data: z.array(twexTweetSchema),
  has_next_page: z.boolean(),
  next_cursor: z.string().nullable().optional(),
});

const twexMessageSchema = z.object({
  id: z.string(),
  text: z.string(),
  time: z.string(),
  sequence_id: z.string().nullable().optional(),
  sender_id: z.string().nullable().optional(),
});

const twexDmHistorySchema = z.object({
  code: z.number(),
  msg: z.string(),
  data: z.object({
    conversation_id: z.string(),
    has_more: z.boolean(),
    messages: z.array(twexMessageSchema),
  }).nullable().optional(),
});

export class TwexApiClient implements XApiClient {
  readonly #apiKey: string;
  readonly #authToken: string;
  readonly #cookie: string;
  readonly #pin: string | undefined;
  readonly #baseUrl: string;
  readonly #fetch: TwexFetch;

  constructor(
    credentials: Pick<XCredentials, "apiKey" | "authToken" | "cookie" | "pin">,
    options: { baseUrl?: string; fetch?: TwexFetch } = {},
  ) {
    if (!credentials || typeof credentials !== "object") {
      throw new Error("Twex API credentials are required");
    }
    if (typeof credentials.apiKey !== "string" || credentials.apiKey.length === 0) {
      throw new Error("Twex API key is required");
    }
    if (typeof credentials.authToken !== "string" || credentials.authToken.length === 0) {
      throw new Error("Twex auth token is required");
    }
    if (typeof credentials.cookie !== "string" || credentials.cookie.length === 0) {
      throw new Error("Twex cookie is required");
    }
    this.#apiKey = credentials.apiKey;
    this.#authToken = credentials.authToken;
    this.#cookie = credentials.cookie;
    this.#pin = credentials.pin;
    this.#baseUrl = getTwexApiBaseUrl(options.baseUrl);
    this.#fetch = options.fetch ?? globalThis.fetch;
  }

  public async getUserInfo(signal?: AbortSignal): Promise<TwexUserInfo> {
    const path = `/twitter/${encodeURIComponent(this.#authToken)}/user_info`;
    const response = await this.request(
      "GET",
      path,
      twexUserInfoSchema,
      undefined,
      signal,
    );
    if (response.data === null) {
      throw new TwexApiError(
        "Twex API returned no user info for the auth token",
        undefined,
        response.code,
      );
    }
    return response.data;
  }

  public async searchLists(
    query: string,
    targetCount: number,
    signal?: AbortSignal,
  ): Promise<TwexList[]> {
    if (typeof query !== "string" || query.length === 0) {
      throw new Error("Twex list search requires a non-empty query");
    }
    if (!Number.isInteger(targetCount) || targetCount <= 0) {
      throw new Error("Twex list search requires a positive target count");
    }
    const response = await this.request(
      "POST",
      "/twitter/list/search",
      twexSearchListSchema,
      { query, target_count: targetCount },
      signal,
    );
    return response.data;
  }

  public async getConversations(signal?: AbortSignal): Promise<TwexConversation[]> {
    const response = await this.request(
      "POST",
      "/v3/twitter/conversations",
      twexConversationsSchema,
      { cookie: this.#cookie, count: 200, all: true },
      signal,
    );
    return response.data;
  }

  public async getListPosts(
    listId: string,
    from: number,
    to: number,
    signal?: AbortSignal,
  ): Promise<XRawPost[]> {
    validateWindow(from, to);
    const posts: XRawPost[] = [];
    const seenCursors = new Set<string>();
    let cursor: string | null = null;
    let pages = 0;

    for (;;) {
      throwIfAborted(signal);
      pages += 1;
      if (pages > LIST_TWEETS_PAGE_LIMIT) {
        throw new TwexApiError("Twex list tweet pagination exceeded the safety page limit");
      }
      if (cursor !== null) {
        if (seenCursors.has(cursor)) {
          throw new TwexApiError(
            "Twex list tweet pagination repeated a cursor; aborting to avoid a cycle",
          );
        }
        seenCursors.add(cursor);
      }

      const response: z.infer<typeof twexListTweetsPageSchema> = await this.request(
        "POST",
        "/twitter/list/tweets/page",
        twexListTweetsPageSchema,
        { list_id: listId, next_cursor: cursor },
        signal,
      );

      let reachedBoundary = false;
      for (const tweet of response.data) {
        const date = parseTweetDate(tweet);
        if (date === null) continue;
        if (date < from) {
          reachedBoundary = true;
          continue;
        }
        if (date > to) continue;
        posts.push(mapTweet(tweet, date));
      }
      if (reachedBoundary || !response.has_next_page) break;
      const nextCursor = response.next_cursor ?? null;
      if (nextCursor === null || nextCursor === "") {
        throw new TwexApiError(
          "Twex list tweets claimed another page but returned no cursor",
        );
      }
      cursor = nextCursor;
    }
    return posts;
  }

  public async getChatMessages(
    conversationId: string,
    from: number,
    to: number,
    signal?: AbortSignal,
  ): Promise<XRawChatMessage[]> {
    validateWindow(from, to);
    const messages: XRawChatMessage[] = [];
    const seenCursors = new Set<string>();
    let before: string | null = null;
    let pages = 0;

    for (;;) {
      throwIfAborted(signal);
      pages += 1;
      if (pages > DM_HISTORY_PAGE_LIMIT) {
        throw new TwexApiError("Twex DM history pagination exceeded the safety page limit");
      }
      if (before !== null) {
        if (seenCursors.has(before)) {
          throw new TwexApiError(
            "Twex DM history pagination repeated a sequence cursor; aborting to avoid a cycle",
          );
        }
        seenCursors.add(before);
      }

      const response: z.infer<typeof twexDmHistorySchema> = await this.request(
        "POST",
        "/v3/twitter/dm-history",
        twexDmHistorySchema,
        {
          recipient: conversationId,
          cookie: this.#cookie,
          pin: this.#pin ?? DEFAULT_PIN,
          count: DM_HISTORY_PAGE_COUNT,
          before,
        },
        signal,
      );

      const data = response.data;
      if (data === null || data === undefined) break;

      let reachedBoundary = false;
      let oldestSequenceId: string | null = null;
      let oldestSequenceDate = Number.POSITIVE_INFINITY;
      let lastSequenceId: string | null = null;
      for (const message of data.messages) {
        const date = Date.parse(message.time);
        if (Number.isFinite(date)) {
          if (date < from) {
            reachedBoundary = true;
          } else if (date <= to) {
            messages.push(mapMessage(message, date));
          }
        }
        if (message.sequence_id !== null && message.sequence_id !== undefined) {
          lastSequenceId = message.sequence_id;
          if (Number.isFinite(date) && date < oldestSequenceDate) {
            oldestSequenceDate = date;
            oldestSequenceId = message.sequence_id;
          }
        }
      }
      if (reachedBoundary || !data.has_more) break;
      const nextBefore = oldestSequenceId ?? lastSequenceId;
      if (nextBefore === null) {
        throw new TwexApiError(
          "Twex DM history claimed more messages but returned no sequence cursor",
        );
      }
      before = nextBefore;
    }
    return messages;
  }

  private async request<TEnvelope extends { code: number; msg: string }>(
    method: "GET" | "POST",
    path: string,
    schema: z.ZodType<TEnvelope>,
    body: Record<string, unknown> | undefined,
    signal?: AbortSignal,
  ): Promise<TEnvelope> {
    throwIfAborted(signal);
    let response: Response;
    try {
      response = await this.#fetch(`${this.#baseUrl}${path}`, {
        method,
        redirect: "error",
        headers: {
          Authorization: `Bearer ${this.#apiKey}`,
          ...(body === undefined ? {} : { "Content-Type": "application/json" }),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal,
      });
    } catch (error) {
      throwIfAborted(signal);
      if (isAbortError(error)) throw error;
      throw new TwexApiError(
        "Twex API request failed before receiving a response",
      );
    }
    throwIfAborted(signal);
    if (!response.ok) {
      throw new TwexApiError(
        `Twex API request failed with HTTP ${response.status}`,
        response.status,
      );
    }
    let json: unknown;
    try {
      json = await response.json();
    } catch (error) {
      throwIfAborted(signal);
      if (isAbortError(error)) throw error;
      throw new TwexApiError(
        "Twex API returned a non-JSON response",
        response.status,
      );
    }
    throwIfAborted(signal);
    const parsed = schema.safeParse(json);
    if (!parsed.success) {
      throw new TwexApiError(
        "Twex API response failed schema validation",
        response.status,
      );
    }
    if (parsed.data.code !== 200) {
      throw new TwexApiError(
        `Twex API returned envelope code ${parsed.data.code}`,
        response.status,
        parsed.data.code,
      );
    }
    return parsed.data;
  }
}

function isAbortError(error: unknown): error is Error {
  return error instanceof Error && error.name === "AbortError";
}

function validateWindow(from: number, to: number): void {
  if (!Number.isFinite(from) || !Number.isFinite(to) || from > to) {
    throw new Error(
      "Twex retrieval window must be finite epoch milliseconds with start <= end",
    );
  }
}

function parseTweetDate(
  tweet: { created_at_datetime?: string | null; created_at?: string | null },
): number | null {
  for (const candidate of [tweet.created_at_datetime, tweet.created_at]) {
    if (candidate === null || candidate === undefined) continue;
    const date = Date.parse(candidate);
    if (Number.isFinite(date)) return date;
  }
  return null;
}

function mapTweet(
  tweet: z.infer<typeof twexTweetSchema>,
  date: number,
): XRawPost {
  const screenName = tweet.user?.screen_name ?? null;
  const author = screenName ?? tweet.user?.name ?? tweet.user?.id ?? null;
  const url = screenName === null
    ? `${X_ORIGIN}/i/web/status/${tweet.tweet_id}`
    : `${X_ORIGIN}/${screenName}/status/${tweet.tweet_id}`;
  const rawViews = tweet.view_count ?? null;
  const viewCount = rawViews === null || !/^\d+$/.test(rawViews)
    ? null
    : Number(rawViews);
  return {
    kind: "post",
    externalId: tweet.tweet_id,
    platformId: tweet.user?.id ?? null,
    date,
    text: tweet.full_text ?? tweet.text,
    author,
    url,
    replyCount: tweet.reply_count ?? null,
    repostCount: tweet.retweet_count ?? null,
    likeCount: tweet.favorite_count ?? null,
    viewCount,
  };
}

function mapMessage(
  message: z.infer<typeof twexMessageSchema>,
  date: number,
): XRawChatMessage {
  return {
    kind: "chat_message",
    externalId: message.id,
    platformId: message.sender_id ?? null,
    date,
    text: message.text,
    author: message.sender_id ?? null,
    url: null,
    reactions: [],
  };
}
