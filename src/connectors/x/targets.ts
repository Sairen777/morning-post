import type { XTarget } from "./x.types.ts";

export const X_ORIGIN = "https://x.com";

const LIST_ID_PATTERN = "[1-9]\\d{0,31}";
const CONVERSATION_ID_PATTERN = "[A-Za-z0-9][A-Za-z0-9:._-]{0,255}";
const FEED_ID_PATTERN = new RegExp(
  `^x:(?:list:(${LIST_ID_PATTERN})|chat:(${CONVERSATION_ID_PATTERN}))$`,
);
const LIST_ID = new RegExp(`^${LIST_ID_PATTERN}$`);
const CONVERSATION_ID = new RegExp(`^${CONVERSATION_ID_PATTERN}$`);

export function parseXFeedExternalId(value: string): XTarget {
  if (typeof value !== "string") throw new Error("X feed external ID must be a string");
  const match = FEED_ID_PATTERN.exec(value);
  if (!match || match[0] !== value) {
    throw new Error(
      "X feed external ID must be x:list:<numeric-id> or x:chat:<conversation-id>",
    );
  }
  if (match[1]) return { kind: "list", listId: match[1] };
  assertConversationId(match[2]);
  return { kind: "chat", conversationId: match[2] };
}

export function formatXFeedExternalId(target: XTarget): string {
  switch (target.kind) {
    case "list":
      assertListId(target.listId);
      return `x:list:${target.listId}`;
    case "chat":
      assertConversationId(target.conversationId);
      return `x:chat:${target.conversationId}`;
    default:
      throw new Error(`Unsupported X target kind: ${JSON.stringify(target)}`);
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
  if (!match || match[0] !== value) {
    throw new Error("X Chat conversation ID contains unsupported characters");
  }
}
