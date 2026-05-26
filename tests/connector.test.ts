import { assertEquals } from "jsr:@std/assert";
import {
  mergeAlbums,
  prependQuote,
} from "../src/connectors/telegram/message-utils.ts";
import type { ChannelMessage } from "../src/connectors/telegram/telegram-connector.types.ts";

const baseMessage = (): ChannelMessage => ({
  id: 1,
  date: new Date("2026-01-01T10:00:00Z"),
  text: "hello",
  views: null,
  author: null,
  groupedId: null,
  replyToMessageId: null,
});

// --- prependQuote ---

Deno.test("prependQuote — no matching quote returns text unchanged", () => {
  const map = new Map<number, string>();
  assertEquals(prependQuote("hello", 42, map), "hello");
});

Deno.test("prependQuote — null replyToMessageId returns text unchanged", () => {
  const map = new Map([[42, "quoted"]]);
  assertEquals(prependQuote("hello", null, map), "hello");
});

Deno.test("prependQuote — matching quote is prepended with tokens", () => {
  const map = new Map([[42, "original post"]]);
  const result = prependQuote("my reply", 42, map);
  assertEquals(result, "[QUOTED_MESSAGE]original post[/QUOTED_MESSAGE]\n\nmy reply");
});

// --- mergeAlbums ---

Deno.test("mergeAlbums — single message with no groupedId passes through", () => {
  const message = baseMessage();
  const result = mergeAlbums([message], new Map(), new Map());
  assertEquals(result.length, 1);
  assertEquals(result[0].text, "hello");
});

Deno.test("mergeAlbums — quote is prepended for non-album message", () => {
  const message: ChannelMessage = { ...baseMessage(), replyToMessageId: 99 };
  const quotedTextMap = new Map([[99, "the original"]]);
  const result = mergeAlbums([message], new Map(), quotedTextMap);
  assertEquals(result[0].text, "[QUOTED_MESSAGE]the original[/QUOTED_MESSAGE]\n\nhello");
});

Deno.test("mergeAlbums — album group is merged into one item", () => {
  const groupId = "g1";
  const photo1: ChannelMessage = {
    ...baseMessage(),
    id: 1,
    text: "caption",
    groupedId: groupId,
    media: { type: "photo", localPath: "media/1.jpg" },
  };
  const photo2: ChannelMessage = {
    ...baseMessage(),
    id: 2,
    text: "",
    groupedId: groupId,
    media: { type: "photo", localPath: "media/2.jpg" },
  };
  const albumGroups = new Map([[groupId, [photo1, photo2]]]);
  const result = mergeAlbums([photo1, photo2], albumGroups, new Map());

  assertEquals(result.length, 1);
  assertEquals(result[0].text, "caption");
  assertEquals(result[0].media, { type: "album", localPaths: ["media/1.jpg", "media/2.jpg"] });
});

Deno.test("mergeAlbums — album with single photo uses photo type not album", () => {
  const groupId = "g2";
  const photo: ChannelMessage = {
    ...baseMessage(),
    id: 3,
    text: "solo",
    groupedId: groupId,
    media: { type: "photo", localPath: "media/3.jpg" },
  };
  const albumGroups = new Map([[groupId, [photo]]]);
  const result = mergeAlbums([photo], albumGroups, new Map());

  assertEquals(result[0].media, { type: "photo", localPath: "media/3.jpg" });
});

Deno.test("mergeAlbums — each groupedId only emitted once", () => {
  const groupId = "g3";
  const message1: ChannelMessage = { ...baseMessage(), id: 4, groupedId: groupId };
  const message2: ChannelMessage = { ...baseMessage(), id: 5, groupedId: groupId };
  const albumGroups = new Map([[groupId, [message1, message2]]]);
  const result = mergeAlbums([message1, message2], albumGroups, new Map());

  assertEquals(result.length, 1);
});
