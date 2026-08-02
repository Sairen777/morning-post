import { test } from "bun:test";

import {
  formatXFeedExternalId,
  parseXFeedExternalId,
} from "../src/connectors/x/targets.ts";
import { assertEquals, assertThrows } from "./assertions.ts";

test("parseXFeedExternalId accepts canonical list and chat ids", () => {
  assertEquals(
    parseXFeedExternalId("x:list:12345678901234567890123456789012"),
    { kind: "list", listId: "12345678901234567890123456789012" },
  );
  assertEquals(parseXFeedExternalId("x:list:1"), { kind: "list", listId: "1" });
  assertEquals(parseXFeedExternalId("x:chat:abc123"), {
    kind: "chat",
    conversationId: "abc123",
  });
  assertEquals(parseXFeedExternalId("x:chat:a.b:c_d-e"), {
    kind: "chat",
    conversationId: "a.b:c_d-e",
  });
});

test("parseXFeedExternalId rejects legacy, malformed, and out-of-shape ids", () => {
  for (const invalid of [
    "x:following",
    "x:lists:123",
    "x:list:0",
    "x:list:abc",
    "x:list:123 x",
    "x:list:123456789012345678901234567890123",
    "x:chat:",
    "x:chat:bad id!",
    "x:chat:bad#id",
    "",
    "list:123",
  ]) {
    assertThrows(
      () => parseXFeedExternalId(invalid),
      "must be x:list:<numeric-id> or x:chat:<conversation-id>",
      `feed id ${JSON.stringify(invalid)} must be rejected`,
    );
  }
  assertThrows(
    () => parseXFeedExternalId(42 as never),
    "must be a string",
  );
});

test("formatXFeedExternalId canonicalizes valid targets", () => {
  assertEquals(formatXFeedExternalId({ kind: "list", listId: "42" }), "x:list:42");
  assertEquals(formatXFeedExternalId({ kind: "chat", conversationId: "g1" }), "x:chat:g1");
});

test("formatXFeedExternalId rejects invalid list and conversation ids", () => {
  assertThrows(
    () => formatXFeedExternalId({ kind: "list", listId: "0" }),
    "canonical positive decimal",
  );
  assertThrows(
    () => formatXFeedExternalId({ kind: "list", listId: "abc" }),
    "canonical positive decimal",
  );
  assertThrows(
    () => formatXFeedExternalId({ kind: "chat", conversationId: "bad id!" }),
    "unsupported characters",
  );
  assertThrows(
    () => formatXFeedExternalId({ kind: "list", listId: "" }),
    "canonical positive decimal",
  );
});

test("parse and format round-trip canonical feed ids", () => {
  for (const id of ["x:list:1001", "x:chat:conv-g1", "x:chat:a.b:c_d-e"]) {
    assertEquals(formatXFeedExternalId(parseXFeedExternalId(id)), id);
  }
});
