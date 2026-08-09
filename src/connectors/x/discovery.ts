import type { Page } from "playwright";

import type { AvailableFeed } from "../connector.types.ts";
import { navigateXControl } from "./browser-session.ts";
import { requireXAuthentication, requireXChatUnlocked } from "./connection-state.ts";
import { extractLinks } from "./dom-extractors.ts";
import type { XDomLink } from "./dom-extractors.ts";
import { X_DOM } from "./dom-selectors.ts";
import {
  formatXFeedExternalId,
  parseXTargetUrl,
  X_ORIGIN,
} from "./targets.ts";
import type { XTarget } from "./x.types.ts";
import { collectVirtualizedItems } from "./virtual-scroll.ts";

const MAX_DISCOVERY_ROUNDS = 32;
const MAX_DISCOVERED_LINKS = 250;

export async function discoverXFeedsOnPage(
  page: Page,
  signal?: AbortSignal,
): Promise<AvailableFeed[]> {
  const feeds: AvailableFeed[] = [{
    externalId: "x:following",
    name: "Following",
    kind: "news",
  }];

  await navigateXControl(page, "home", signal);
  await requireXAuthentication(page, signal);

  await navigateXControl(page, "lists", signal);
  await requireXAuthentication(page, signal);
  const listLinks = await collectDiscoveryLinks(page, X_DOM.listLink, signal);
  feeds.push(...toAvailableFeeds(listLinks, "list"));

  await navigateXControl(page, "messages", signal);
  await requireXAuthentication(page, signal);
  await requireXChatUnlocked(page, signal);
  const chatLinks = await collectDiscoveryLinks(page, X_DOM.conversationLink, signal);
  feeds.push(...toAvailableFeeds(chatLinks, "chat"));

  const byExternalId = new Map<string, AvailableFeed>();
  for (const feed of feeds) {
    const previous = byExternalId.get(feed.externalId);
    if (!previous || previous.name === fallbackNameForExternalId(previous.externalId)) {
      byExternalId.set(feed.externalId, feed);
    }
  }
  return Array.from(byExternalId.values()).sort((left, right) => {
    if (left.externalId === "x:following") return -1;
    if (right.externalId === "x:following") return 1;
    if (left.kind !== right.kind) return left.kind === "news" ? -1 : 1;
    return left.name.localeCompare(right.name) || left.externalId.localeCompare(right.externalId);
  });
}

async function collectDiscoveryLinks(
  page: Page,
  selector: string,
  signal?: AbortSignal,
): Promise<XDomLink[]> {
  const collection = await collectVirtualizedItems(page, {
    itemSelector: selector,
    direction: "down",
    extractRound: async () => await extractLinks(page, selector),
    identityOf: (link) => link.href,
    maxRounds: MAX_DISCOVERY_ROUNDS,
    maxItems: MAX_DISCOVERED_LINKS,
  }, signal);
  if (
    collection.stopReason === "max_items" ||
    collection.stopReason === "max_rounds"
  ) {
    throw new Error("X feed discovery reached a safety limit before completion");
  }
  return collection.items;
}

function toAvailableFeeds(
  links: XDomLink[],
  expectedKind: "list" | "chat",
): AvailableFeed[] {
  const feeds: AvailableFeed[] = [];
  for (const link of links) {
    const target = canonicalTargetFromLink(link.href);
    if (!target || target.kind !== expectedKind) continue;
    const externalId = formatXFeedExternalId(target);
    feeds.push({
      externalId,
      name: cleanFeedName(link.name) || fallbackName(target),
      kind: target.kind === "chat" ? "discussion" : "news",
    });
  }
  return feeds;
}

function canonicalTargetFromLink(href: string): XTarget | null {
  try {
    const url = new URL(href, X_ORIGIN);
    if (url.origin !== X_ORIGIN) return null;
    return parseXTargetUrl(`${url.origin}${url.pathname}`);
  } catch {
    return null;
  }
}

function cleanFeedName(value: string): string {
  return value.replace(/\s+/g, " ").trim().slice(0, 160);
}

function fallbackName(target: XTarget): string {
  switch (target.kind) {
    case "following":
      return "Following";
    case "list":
      return `List ${target.listId}`;
    case "chat":
      return `Chat ${target.conversationId}`;
  }
}

function fallbackNameForExternalId(externalId: string): string {
  if (externalId === "x:following") return "Following";
  const target = externalId.startsWith("x:list:")
    ? { kind: "list" as const, listId: externalId.slice("x:list:".length) }
    : { kind: "chat" as const, conversationId: externalId.slice("x:chat:".length) };
  return fallbackName(target);
}
