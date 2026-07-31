import type { XTarget } from "./x.types.ts";

export const X_ORIGIN = "https://x.com";

export const X_CONTROL_URLS = Object.freeze({
  home: `${X_ORIGIN}/home`,
  lists: `${X_ORIGIN}/i/lists`,
  messages: `${X_ORIGIN}/i/chat`,
});

const LIST_ID_PATTERN = "[1-9]\\d{0,31}";
const CONVERSATION_ID_PATTERN = "[A-Za-z0-9][A-Za-z0-9_-]{0,127}";
const TARGET_URL_PATTERN = new RegExp(
  `^https://x\\.com/(?:home|i/lists/(${LIST_ID_PATTERN})|i/chat/(${CONVERSATION_ID_PATTERN}))$`,
);
const FEED_ID_PATTERN = new RegExp(
  `^x:(?:following|list:(${LIST_ID_PATTERN})|chat:(${CONVERSATION_ID_PATTERN}))$`,
);
const LIST_ID = new RegExp(`^${LIST_ID_PATTERN}$`);
const CONVERSATION_ID = new RegExp(`^${CONVERSATION_ID_PATTERN}$`);
const RESERVED_CHAT_PATHS: Record<string, true> = {
  compose: true,
  new: true,
  requests: true,
  search: true,
  settings: true,
};

export function parseXTargetUrl(value: string): XTarget {
  if (typeof value !== "string") throw new Error("X target URL must be a string");
  const match = TARGET_URL_PATTERN.exec(value);
  if (!match || match[0] !== value) {
    throw new Error(
      "X target URL must be exactly https://x.com/home, https://x.com/i/lists/<numeric-id>, or https://x.com/i/chat/<conversation-id>",
    );
  }
  if (value === X_CONTROL_URLS.home) return { kind: "following" };
  if (match[1]) return { kind: "list", listId: match[1] };
  if (match[2]) {
    assertConversationId(match[2]);
    return { kind: "chat", conversationId: match[2] };
  }
  throw new Error("Invalid canonical X target URL");
}

export function parseXFeedExternalId(value: string): XTarget {
  if (typeof value !== "string") throw new Error("X feed external ID must be a string");
  const match = FEED_ID_PATTERN.exec(value);
  if (!match || match[0] !== value) {
    throw new Error(
      "X feed external ID must be x:following, x:list:<numeric-id>, or x:chat:<conversation-id>",
    );
  }
  if (value === "x:following") return { kind: "following" };
  if (match[1]) return { kind: "list", listId: match[1] };
  if (match[2]) {
    assertConversationId(match[2]);
    return { kind: "chat", conversationId: match[2] };
  }
  throw new Error("Invalid canonical X feed external ID");
}

export function formatXTargetUrl(target: XTarget): string {
  switch (target.kind) {
    case "following":
      return X_CONTROL_URLS.home;
    case "list":
      assertListId(target.listId);
      return `${X_ORIGIN}/i/lists/${target.listId}`;
    case "chat":
      assertConversationId(target.conversationId);
      return `${X_ORIGIN}/i/chat/${target.conversationId}`;
  }
}

export function formatXFeedExternalId(target: XTarget): string {
  switch (target.kind) {
    case "following":
      return "x:following";
    case "list":
      assertListId(target.listId);
      return `x:list:${target.listId}`;
    case "chat":
      assertConversationId(target.conversationId);
      return `x:chat:${target.conversationId}`;
  }
}

export function isExpectedTargetUrl(value: string, target: XTarget): boolean {
  return value === formatXTargetUrl(target);
}

export function assertXOrigin(value: string): void {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error("X navigation returned an invalid URL");
  }
  if (url.origin !== X_ORIGIN) {
    throw new Error("X navigation left the allowed origin");
  }
}

function assertListId(value: string): void {
  const match = LIST_ID.exec(value);
  if (!match || match[0] !== value) {
    throw new Error("X List ID must be a canonical positive decimal ID");
  }
}

function assertConversationId(value: string): void {
  const match = CONVERSATION_ID.exec(value);
  if (
    !match ||
    match[0] !== value ||
    RESERVED_CHAT_PATHS[value.toLowerCase()]
  ) {
    throw new Error("X Chat conversation ID contains unsupported characters or names a control page");
  }
}
