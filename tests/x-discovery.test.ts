import { test } from "bun:test";

import {
  canonicalTargetFromLink,
  cleanFeedName,
  discoveryStopError,
  mergeDiscoveredFeeds,
  toAvailableFeeds,
} from "../src/connectors/x/discovery.ts";
import type { XDomLink } from "../src/connectors/x/dom-extractors.ts";
import {
  assertEquals,
  assertStrictEquals,
} from "./assertions.ts";

test("rendered Chat conversation links enumerate canonical discussion feeds without group inference", () => {
  const links: XDomLink[] = [
    { href: "/i/chat/Team_chat-01", name: "Product Team Chat" },
    { href: "https://x.com/i/chat/1234567890?via=inbox", name: "Alice" },
    { href: "https://x.com/i/chat/9zz-abc#latest", name: "" },
    { href: "/i/chat/compose", name: "New Chat" },
    { href: "https://twitter.com/i/chat/elsewhere", name: "Other Origin" },
  ];

  assertEquals(toAvailableFeeds(links, "chat"), [
    { externalId: "x:chat:Team_chat-01", kind: "discussion", name: "Product Team Chat" },
    { externalId: "x:chat:1234567890", kind: "discussion", name: "Alice" },
    { externalId: "x:chat:9zz-abc", kind: "discussion", name: "Chat 9zz-abc" },
  ]);
});

test("rendered List links map to news feeds and cross-kind links are skipped", () => {
  const links: XDomLink[] = [
    { href: "/i/lists/42", name: "Morning Reads" },
    { href: "/i/chat/someone", name: "Alice" },
    { href: "https://x.com/i/lists/7?show=posts", name: "" },
  ];

  assertEquals(toAvailableFeeds(links, "list"), [
    { externalId: "x:list:42", kind: "news", name: "Morning Reads" },
    { externalId: "x:list:7", kind: "news", name: "List 7" },
  ]);
});

test("canonical link mapping accepts only same-origin supported paths", () => {
  assertEquals(canonicalTargetFromLink("/i/chat/opaque"), {
    kind: "chat",
    conversationId: "opaque",
  });
  assertEquals(canonicalTargetFromLink("https://x.com/i/chat/opaque?via=inbox"), {
    kind: "chat",
    conversationId: "opaque",
  });
  assertEquals(canonicalTargetFromLink("/i/chat/opaque#latest"), {
    kind: "chat",
    conversationId: "opaque",
  });
  assertEquals(canonicalTargetFromLink("https://x.com/i/lists/42"), {
    kind: "list",
    listId: "42",
  });
  assertEquals(canonicalTargetFromLink("https://x.com/home"), {
    kind: "following",
  });
});

test("canonical link mapping ignores control, cross-origin, and malformed links", () => {
  const rejected = [
    "/i/chat/opaque\u0000",
    "/i/chat/opaque\u0001trailing",
    "javascript:alert(1)",
    "https://twitter.com/i/chat/opaque",
    "https://x.com.evil.example/i/chat/opaque",
    "//evil.example/i/chat/opaque",
    "https://x.com:8443/i/chat/opaque",
    "/i/chat/opaque/extra",
    "/i/chat/",
    "/i/chat/opaque.name",
    "/i/chat/compose",
    "/i/chat/NeW",
    `/i/chat/${"a".repeat(129)}`,
    "",
    "not a url",
    "/i/lists/0",
    "/i/lists/01",
  ];

  for (const href of rejected) {
    assertStrictEquals(canonicalTargetFromLink(href), null, href);
  }
});

test("duplicate conversation links resolve to the best rendered name", () => {
  const links: XDomLink[] = [
    { href: "/i/chat/team", name: "" },
    { href: "https://x.com/i/chat/team?via=inbox", name: "Team Chat" },
    { href: "/i/chat/team#unread", name: "Team Chat Later" },
  ];

  assertEquals(mergeDiscoveredFeeds(toAvailableFeeds(links, "chat")), [
    { externalId: "x:chat:team", kind: "discussion", name: "Team Chat" },
  ]);
});

test("merged discovery orders Following first, lists before chats, then by name", () => {
  const feeds = mergeDiscoveredFeeds([
    { externalId: "x:chat:z", name: "Zulu Chat", kind: "discussion" },
    { externalId: "x:list:2", name: "List B", kind: "news" },
    { externalId: "x:following", name: "Following", kind: "news" },
    { externalId: "x:chat:z", name: "Chat z", kind: "discussion" },
    { externalId: "x:list:1", name: "List A", kind: "news" },
  ]);

  assertEquals(feeds.map((feed) => feed.externalId), [
    "x:following",
    "x:list:1",
    "x:list:2",
    "x:chat:z",
  ]);
  assertEquals(feeds[3], {
    externalId: "x:chat:z",
    kind: "discussion",
    name: "Zulu Chat",
  });
});

test("feed names strip control characters and collapse whitespace", () => {
  assertEquals(cleanFeedName("  Team\u0000\u0001Chat\n  DM  "), "Team Chat DM");
  assertStrictEquals(cleanFeedName("\u0000\u0000\n\t"), "");
  assertStrictEquals(cleanFeedName(`x${"y".repeat(200)}`).length, 160);
});

test("discovery fails closed on every non-proven scroll stop reason", () => {
  assertStrictEquals(discoveryStopError("condition"), null);
  assertStrictEquals(discoveryStopError("boundary"), null);
  for (const reason of ["max_rounds", "max_items", "no_progress"] as const) {
    const error = discoveryStopError(reason);
    assertStrictEquals(
      error?.message,
      "X feed discovery reached a safety limit before completion",
      reason,
    );
  }
});
