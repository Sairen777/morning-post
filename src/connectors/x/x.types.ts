import { z } from "zod";
import type { AvailableFeed } from "../connector.types.ts";

/** Credentials for the Twex API-backed X connector. `pin` is the XChat identity PIN. */
export interface XCredentials {
  apiKey: string;
  /** XChat auth token used only for the user-info endpoint. */
  authToken: string;
  /** Complete X `Cookie` header value used for XChat conversation and DM requests. */
  cookie: string;
  pin?: string;
  listQuery: string;
  xUserId: string;
  xUsername: string;
}

export type XTarget =
  | { kind: "list"; listId: string }
  | { kind: "chat"; conversationId: string };

export type XTargetKind = XTarget["kind"];

export const xReactionSchema = z.object({
  emoji: z.string(),
  count: z.number(),
  reactedByViewer: z.boolean(),
}).strict();

export type XReaction = z.infer<typeof xReactionSchema>;

const xRawItemBaseSchema = z.object({
  externalId: z.string(),
  platformId: z.string().nullable(),
  date: z.number(),
  text: z.string(),
  author: z.string().nullable(),
  url: z.string().nullable(),
}).strict();

export const xRawPostSchema = xRawItemBaseSchema.extend({
  kind: z.literal("post"),
  replyCount: z.number().nullable(),
  repostCount: z.number().nullable(),
  likeCount: z.number().nullable(),
  viewCount: z.number().nullable(),
}).strict();

export const xRawChatMessageSchema = xRawItemBaseSchema.extend({
  kind: z.literal("chat_message"),
  reactions: z.array(xReactionSchema),
}).strict();

export const xRawItemSchema = z.discriminatedUnion("kind", [
  xRawPostSchema,
  xRawChatMessageSchema,
]);

export type XRawPost = z.infer<typeof xRawPostSchema>;
export type XRawChatMessage = z.infer<typeof xRawChatMessageSchema>;
export type XRawItem = z.infer<typeof xRawItemSchema>;

export interface XRawFeedData {
  feed: AvailableFeed;
  target: XTarget;
  items: XRawItem[];
}

export type XConnectorRawData = Record<string, XRawFeedData>;

/** Official `UserInfo` shape (camelCase), trimmed to consumed fields. */
export interface TwexUserInfo {
  userId: string;
  username: string;
  name: string;
  description: string;
  location: string;
  followersCount: number;
  followingCount: number;
  statusesCount: number;
  mediaCount: number;
  profileImageUrlHttps: string;
  createdAt: string;
  verified: boolean;
  protected: boolean;
}

/** Official `ListModel` shape (snake_case). */
export interface TwexList {
  id: string;
  name: string;
  description: string;
  is_private: boolean;
  member_count: number;
  subscriber_count: number;
}

export type TwexConversationType = "direct" | "group";

/** Official `ConversationV3Model` shape (snake_case). */
export interface TwexConversation {
  conversation_id: string;
  type: TwexConversationType;
  is_muted: boolean;
  participants: string[];
}
