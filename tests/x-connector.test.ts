import { test } from "bun:test";

import type { XBrowserSessions } from "../src/connectors/x/browser-session.ts";
import { XConnector } from "../src/connectors/x/x-connector.ts";
import type {
  XConnectorRawData,
  XRawChatMessage,
  XRawPost,
} from "../src/connectors/x/x.types.ts";
import { ConnectorId } from "../src/constants.ts";
import { assertEquals } from "./assertions.ts";

const FROM = 1_700_000_000_000;
const TO = 1_700_000_010_000;
const PROFILE_ID = "123e4567-e89b-42d3-a456-426614174000";
const CHAT_FEED_ID = "x:chat:team-chat";
const POSTS_FEED_ID = "x:following";
const LIST_FEED_ID = "x:list:123456789";

function chatMessage(
  externalId: string,
  date: number,
  reactions: XRawChatMessage["reactions"] = [],
): XRawChatMessage {
  return {
    kind: "chat_message",
    externalId,
    platformId: externalId,
    date,
    text: `chat ${externalId}`,
    author: "Chat Author",
    url: "https://x.com/i/chat/team-chat",
    reactions,
  };
}

function post(
  externalId: string,
  date: number,
  metrics: Pick<
    XRawPost,
    "replyCount" | "repostCount" | "likeCount" | "viewCount"
  > = {
    replyCount: null,
    repostCount: null,
    likeCount: null,
    viewCount: null,
  },
): XRawPost {
  return {
    kind: "post",
    externalId,
    platformId: externalId,
    date,
    text: `post ${externalId}`,
    author: "Post Author",
    url: `https://x.com/post-author/status/${externalId}`,
    ...metrics,
  };
}

interface RawDataCall {
  from: number;
  to: number;
  feedExternalIds: string[] | undefined;
  signal: AbortSignal | undefined;
}

class RawDataXConnector extends XConnector {
  public readonly calls: RawDataCall[] = [];

  constructor(private readonly rawData: XConnectorRawData) {
    super({} as XBrowserSessions, PROFILE_ID);
  }

  public override getRawData(
    from: number,
    to: number,
    feedExternalIds?: string[],
    signal?: AbortSignal,
  ): Promise<XConnectorRawData> {
    this.calls.push({ from, to, feedExternalIds, signal });
    return Promise.resolve(this.rawData);
  }
}

test("XConnector normalizes chat reactions and post metrics within an inclusive time window", async () => {
  const reactions = [
    { emoji: "like", count: 2, reactedByViewer: false },
    { emoji: "party", count: 3, reactedByViewer: true },
  ];
  const rawData: XConnectorRawData = {
    [CHAT_FEED_ID]: {
      feed: { externalId: CHAT_FEED_ID, name: "Team Chat", kind: "discussion" },
      target: { kind: "chat", conversationId: "team-chat" },
      items: [
        chatMessage("chat-before", FROM - 1),
        chatMessage("chat-at-start", FROM, reactions),
        chatMessage("chat-at-end", TO),
        chatMessage("chat-after", TO + 1),
      ],
    },
    [POSTS_FEED_ID]: {
      feed: { externalId: POSTS_FEED_ID, name: "Following", kind: "news" },
      target: { kind: "following" },
      items: [
        post("post-before", FROM - 1),
        post("post-at-start", FROM, {
          replyCount: 0,
          repostCount: 2,
          likeCount: 3,
          viewCount: 4,
        }),
        post("post-at-end", TO),
        post("post-after", TO + 1),
      ],
    },
  };
  const connector = new RawDataXConnector(rawData);
  const selectedFeeds = [CHAT_FEED_ID, POSTS_FEED_ID];

  const result = await connector.getNormalizedData(FROM, TO, selectedFeeds);

  assertEquals(connector.calls, [{
    from: FROM,
    to: TO,
    feedExternalIds: selectedFeeds,
    signal: undefined,
  }]);
  assertEquals(result, {
    [CHAT_FEED_ID]: [
      {
        connectorId: ConnectorId.X,
        feedExternalId: CHAT_FEED_ID,
        externalId: "chat-at-start",
        date: FROM,
        title: null,
        text: "chat chat-at-start",
        author: "Chat Author",
        url: "https://x.com/i/chat/team-chat",
        meta: {
          messageKind: "chat",
          authorKind: "sender",
          reactions,
          reactionCount: 5,
          reactedByViewer: true,
        },
      },
      {
        connectorId: ConnectorId.X,
        feedExternalId: CHAT_FEED_ID,
        externalId: "chat-at-end",
        date: TO,
        title: null,
        text: "chat chat-at-end",
        author: "Chat Author",
        url: "https://x.com/i/chat/team-chat",
        meta: {
          messageKind: "chat",
          authorKind: "sender",
          reactions: [],
          reactionCount: 0,
          reactedByViewer: false,
        },
      },
    ],
    [POSTS_FEED_ID]: [
      {
        connectorId: ConnectorId.X,
        feedExternalId: POSTS_FEED_ID,
        externalId: "post-at-start",
        date: FROM,
        title: null,
        text: "post post-at-start",
        author: "Post Author",
        url: "https://x.com/post-author/status/post-at-start",
        meta: {
          messageKind: "post",
          metrics: {
            replies: 0,
            reposts: 2,
            likes: 3,
            views: 4,
          },
        },
      },
      {
        connectorId: ConnectorId.X,
        feedExternalId: POSTS_FEED_ID,
        externalId: "post-at-end",
        date: TO,
        title: null,
        text: "post post-at-end",
        author: "Post Author",
        url: "https://x.com/post-author/status/post-at-end",
        meta: {
          messageKind: "post",
        },
      },
    ],
  });
});

