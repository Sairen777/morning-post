import type { AvailableFeed } from "../connector.types.ts";
import type { XChromeProcessLauncher } from "./chrome-process.ts";

export type XLoginState = "awaiting_login" | "awaiting_chat_unlock" | "complete";

export type XTarget =
  | { kind: "following" }
  | { kind: "list"; listId: string }
  | { kind: "chat"; conversationId: string };

export type XTargetKind = XTarget["kind"];

export type XBrowserChannel = "chromium" | "chrome";


export interface XBrowserRuntimeOptions {
  profileRoot: string;
  leaseTimeoutMs?: number;
  browserChannel?: XBrowserChannel;
  chromeExecutable?: string;
  chromeProcessLauncher?: XChromeProcessLauncher;
}

export interface XHeadedLoginHandle {
  verify(signal?: AbortSignal): Promise<XLoginState>;
  close(): Promise<void>;
}

export interface XReaction {
  emoji: string;
  count: number;
  reactedByViewer: boolean;
}

interface XRawItemBase {
  externalId: string;
  platformId: string | null;
  date: number;
  text: string;
  author: string | null;
  url: string | null;
}

export interface XRawPost extends XRawItemBase {
  kind: "post";
  replyCount: number | null;
  repostCount: number | null;
  likeCount: number | null;
  viewCount: number | null;
}

export interface XRawChatMessage extends XRawItemBase {
  kind: "chat_message";
  reactions: XReaction[];
  /** Trusted geometry-derived discriminator for the viewer's own messages. */
  viewerAuthored?: true;
}

export type XRawItem = XRawPost | XRawChatMessage;

export interface XRawFeedData {
  feed: AvailableFeed;
  target: XTarget;
  items: XRawItem[];
}

export type XConnectorRawData = Record<string, XRawFeedData>;