test("XConnector normalizes an x:list feed as posts, preserving date, author, URL, and metrics", async () => {
  const rawData: XConnectorRawData = {
    [LIST_FEED_ID]: {
      feed: { externalId: LIST_FEED_ID, name: "Design Picks", kind: "news" },
      target: { kind: "list", listId: "123456789" },
      items: [
        post("list-post-before", FROM - 1),
        post("list-post-in-window", FROM, {
          replyCount: 1,
          repostCount: 2,
          likeCount: 3,
          viewCount: 4,
        }),
        post("list-post-after", TO + 1),
      ],
    },
  };
  const connector = new RawDataXConnector(rawData);

  const result = await connector.getNormalizedData(FROM, TO, [LIST_FEED_ID]);

  assertEquals(connector.calls, [{
    from: FROM,
    to: TO,
    feedExternalIds: [LIST_FEED_ID],
    signal: undefined,
  }]);
  assertEquals(result, {
    [LIST_FEED_ID]: [
      {
        connectorId: ConnectorId.X,
        feedExternalId: LIST_FEED_ID,
        externalId: "list-post-in-window",
        date: FROM,
        title: null,
        text: "post list-post-in-window",
        author: "Post Author",
        url: "https://x.com/post-author/status/list-post-in-window",
        meta: {
          messageKind: "post",
          metrics: {
            replies: 1,
            reposts: 2,
            likes: 3,
            views: 4,
          },
        },
      },
    ],
  });
});

test("XConnector distinguishes the viewer from a sender whose visible name is You", async () => {
  const sender = { ...chatMessage("sender-you", FROM), author: "You" };
  const viewer = {
    ...chatMessage("viewer-you", FROM + 1),
    author: "You",
    viewerAuthored: true as const,
  };
  const connector = new RawDataXConnector({
    [CHAT_FEED_ID]: {
      feed: { externalId: CHAT_FEED_ID, name: "Team Chat", kind: "discussion" },
      target: { kind: "chat", conversationId: "team-chat" },
      items: [sender, viewer],
    },
  });

  const result = await connector.getNormalizedData(FROM, TO, [CHAT_FEED_ID]);

  assertEquals(
    result[CHAT_FEED_ID].map((message) => ({
      author: message.author,
      authorKind: message.meta?.authorKind,
    })),
    [
      { author: "You", authorKind: "sender" },
      { author: "You", authorKind: "viewer" },
    ],
  );
});
